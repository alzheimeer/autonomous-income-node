/**
 * PaymentValidator — x402 payment proof validation and USDC on-chain verification.
 *
 * Responsibilities:
 *  - validateProof: parse and validate an x402 payment proof header (tx hash).
 *  - verifyUsdcTransfer: verify a USDC ERC-20 Transfer event on Base via RPC.
 *  - getUsdcBalance: query USDC balance of an address with a minimum 60-second
 *    cache window to avoid hammering the RPC endpoint.
 *
 * MOCK MODE:
 *  When `MOCK_PAYMENTS=true` is set in the environment, all validations return
 *  `true` and the balance is hardcoded to 100 USDC (100_000000n in 6-decimal units).
 *  This enables development and testing without a live RPC connection.
 *
 * Requirements: 4.2, 4.4, 4.7
 */

import { JsonRpcProvider, Contract, isHexString } from 'ethers';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** USDC contract address on Base mainnet. */
export const USDC_ADDRESS_BASE = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

/** ERC-20 minimal ABI — only the functions we use. */
const ERC20_ABI = [
  'function balanceOf(address owner) view returns (uint256)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
];

/** Minimum interval (ms) between balance queries per address (Req 4.7). */
const BALANCE_CACHE_TTL_MS = 60_000;

/** Mock balance: 100 USDC in 6-decimal units. */
const MOCK_BALANCE_USDC = 100_000_000n;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ValidationResult {
  valid: boolean;
  /** Amount verified in 6-decimal USDC units (only set when valid). */
  amount?: bigint;
  /** USDC transfer destination address (only set when valid). */
  toAddress?: string;
  /** Tx hash that was validated. */
  txHash?: string;
  /** Block number where the tx was confirmed. */
  blockNumber?: number;
  /** Human-readable rejection reason (only set when !valid). */
  reason?: string;
}

// ---------------------------------------------------------------------------
// Internal balance-cache entry
// ---------------------------------------------------------------------------

interface BalanceCacheEntry {
  balance: bigint;
  fetchedAt: number; // Date.now() timestamp
}

// ---------------------------------------------------------------------------
// PaymentValidator interface
// ---------------------------------------------------------------------------

export interface PaymentValidator {
  /**
   * Validate an x402 payment proof string.
   *
   * The proof is expected to be a 0x-prefixed 32-byte tx hash.
   * The method resolves the transaction on Base and verifies that a USDC
   * Transfer event of at least `expectedAmount` was emitted targeting this
   * node's wallet.
   *
   * @param proof           The payment-proof header value from the x402 request.
   * @param expectedAmount  Minimum USDC amount (6 decimals) that must be transferred.
   * @returns               ValidationResult with `valid: true` on success.
   */
  validateProof(proof: string, expectedAmount: bigint): Promise<ValidationResult>;

  /**
   * Verify that a specific USDC Transfer event exists in a transaction.
   *
   * @param txHash    Transaction hash to inspect.
   * @param amount    Expected USDC amount (6 decimals) — exact match required.
   * @param toAddress Expected recipient address (checksummed or lowercase).
   * @returns         `true` when the Transfer event matches all criteria.
   */
  verifyUsdcTransfer(txHash: string, amount: bigint, toAddress: string): Promise<boolean>;

  /**
   * Return the USDC balance of `walletAddress` in 6-decimal units.
   *
   * Results are cached per address for at least 60 seconds (Req 4.7).
   *
   * @param walletAddress Ethereum address to query.
   * @returns             Balance in 6-decimal USDC units.
   */
  getUsdcBalance(walletAddress: string): Promise<bigint>;
}

// ---------------------------------------------------------------------------
// PaymentValidatorImpl
// ---------------------------------------------------------------------------

export class PaymentValidatorImpl implements PaymentValidator {
  private readonly provider: JsonRpcProvider | null;
  private readonly usdcContract: Contract | null;
  /** Cache: address → last fetched balance + timestamp. */
  private readonly balanceCache = new Map<string, BalanceCacheEntry>();
  /** Whether we are running in mock mode. */
  private readonly mockMode: boolean;

  /**
   * @param rpcUrl   Base network JSON-RPC URL (defaults to `RPC_PROVIDER_URL` env var).
   *                 Pass `null` explicitly to force mock mode from code.
   * @param mockMode Override for mock mode. Defaults to `MOCK_PAYMENTS=true` or
   *                 `MOCK_ONCHAIN_IDENTITY=true` env check (either activates mock mode).
   */
  constructor(rpcUrl?: string | null, mockMode?: boolean) {
    this.mockMode =
      mockMode ??
      ((process.env['MOCK_PAYMENTS']?.toLowerCase() === 'true') ||
        (process.env['MOCK_ONCHAIN_IDENTITY']?.toLowerCase() === 'true'));

    if (this.mockMode) {
      // No RPC connection needed in mock mode.
      this.provider = null;
      this.usdcContract = null;
    } else {
      const url = rpcUrl ?? process.env['RPC_PROVIDER_URL'];
      if (!url) {
        throw new Error(
          '[PaymentValidator] RPC_PROVIDER_URL env variable is required when MOCK_PAYMENTS is not set.',
        );
      }
      this.provider = new JsonRpcProvider(url);
      this.usdcContract = new Contract(USDC_ADDRESS_BASE, ERC20_ABI, this.provider);
    }
  }

  // ── validateProof ──────────────────────────────────────────────────────────

  async validateProof(proof: string, expectedAmount: bigint): Promise<ValidationResult> {
    if (this.mockMode) {
      return {
        valid: true,
        amount: expectedAmount,
        txHash: `0xmock_payment_${Date.now()}`,
        reason: undefined,
      };
    }

    // The proof must be a 32-byte hex tx hash.
    if (!this._isTxHash(proof)) {
      return {
        valid: false,
        reason: `Invalid payment proof format: expected a 0x-prefixed 32-byte transaction hash, got "${proof}"`,
      };
    }

    try {
      const receipt = await this.provider!.getTransactionReceipt(proof);

      if (!receipt) {
        return {
          valid: false,
          txHash: proof,
          reason: `Transaction ${proof} not found or not yet mined on Base.`,
        };
      }

      if (receipt.status !== 1) {
        return {
          valid: false,
          txHash: proof,
          blockNumber: receipt.blockNumber,
          reason: `Transaction ${proof} failed on-chain (status = ${receipt.status}).`,
        };
      }

      // Parse Transfer events from this tx.
      const transferEvent = await this._findTransferEvent(receipt, expectedAmount);
      if (!transferEvent) {
        return {
          valid: false,
          txHash: proof,
          blockNumber: receipt.blockNumber,
          reason: `No USDC Transfer event for amount ≥ ${expectedAmount} found in tx ${proof}.`,
        };
      }

      return {
        valid: true,
        amount: transferEvent.amount,
        toAddress: transferEvent.toAddress,
        txHash: proof,
        blockNumber: receipt.blockNumber,
      };
    } catch (err) {
      return {
        valid: false,
        txHash: proof,
        reason: `RPC error while validating proof: ${(err as Error).message}`,
      };
    }
  }

  // ── verifyUsdcTransfer ─────────────────────────────────────────────────────

  async verifyUsdcTransfer(
    txHash: string,
    amount: bigint,
    toAddress: string,
  ): Promise<boolean> {
    if (this.mockMode) {
      return true;
    }

    if (!this._isTxHash(txHash)) {
      return false;
    }

    try {
      const receipt = await this.provider!.getTransactionReceipt(txHash);
      if (!receipt || receipt.status !== 1) {
        return false;
      }

      const transferEvent = await this._findTransferEvent(receipt, amount, toAddress);
      return transferEvent !== null;
    } catch {
      return false;
    }
  }

  // ── getUsdcBalance ─────────────────────────────────────────────────────────

  async getUsdcBalance(walletAddress: string): Promise<bigint> {
    if (this.mockMode) {
      return MOCK_BALANCE_USDC;
    }

    const normalised = walletAddress.toLowerCase();
    const cached = this.balanceCache.get(normalised);
    const now = Date.now();

    // Return cached value if it is within the TTL window (Req 4.7).
    if (cached && now - cached.fetchedAt < BALANCE_CACHE_TTL_MS) {
      return cached.balance;
    }

    // Fetch fresh balance from RPC.
    const rawBalance: bigint = await this.usdcContract!.balanceOf(walletAddress) as bigint;

    this.balanceCache.set(normalised, { balance: rawBalance, fetchedAt: now });

    return rawBalance;
  }

  // ── Private helpers ────────────────────────────────────────────────────────

  /**
   * Returns true when `value` looks like a 0x-prefixed 32-byte tx hash.
   */
  private _isTxHash(value: string): boolean {
    return isHexString(value, 32);
  }

  /**
   * Scan the logs of a tx receipt for a USDC Transfer event that:
   *  - emitted from the USDC contract address
   *  - transferred at least `minAmount` tokens
   *  - optionally matched `toAddress` (exact match, case-insensitive)
   *
   * Returns the parsed transfer details, or null when no match is found.
   */
  private async _findTransferEvent(
    receipt: Awaited<ReturnType<JsonRpcProvider['getTransactionReceipt']>>,
    minAmount: bigint,
    toAddress?: string,
  ): Promise<{ amount: bigint; toAddress: string } | null> {
    if (!receipt) return null;

    const usdcAddressLower = USDC_ADDRESS_BASE.toLowerCase();
    const toAddressLower = toAddress?.toLowerCase();

    // Parse Transfer(address,address,uint256) topic
    const transferTopic = this.usdcContract!.interface.getEvent('Transfer')!.topicHash;

    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== usdcAddressLower) continue;
      if (log.topics[0] !== transferTopic) continue;

      try {
        const parsed = this.usdcContract!.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });

        if (!parsed) continue;

        const transferredAmount: bigint = parsed.args[2] as bigint;
        const recipient: string = (parsed.args[1] as string).toLowerCase();

        if (transferredAmount < minAmount) continue;
        if (toAddressLower && recipient !== toAddressLower) continue;

        return { amount: transferredAmount, toAddress: parsed.args[1] as string };
      } catch {
        // Malformed log — skip.
        continue;
      }
    }

    return null;
  }
}
