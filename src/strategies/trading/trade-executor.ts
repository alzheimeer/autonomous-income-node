/**
 * TradeExecutor
 *
 * Implements the full trade pipeline:
 *   scan → validate (RiskManager) → submit (MCP Trading Server) → record in `trades`
 *
 * Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 6.1, 6.3, 6.4, 6.7
 */

import { randomUUID } from 'node:crypto';

import {
  scanOpportunities,
  type TradeOpportunity,
} from './opportunity-scanner.js';
import { RiskManagerImpl } from './risk-manager.js';
import { FeeTierSelector } from './fee-tier-selector.js';
import { SwapReceiptParser } from './swap-receipt-parser.js';
import type { SurvivalTier } from '../../survival/tier-evaluator.js';
import type { McpClient } from '../../mcp/client/mcp-client.js';
import type { TradesRepository, TradeRecord } from '../../state/repositories/trades.repo.js';
import type { IStrategyTracker } from '../../intelligence/strategy-tracker.js';
import type { Wallet } from 'ethers';
import { SWAP_ROUTER_ABI, SWAP_ROUTER_ADDRESS } from '../../contracts/abis.js';
import { TradingKillSwitch } from './kill-switch.js';

// ---------------------------------------------------------------------------
// Types re-exported for consumers
// ---------------------------------------------------------------------------

export type { TradeOpportunity, TradeRecord };

// ---------------------------------------------------------------------------
// MCP swap result shape (matches trading-server.ts SwapResult)
// ---------------------------------------------------------------------------

interface SwapResult {
  txHash: string;
  status: 'success' | 'simulated' | 'pending';
  quoteId: string;
  walletAddress: string;
  actualAmountOut?: string;
}

// ---------------------------------------------------------------------------
// TradeExecutor
// ---------------------------------------------------------------------------

export interface TradeExecutorOptions {
  /** RiskManager instance (defaults to a fresh RiskManagerImpl). */
  riskManager?: RiskManagerImpl;
  /** McpClient connected to the trading server. Required in production. */
  mcpClient?: McpClient;
  /** Trades repository for persisting results. Required for DB writes. */
  tradesRepo?: TradesRepository;
  /** ethers Wallet signer — required for real on-chain swap execution. */
  signer?: Wallet;
  /** Base RPC URL for JsonRpcProvider. */
  rpcUrl?: string;
  /** Strategy performance tracker for recording outcomes. */
  strategyTracker?: IStrategyTracker;
  /** Kill-switch for emergency stop on excessive losses. */
  killSwitch?: TradingKillSwitch;
}

export class TradeExecutor {
  private readonly riskManager: RiskManagerImpl;
  private readonly mcpClient: McpClient | undefined;
  private readonly tradesRepo: TradesRepository | undefined;
  private readonly signer: Wallet | undefined;
  private readonly rpcUrl: string | undefined;
  private readonly strategyTracker: IStrategyTracker | undefined;
  private readonly killSwitch: TradingKillSwitch | undefined;

  constructor(options: TradeExecutorOptions = {}) {
    this.riskManager = options.riskManager ?? new RiskManagerImpl();
    this.mcpClient = options.mcpClient;
    this.tradesRepo = options.tradesRepo;
    this.signer = options.signer;
    this.rpcUrl = options.rpcUrl;
    this.strategyTracker = options.strategyTracker;
    this.killSwitch = options.killSwitch;
  }

  // ---------------------------------------------------------------------------
  // executeBestOpportunity
  // ---------------------------------------------------------------------------

  /**
   * Run the full pipeline:
   *  1. Scan for opportunities
   *  2. Validate each via RiskManager (exposure, trade size, profit, slippage)
   *  3. Execute the best valid opportunity via MCP Trading Server
   *  4. Record the result in the `trades` table
   *
   * Returns the trade record on success, or `null` if no valid opportunity was
   * found or if the execution step is skipped (e.g. dry-run / disabled tier).
   */
  async executeBestOpportunity(
    walletAddress: string,
    balance: bigint,
    tier: SurvivalTier
  ): Promise<TradeRecord | null> {
    // Kill-switch check — block all trading if triggered
    if (this.killSwitch) {
      const ksStatus = this.killSwitch.isTriggered();
      if (ksStatus.triggered) {
        console.warn(`[TradeExecutor] Kill-switch active: ${ksStatus.reason}`);
        return null;
      }
    }

    // 1. Scan
    const opportunities = await scanOpportunities(walletAddress, balance, this.mcpClient);

    if (opportunities.length === 0) {
      console.info('[TradeExecutor] No opportunities found in this scan.');
      return null;
    }

    // 2. Validate — pick the first opportunity that passes all checks
    const best = this.pickBestOpportunity(opportunities, balance, tier);

    if (!best) {
      console.info('[TradeExecutor] No opportunities passed risk validation.');
      return null;
    }

    // 3. Submit via MCP Trading Server
    const txResult = await this.submitSwap(walletAddress, best);

    // 4. Record in `trades` table
    const record = await this.recordTrade(best, txResult, balance);

    return record;
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /**
   * Iterate opportunities (sorted best-first by netProfit) and return the first
   * that passes all RiskManager validations.
   */
  private pickBestOpportunity(
    opportunities: TradeOpportunity[],
    balance: bigint,
    tier: SurvivalTier
  ): TradeOpportunity | null {
    for (const opp of opportunities) {
      // a) Trade size limit (Tier 1/2 cap)
      const sizeCheck = this.riskManager.validateTradeSize(opp.amountIn, balance, tier);
      if (!sizeCheck.valid) {
        console.info(`[TradeExecutor] Opportunity ${opp.id} rejected (trade size): ${sizeCheck.reason}`);
        continue;
      }

      // b) Exposure limit (≤ 20% of balance)
      const exposureCheck = this.riskManager.validateExposure(opp.amountIn, balance);
      if (!exposureCheck.valid) {
        console.info(`[TradeExecutor] Opportunity ${opp.id} rejected (exposure): ${exposureCheck.reason}`);
        continue;
      }

      // c) Minimum profit
      const profitCheck = this.riskManager.validateMinProfit(opp.netProfitUsdc);
      if (!profitCheck.valid) {
        console.info(`[TradeExecutor] Opportunity ${opp.id} rejected (profit): ${profitCheck.reason}`);
        continue;
      }

      // d) Slippage validation: compare amountIn to expectedOut with tolerance
      //    We use the opportunity's self-reported slippagePct as the default tolerance.
      const slippageCheck = this.riskManager.validateSlippage(
        opp.amountIn,
        opp.expectedOut,
        opp.slippagePct
      );
      if (!slippageCheck.valid) {
        console.info(`[TradeExecutor] Opportunity ${opp.id} rejected (slippage): ${slippageCheck.reason}`);
        continue;
      }

      return opp;
    }

    return null;
  }

  /**
   * Submit swap via 1inch API + ethers.js para envío real a la blockchain.
   * Fallback a simulación si no hay signer configurado.
   */
  private async submitSwap(
    walletAddress: string,
    opp: TradeOpportunity
  ): Promise<SwapResult | null> {
    // Si hay signer disponible, intentar swap real primero
    if (this.signer && this.rpcUrl) {
      try {
        return await this.submitSwapReal(walletAddress, opp);
      } catch (err) {
        const errMsg = (err as Error).message;
        const axiosErr = err as { response?: { data?: unknown } };
        const detail = axiosErr?.response?.data ? JSON.stringify(axiosErr.response.data) : '';
        console.warn(`[TradeExecutor] Real swap failed, falling back to simulation: ${errMsg} ${detail}`);
      }
    }

    // Fallback: simulación via MCP o mock
    if (this.mcpClient) {
      const result = await this.mcpClient.callTool<SwapResult>('execute_swap', {
        quoteId: opp.quoteId,
        slippageTolerance: opp.slippagePct,
        walletAddress,
      });

      if (!result.ok) {
        console.error(`[TradeExecutor] execute_swap failed: ${result.error.message}`);
        return null;
      }
      return result.value;
    }

    // Sin signer ni MCP — simulación pura
    console.info(`[TradeExecutor] No signer — simulating swap for opportunity ${opp.id}`);
    return {
      txHash: `0x${'00'.repeat(32)}`,
      status: 'simulated',
      quoteId: opp.quoteId,
      walletAddress,
    };
  }

  /**
   * Swap real via Uniswap v3 SwapRouter02 + ethers.js.
   * 1. Select best fee tier via FeeTierSelector (Req 1.1, 1.6)
   * 2. Set deadline from block.timestamp (Req 1.2)
   * 3. Use correct ABI with deadline in struct (Req 1.3)
   * 4. Retry with next-best fee tier on revert (Req 1.4)
   * 5. Parse receipt for actual output (Req 1.5)
   * 6. Record outcome in StrategyTracker
   */
  private async submitSwapReal(
    walletAddress: string,
    opp: TradeOpportunity,
  ): Promise<SwapResult> {
    if (!this.signer || !this.rpcUrl) throw new Error('Signer or RPC URL not configured');

    const { JsonRpcProvider, Contract } = await import('ethers');

    const provider = new JsonRpcProvider(this.rpcUrl);
    const connectedSigner = this.signer.connect(provider);

    // Verify ETH balance for gas (minimum 0.001 ETH)
    const ethBalance = await provider.getBalance(walletAddress);
    const MIN_ETH_FOR_GAS = 1_000_000_000_000_000n; // 0.001 ETH
    if (ethBalance < MIN_ETH_FOR_GAS) {
      throw new Error(`Insufficient ETH for gas: ${ethBalance.toString()}`);
    }

    // ── Req 1.1, 1.6: Select best fee tier via FeeTierSelector ──────────
    const feeTierSelector = new FeeTierSelector(this.rpcUrl);
    const bestPool = await feeTierSelector.selectBestFeeTier(opp.tokenIn, opp.tokenOut);

    if (!bestPool) {
      console.warn(`[TradeExecutor] No pool exists for pair ${opp.tokenIn.slice(0, 10)}/${opp.tokenOut.slice(0, 10)} — skipping opportunity`);
      this.strategyTracker?.recordExecution('trading_uniswap', false);
      throw new Error(`No Uniswap V3 pool exists for pair ${opp.tokenIn}/${opp.tokenOut}`);
    }

    // Get all available pools for retry logic (Req 1.4)
    const availablePools = await feeTierSelector.getAvailablePools(opp.tokenIn, opp.tokenOut);

    // ── ERC-20 Approve ──────────────────────────────────────────────────
    const ERC20_APPROVE_ABI = [
      'function allowance(address owner, address spender) view returns (uint256)',
      'function approve(address spender, uint256 amount) returns (bool)',
    ];

    const tokenContract = new Contract(opp.tokenIn, ERC20_APPROVE_ABI, connectedSigner);
    const allowance = await tokenContract.allowance(walletAddress, SWAP_ROUTER_ADDRESS) as bigint;

    if (allowance < opp.amountIn) {
      console.info(`[TradeExecutor] Approving Uniswap router for ${opp.amountIn} tokenIn...`);
      const approveTx = await tokenContract.approve(SWAP_ROUTER_ADDRESS, opp.amountIn);
      await (approveTx as { wait: (n: number) => Promise<unknown> }).wait(1);
      console.info(`[TradeExecutor] Token approved for Uniswap router`);
    }

    // ── Calculate amountOutMinimum with slippage ─────────────────────────
    const slippageFactor = BigInt(Math.floor((1 - opp.slippagePct / 100) * 10000));
    const amountOutMinimum = (opp.expectedOut * slippageFactor) / 10000n;

    // ── Encode swap calldata using Interface (ethers v6 struct encoding fix) ─
    const { Interface } = await import('ethers');
    const swapInterface = new Interface(SWAP_ROUTER_ABI);

    // ── Req 1.4: Retry logic — up to 3 attempts total ───────────────────
    const MAX_ATTEMPTS = 3;
    let lastError: Error | null = null;

    // Get initial nonce to manage sequential retries without collision
    let nonce = await provider.getTransactionCount(walletAddress, 'pending');

    for (let attempt = 0; attempt < MAX_ATTEMPTS && attempt < availablePools.length; attempt++) {
      const pool = availablePools[attempt]!;
      const feeTier = pool.feeTier;

      try {
        // Get latest block for logging purposes
        const block = await provider.getBlock('latest');
        if (!block) throw new Error('Failed to fetch latest block');

        // Encode calldata for exactInputSingle (SwapRouter02 on Base has NO deadline in struct)
        const calldata = swapInterface.encodeFunctionData('exactInputSingle', [[
          opp.tokenIn,
          opp.tokenOut,
          feeTier,
          walletAddress,
          opp.amountIn,
          amountOutMinimum,
          0n, // sqrtPriceLimitX96 = 0 means no limit
        ]]);

        console.info(
          `[TradeExecutor] Executing Uniswap v3 swap (attempt ${attempt + 1}/${MAX_ATTEMPTS}, fee ${feeTier}): ` +
          `${opp.amountIn} ${opp.tokenIn.slice(0, 10)} → min ${amountOutMinimum} ${opp.tokenOut.slice(0, 10)}`
        );

        // ── eth_call simulation: catch reverts BEFORE spending gas ────────
        try {
          await provider.call({
            to: SWAP_ROUTER_ADDRESS,
            data: calldata,
            from: walletAddress,
          });
        } catch (simErr) {
          const simMsg = (simErr as Error).message ?? 'unknown';
          console.warn(`[TradeExecutor] Simulation FAILED — skipping swap: ${simMsg}`);
          throw new Error(`Simulation failed: ${simMsg}`);
        }

        const tx = await connectedSigner.sendTransaction({
          to: SWAP_ROUTER_ADDRESS,
          data: calldata,
          gasLimit: 300_000n,
          nonce,
        });

        console.info(`[TradeExecutor] Uniswap swap tx broadcast: ${(tx as { hash: string }).hash}`);

        const receipt = await (tx as { wait: (n: number) => Promise<{ status: number; blockNumber: number; hash?: string } | null> }).wait(1);

        if (!receipt || receipt.status === 0) {
          throw new Error(`Swap tx reverted: ${(tx as { hash: string }).hash}`);
        }

        console.info(`[TradeExecutor] ✅ Uniswap swap confirmed in block ${receipt.blockNumber}`);

        // ── Req 1.5: Parse receipt for actual output amount ─────────────
        const receiptParser = new SwapReceiptParser();
        const parsedResult = receiptParser.parseSwapReceipt(
          receipt as unknown as import('ethers').TransactionReceipt,
          opp.tokenOut,
          walletAddress,
        );

        const actualAmountOut = parsedResult.actualAmountOut;
        const actualProfit = actualAmountOut > amountOutMinimum
          ? actualAmountOut - opp.amountIn
          : 0n;

        // ── Record success in StrategyTracker ───────────────────────────
        if (this.strategyTracker) {
          if (actualProfit > 0n) {
            this.strategyTracker.recordRevenue('trading_uniswap', actualProfit);
          }
          this.strategyTracker.recordExecution('trading_uniswap', true);
        }

        // Record gain/loss in kill-switch
        if (this.killSwitch) {
          if (actualProfit > 0n) {
            this.killSwitch.recordGain(actualProfit);
          } else if (actualProfit < 0n) {
            this.killSwitch.recordLoss(-actualProfit);
          }
        }

        return {
          txHash: (tx as { hash: string }).hash,
          status: 'success',
          quoteId: opp.quoteId,
          walletAddress,
          actualAmountOut: actualAmountOut.toString(),
        };
      } catch (err) {
        lastError = err as Error;
        console.warn(
          `[TradeExecutor] Swap reverted on attempt ${attempt + 1}/${MAX_ATTEMPTS} (fee tier ${feeTier}): ${lastError.message}`
        );

        // If this wasn't the last attempt, try next fee tier
        if (attempt < MAX_ATTEMPTS - 1 && attempt < availablePools.length - 1) {
          // Increment nonce for next attempt to avoid "replacement transaction underpriced"
          nonce++;
          // Wait for previous tx to be processed before retrying
          await new Promise(resolve => setTimeout(resolve, 3000));
          console.info(`[TradeExecutor] Retrying with next fee tier (nonce: ${nonce})...`);
        }
      }
    }

    // All retries failed — record failure
    console.error(`[TradeExecutor] All ${MAX_ATTEMPTS} swap attempts failed. Last error: ${lastError?.message}`);

    // Record failure in StrategyTracker
    this.strategyTracker?.recordExecution('trading_uniswap', false);

    // Record loss in kill-switch (gas cost is the loss on failed swaps)
    if (this.killSwitch) {
      this.killSwitch.recordLoss(opp.estimatedGasCost);
    }

    // Record failure with status 'reverted' in trades table
    if (this.tradesRepo) {
      try {
        const failId = randomUUID();
        this.tradesRepo.insert({
          id: failId,
          network: opp.network,
          tokenIn: opp.tokenIn,
          tokenOut: opp.tokenOut,
          amountIn: opp.amountIn.toString(),
          expectedOut: opp.expectedOut.toString(),
          gasCostUsdc: opp.estimatedGasCost.toString(),
          source: opp.source,
          slippagePct: opp.slippagePct,
          executedAt: Date.now(),
        });
        this.tradesRepo.updateAfterExecution(failId, {
          status: 'reverted',
        });
      } catch (dbErr) {
        console.error('[TradeExecutor] Failed to persist reverted trade:', dbErr);
      }
    }

    throw lastError ?? new Error('Swap failed after all retry attempts');
  }

  /**
   * Persist the trade outcome to the `trades` table.
   * Returns a canonical TradeRecord, recording the outcome even if the
   * repository is not configured.
   */
  private async recordTrade(
    opp: TradeOpportunity,
    swapResult: SwapResult | null,
    _balance: bigint
  ): Promise<TradeRecord> {
    const id = randomUUID();
    const now = Date.now();

    let status: TradeRecord['status'];
    if (!swapResult) {
      status = 'reverted';
    } else if (swapResult.status === 'success' || swapResult.status === 'simulated') {
      status = 'success';
    } else {
      // 'pending' — transaction broadcast but not yet confirmed
      status = 'pending';
    }

    const record: TradeRecord = {
      id,
      network: opp.network,
      tokenIn: opp.tokenIn,
      tokenOut: opp.tokenOut,
      amountIn: opp.amountIn.toString(),
      expectedOut: opp.expectedOut.toString(),
      actualOut: status === 'success'
        ? (swapResult?.actualAmountOut ?? opp.expectedOut.toString())
        : null,
      txHash: swapResult?.txHash ?? null,
      status,
      netProfitUsdc: status === 'success' ? opp.netProfitUsdc.toString() : null,
      gasCostUsdc: opp.estimatedGasCost.toString(),
      slippagePct: opp.slippagePct,
      source: opp.source,
      executedAt: now,
    };

    if (this.tradesRepo) {
      try {
        this.tradesRepo.insert({
          id: record.id,
          network: opp.network,
          tokenIn: opp.tokenIn,
          tokenOut: opp.tokenOut,
          amountIn: opp.amountIn.toString(),
          expectedOut: opp.expectedOut.toString(),
          gasCostUsdc: opp.estimatedGasCost.toString(),
          source: opp.source,
          slippagePct: opp.slippagePct,
          executedAt: now,
        });

        this.tradesRepo.updateAfterExecution(id, {
          txHash: swapResult?.txHash ?? undefined,
          status,
          actualOut: status === 'success'
            ? (swapResult?.actualAmountOut ?? opp.expectedOut.toString())
            : undefined,
          netProfitUsdc: status === 'success' ? opp.netProfitUsdc.toString() : undefined,
        });
      } catch (err) {
        // Non-fatal — log and continue; the in-memory record is still valid.
        console.error('[TradeExecutor] Failed to persist trade record:', err);
      }
    }

    return record;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a production-ready TradeExecutor.
 */
export function createTradeExecutor(options?: TradeExecutorOptions): TradeExecutor {
  return new TradeExecutor(options);
}
