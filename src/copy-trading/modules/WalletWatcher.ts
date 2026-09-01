/**
 * WalletWatcher Module
 *
 * Monitors on-chain events from curated smart money wallets in real-time.
 * This task implements the basic WebSocket connection with auto-reconnect and heartbeat,
 * plus HTTP polling fallback mode, calldata decoding for supported DEX routers,
 * and dust transfer filtering.
 *
 * Requirements:
 * - 2.2: Support both WebSocket and polling ingestion methods
 * - 2.3: When using polling mode, poll for new transactions every 2 seconds
 * - 2.4: Decode swap calldata from Uniswap V3, Aerodrome, and 1inch routers
 * - 2.5: Extract token addresses, amounts, and direction (BUY/SELL)
 * - 2.6: Ignore dust transfers with value less than $100 USDC (configurable)
 * - 2.9: Maintain a heartbeat every 30 seconds to verify connection health
 * - 2.10: Auto-reconnect within 10 seconds if WebSocket connection is lost
 * 
 * Property 7: Dust Transfer Filtering
 * For any transfer event with value < minTransferValueUsdc, the WalletWatcher
 * SHALL NOT emit a CopySignal.
 */

import { ethers } from 'ethers';
import { createLogger } from '../../logger.js';
import type {
  WalletWatcherConfig,
  IWalletWatcher,
  CopySignal,
  WalletTier,
} from '../interfaces/types.js';
import { SwapDecoder, type DecodedSwap, USDC_BASE, USDBC_BASE, WETH_BASE } from './SwapDecoder.js';

const log = createLogger('wallet-watcher');

// =============================================================================
// CONSTANTS
// =============================================================================

/** Heartbeat interval in milliseconds (30 seconds per Req 2.9) */
const COPY_HEARTBEAT_INTERVAL_MS = 30_000;

/** Default minimum transfer value in USDC to consider (ignores dust) - Req 2.6 */
const DEFAULT_MIN_TRANSFER_VALUE_USDC = 100;

/** USDC/USDbC decimals */
const USDC_DECIMALS = 6;

/** WETH decimals */
const WETH_DECIMALS = 18;

/** Hardcoded ETH price estimate in USDC (can be improved with oracle later) */
const ETH_PRICE_USDC = 2500;

/** Reconnect timeout in milliseconds (10 seconds per Req 2.10) */
const COPY_RECONNECT_TIMEOUT_MS = 10_000;

/** Maximum consecutive missed heartbeats before considering connection dead */
const MAX_MISSED_HEARTBEATS = 3;

/** Default polling interval in milliseconds (2 seconds per Req 2.3) */
const DEFAULT_POLLING_INTERVAL_MS = 2_000;

// =============================================================================
// STATS INTERFACE
// =============================================================================

/**
 * Statistics interface for WalletWatcher tracking.
 */
export interface WalletWatcherStats {
  /** Number of dust transfers filtered (below minTransferValueUsdc threshold) */
  dustFiltered: number;
  /** Number of transactions processed successfully */
  transactionsProcessed: number;
  /** Number of signals emitted */
  signalsEmitted: number;
}

// =============================================================================
// WALLET WATCHER CLASS
// =============================================================================

/**
 * WalletWatcher monitors smart money wallets for swap transactions in real-time.
 *
 * This implementation supports multiple ingestion modes:
 * - WebSocket: Low-latency real-time connection
 * - Polling: HTTP polling fallback every 2 seconds
 * - Hybrid: WebSocket primary with automatic polling fallback
 *
 * Features:
 * - Establishes WebSocket connection to RPC provider
 * - HTTP polling as fallback when WebSocket is unavailable
 * - Maintains heartbeat every 30 seconds (Req 2.9)
 * - Auto-reconnects within 10 seconds on disconnect (Req 2.10)
 * - Tracks connection health and missed heartbeats
 * - Decodes swap calldata from Uniswap V3, Aerodrome, and 1inch routers
 */
export class WalletWatcher implements IWalletWatcher {
  // ─── Configuration ────────────────────────────────────────────────────────
  private readonly config: WalletWatcherConfig;

  // ─── Swap Decoder ─────────────────────────────────────────────────────────
  private readonly swapDecoder: SwapDecoder;

  // ─── WebSocket Connection State ───────────────────────────────────────────
  private provider: ethers.WebSocketProvider | null = null;
  private isRunning: boolean = false;
  private isConnected: boolean = false;

  // ─── HTTP Polling State ───────────────────────────────────────────────────
  private httpProvider: ethers.JsonRpcProvider | null = null;
  private pollingTimer: NodeJS.Timeout | null = null;
  private lastPolledBlock: number = 0;
  private isPollingActive: boolean = false;

  // ─── Heartbeat State ──────────────────────────────────────────────────────
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private lastHeartbeat: number = 0;
  private missedHeartbeats: number = 0;

  // ─── Reconnect State ──────────────────────────────────────────────────────
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempts: number = 0;

  // ─── Signal Callbacks ─────────────────────────────────────────────────────
  private signalCallbacks: Array<(signal: CopySignal) => Promise<void>> = [];

  // ─── Wallet Tier Lookup ─────────────────────────────────────────────────────
  private walletTierLookup: ((address: string) => WalletTier | null) | null = null;

  // ─── Watched Wallets ──────────────────────────────────────────────────────
  private watchedWallets: Set<string>;

  // ─── Statistics ─────────────────────────────────────────────────────────────
  private stats: WalletWatcherStats = {
    dustFiltered: 0,
    transactionsProcessed: 0,
    signalsEmitted: 0,
  };

  /**
   * Creates a new WalletWatcher instance.
   *
   * @param config - WalletWatcher configuration
   */
  constructor(config: WalletWatcherConfig) {
    this.config = config;
    this.watchedWallets = new Set(
      config.watchedWallets.map((w) => w.toLowerCase()),
    );

    // Initialize swap decoder with supported router addresses
    this.swapDecoder = new SwapDecoder(config.supportedRouters);

    log.info('WalletWatcher initialized', {
      ingestMethod: config.ingestMethod,
      watchedWalletsCount: this.watchedWallets.size,
      heartbeatIntervalMs: COPY_HEARTBEAT_INTERVAL_MS,
      reconnectTimeoutMs: COPY_RECONNECT_TIMEOUT_MS,
      supportedRouters: Object.keys(config.supportedRouters),
    });
  }

  // ===========================================================================
  // PUBLIC INTERFACE
  // ===========================================================================

  /**
   * Start watching for swaps from monitored wallets.
   *
   * Establishes WebSocket connection and starts heartbeat monitoring.
   * Supports three ingestion modes:
   * - 'websocket': Only WebSocket connection
   * - 'polling': Only HTTP polling
   * - 'hybrid': WebSocket primary with polling fallback on disconnect
   */
  public start(): void {
    if (this.isRunning) {
      log.warn('WalletWatcher already running');
      return;
    }

    this.isRunning = true;
    log.info('Starting WalletWatcher', {
      ingestMethod: this.config.ingestMethod,
      wsRpcUrl: this.maskUrl(this.config.wsRpcUrl),
      httpRpcUrl: this.maskUrl(this.config.httpRpcUrl),
    });

    switch (this.config.ingestMethod) {
      case 'websocket':
        // WebSocket only mode
        void this.connectWebSocket();
        break;

      case 'polling':
        // Polling only mode - no WebSocket
        this.startPolling();
        break;

      case 'hybrid':
        // Hybrid mode: Start WebSocket, fall back to polling on disconnect
        void this.connectWebSocket();
        break;

      default:
        log.error('Unknown ingest method', {
          ingestMethod: this.config.ingestMethod,
        });
    }
  }

  /**
   * Stop watching and clean up resources.
   *
   * Closes WebSocket connection, stops polling, and stops all timers.
   */
  public stop(): void {
    if (!this.isRunning) {
      log.warn('WalletWatcher not running');
      return;
    }

    log.info('Stopping WalletWatcher');
    this.isRunning = false;

    // Clear timers
    this.clearHeartbeatTimer();
    this.clearReconnectTimer();

    // Stop polling
    this.stopPolling();

    // Close WebSocket
    this.disconnectWebSocket();

    log.info('WalletWatcher stopped');
  }

  /**
   * Register a callback for new copy signals.
   *
   * Multiple callbacks can be registered and will be invoked sequentially.
   *
   * @param callback - Async function to handle new signals
   */
  public onSignal(callback: (signal: CopySignal) => Promise<void>): void {
    this.signalCallbacks.push(callback);
    log.debug('Signal callback registered', {
      totalCallbacks: this.signalCallbacks.length,
    });
  }

  /**
   * Get current connection health status.
   *
   * @returns Health status with connection state, last heartbeat, and missed heartbeats
   */
  public getHealth(): {
    isConnected: boolean;
    lastHeartbeat: number;
    missedHeartbeats: number;
  } {
    return {
      isConnected: this.isConnected || this.isPollingActive,
      lastHeartbeat: this.lastHeartbeat,
      missedHeartbeats: this.missedHeartbeats,
    };
  }

  /**
   * Get the last polled block number for debugging/monitoring purposes.
   *
   * @returns The last block number that was polled, or 0 if polling hasn't started
   */
  public getLastPolledBlock(): number {
    return this.lastPolledBlock;
  }

  /**
   * Update the list of watched wallets.
   *
   * @param wallets - New list of wallet addresses to monitor
   */
  public updateWallets(wallets: string[]): void {
    const previousCount = this.watchedWallets.size;
    this.watchedWallets = new Set(wallets.map((w) => w.toLowerCase()));

    log.info('Watched wallets updated', {
      previousCount,
      newCount: this.watchedWallets.size,
    });

    // Note: Re-subscribe to new wallets will be handled in task 7.4
  }

  /**
   * Set the wallet tier lookup function.
   *
   * This function is called during signal emission to get the wallet's
   * tier at the time of signal generation.
   *
   * @param lookup - Function that takes a wallet address and returns its tier, or null
   */
  public setWalletTierLookup(lookup: (address: string) => WalletTier | null): void {
    this.walletTierLookup = lookup;
    log.debug('Wallet tier lookup function set');
  }

  // ===========================================================================
  // WEBSOCKET CONNECTION MANAGEMENT
  // ===========================================================================

  /**
   * Establish WebSocket connection to RPC provider.
   *
   * In 'hybrid' mode, stops polling when WebSocket connection is established.
   */
  private async connectWebSocket(): Promise<void> {
    try {
      log.info('Connecting to WebSocket RPC', {
        url: this.maskUrl(this.config.wsRpcUrl),
      });

      // Create WebSocket provider
      this.provider = new ethers.WebSocketProvider(this.config.wsRpcUrl);

      // Wait for the provider to be ready
      await this.provider.ready;

      // Set up event handlers
      this.setupProviderEventHandlers();

      // Mark as connected (confirmed by ready)
      this.isConnected = true;
      this.reconnectAttempts = 0;
      this.missedHeartbeats = 0;
      this.lastHeartbeat = Date.now();

      // In hybrid mode, stop polling now that WebSocket is back
      if (this.config.ingestMethod === 'hybrid' && this.isPollingActive) {
        log.info('Hybrid mode: WebSocket restored, stopping polling fallback');
        this.stopPolling();
      }

      // Start heartbeat monitoring
      this.startHeartbeat();

      log.info('WebSocket connection established');
    } catch (error) {
      log.error('Failed to connect WebSocket', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.isConnected = false;
      this.scheduleReconnect();
    }
  }

  /**
   * Set up event handlers for the WebSocket provider.
   *
   * In ethers v6, WebSocketProvider emits 'error' events that we can listen to.
   * We also use the provider's internal state to detect disconnections.
   */
  private setupProviderEventHandlers(): void {
    if (!this.provider) return;

    // Listen for provider errors
    this.provider.on('error', (error: Error) => {
      log.error('Provider error', {
        error: error.message,
      });
      this.handleDisconnect();
    });

    // Listen for network changes (can indicate reconnection issues)
    this.provider.on('network', (newNetwork, oldNetwork) => {
      if (oldNetwork) {
        log.info('Network changed', {
          oldChainId: oldNetwork.chainId,
          newChainId: newNetwork.chainId,
        });
      }
    });

    // Note: Block/transaction listeners will be set up in task 7.3
  }

  /**
   * Handle WebSocket disconnection.
   *
   * In 'hybrid' mode, automatically falls back to polling.
   * In 'websocket' mode, schedules reconnection attempt.
   */
  private handleDisconnect(): void {
    if (!this.isRunning) return;

    log.warn('WebSocket disconnected', {
      reconnectAttempts: this.reconnectAttempts,
      ingestMethod: this.config.ingestMethod,
    });

    this.isConnected = false;
    this.clearHeartbeatTimer();

    // In hybrid mode, fall back to polling while attempting to reconnect
    if (this.config.ingestMethod === 'hybrid') {
      log.info('Hybrid mode: Falling back to polling while WebSocket reconnects');
      this.startPolling();
    }

    this.scheduleReconnect();
  }

  /**
   * Disconnect WebSocket and clean up provider.
   */
  private disconnectWebSocket(): void {
    if (this.provider) {
      try {
        this.provider.destroy();
      } catch (error) {
        log.warn('Error destroying provider', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
      this.provider = null;
    }
    this.isConnected = false;
  }

  // ===========================================================================
  // HEARTBEAT MANAGEMENT (Requirement 2.9)
  // ===========================================================================

  /**
   * Start the heartbeat monitoring loop.
   *
   * Sends a heartbeat every 30 seconds to verify connection health.
   */
  private startHeartbeat(): void {
    this.clearHeartbeatTimer();

    this.heartbeatTimer = setInterval(() => {
      this.performHeartbeat();
    }, COPY_HEARTBEAT_INTERVAL_MS);

    log.debug('Heartbeat monitoring started', {
      intervalMs: COPY_HEARTBEAT_INTERVAL_MS,
    });
  }

  /**
   * Perform a single heartbeat check.
   *
   * Attempts to get the current block number to verify connection is alive.
   */
  private async performHeartbeat(): Promise<void> {
    if (!this.provider || !this.isConnected) {
      log.debug('Skipping heartbeat - not connected');
      return;
    }

    try {
      // Use getBlockNumber as a simple health check
      const blockNumber = await this.provider.getBlockNumber();

      // Heartbeat successful
      this.lastHeartbeat = Date.now();
      this.missedHeartbeats = 0;

      log.debug('Heartbeat successful', {
        blockNumber,
        timestamp: this.lastHeartbeat,
      });
    } catch (error) {
      // Heartbeat failed
      this.missedHeartbeats++;

      log.warn('Heartbeat failed', {
        missedHeartbeats: this.missedHeartbeats,
        maxMissed: MAX_MISSED_HEARTBEATS,
        error: error instanceof Error ? error.message : String(error),
      });

      // If too many missed heartbeats, trigger reconnect
      if (this.missedHeartbeats >= MAX_MISSED_HEARTBEATS) {
        log.error('Too many missed heartbeats, reconnecting', {
          missedHeartbeats: this.missedHeartbeats,
        });
        this.handleDisconnect();
      }
    }
  }

  /**
   * Clear the heartbeat timer.
   */
  private clearHeartbeatTimer(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }

  // ===========================================================================
  // RECONNECTION MANAGEMENT (Requirement 2.10)
  // ===========================================================================

  /**
   * Schedule a reconnection attempt.
   *
   * Automatically reconnects within 10 seconds if connection is lost.
   */
  private scheduleReconnect(): void {
    if (!this.isRunning) {
      log.debug('Not scheduling reconnect - watcher stopped');
      return;
    }

    this.clearReconnectTimer();

    this.reconnectAttempts++;

    log.info('Scheduling reconnect', {
      attempt: this.reconnectAttempts,
      delayMs: COPY_RECONNECT_TIMEOUT_MS,
    });

    this.reconnectTimer = setTimeout(() => {
      this.attemptReconnect();
    }, COPY_RECONNECT_TIMEOUT_MS);
  }

  /**
   * Attempt to reconnect to the WebSocket.
   */
  private attemptReconnect(): void {
    if (!this.isRunning) {
      log.debug('Not reconnecting - watcher stopped');
      return;
    }

    log.info('Attempting reconnect', {
      attempt: this.reconnectAttempts,
    });

    // Clean up existing provider
    this.disconnectWebSocket();

    // Attempt new connection (fire and forget - errors will trigger another reconnect)
    void this.connectWebSocket();
  }

  /**
   * Clear the reconnect timer.
   */
  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  // ===========================================================================
  // HTTP POLLING MANAGEMENT (Requirement 2.2, 2.3)
  // ===========================================================================

  /**
   * Start HTTP polling for new blocks and transactions.
   *
   * Creates a JsonRpcProvider and polls every pollingIntervalMs (default 2000ms).
   * Used as fallback when WebSocket is unavailable or in 'polling' mode.
   */
  private startPolling(): void {
    if (this.isPollingActive) {
      log.debug('Polling already active');
      return;
    }

    if (!this.config.httpRpcUrl) {
      log.error('Cannot start polling - httpRpcUrl not configured');
      return;
    }

    try {
      // Create HTTP provider if not already created
      if (!this.httpProvider) {
        this.httpProvider = new ethers.JsonRpcProvider(this.config.httpRpcUrl);
        log.info('HTTP provider created', {
          url: this.maskUrl(this.config.httpRpcUrl),
        });
      }

      // Determine polling interval
      const pollingIntervalMs =
        this.config.pollingIntervalMs || DEFAULT_POLLING_INTERVAL_MS;

      // Start polling loop
      this.isPollingActive = true;
      this.pollingTimer = setInterval(() => {
        void this.pollForBlocks();
      }, pollingIntervalMs);

      log.info('HTTP polling started', {
        intervalMs: pollingIntervalMs,
        watchedWallets: this.watchedWallets.size,
      });

      // Perform initial poll immediately
      void this.pollForBlocks();
    } catch (error) {
      log.error('Failed to start polling', {
        error: error instanceof Error ? error.message : String(error),
      });
      this.isPollingActive = false;
    }
  }

  /**
   * Stop HTTP polling and clean up resources.
   */
  private stopPolling(): void {
    if (this.pollingTimer) {
      clearInterval(this.pollingTimer);
      this.pollingTimer = null;
    }

    this.isPollingActive = false;

    // Note: We keep httpProvider alive for potential reuse
    // It will be cleaned up when the watcher is stopped

    log.info('HTTP polling stopped');
  }

  /**
   * Poll for new blocks and check for transactions from watched wallets.
   *
   * Gets the latest block and checks for any transactions from watched wallets.
   * The actual transaction processing logic will be implemented in task 7.3.
   */
  private async pollForBlocks(): Promise<void> {
    if (!this.httpProvider || !this.isPollingActive) {
      return;
    }

    try {
      // Get the latest block number
      const latestBlockNumber = await this.httpProvider.getBlockNumber();

      // Skip if we've already processed this block
      if (latestBlockNumber <= this.lastPolledBlock) {
        log.debug('No new blocks to poll', {
          latestBlock: latestBlockNumber,
          lastPolled: this.lastPolledBlock,
        });
        return;
      }

      // Determine the range of blocks to process
      // If this is the first poll, just process the latest block
      const startBlock =
        this.lastPolledBlock === 0
          ? latestBlockNumber
          : this.lastPolledBlock + 1;

      log.debug('Polling blocks', {
        startBlock,
        endBlock: latestBlockNumber,
        blockCount: latestBlockNumber - startBlock + 1,
      });

      // Process each block in the range
      for (
        let blockNumber = startBlock;
        blockNumber <= latestBlockNumber;
        blockNumber++
      ) {
        await this.processBlockForWatchedWallets(blockNumber);
      }

      // Update last polled block
      this.lastPolledBlock = latestBlockNumber;
      this.lastHeartbeat = Date.now(); // Polling acts as heartbeat

      log.debug('Polling cycle completed', {
        lastPolledBlock: this.lastPolledBlock,
      });
    } catch (error) {
      log.error('Polling error', {
        error: error instanceof Error ? error.message : String(error),
        lastPolledBlock: this.lastPolledBlock,
      });
    }
  }

  /**
   * Process a single block to find transactions from watched wallets.
   *
   * Gets the block with transactions and filters for transactions from
   * watched wallets. Decodes swap calldata and logs decoded swap details.
   *
   * @param blockNumber - The block number to process
   */
  private async processBlockForWatchedWallets(blockNumber: number): Promise<void> {
    if (!this.httpProvider) return;

    try {
      // Get block with full transaction objects
      const block = await this.httpProvider.getBlock(blockNumber, true);

      if (!block || !block.prefetchedTransactions) {
        log.debug('Block has no transactions', { blockNumber });
        return;
      }

      // Filter transactions from watched wallets
      const watchedTxs = block.prefetchedTransactions.filter(
        (tx) => tx.from && this.watchedWallets.has(tx.from.toLowerCase()),
      );

      if (watchedTxs.length > 0) {
        log.info('Found transactions from watched wallets', {
          blockNumber,
          count: watchedTxs.length,
          wallets: watchedTxs.map((tx) => tx.from),
        });

        // Process each transaction and decode swap calldata
        for (const tx of watchedTxs) {
          await this.processTransaction(tx, blockNumber, block.timestamp);
        }
      }
    } catch (error) {
      log.error('Error processing block', {
        blockNumber,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Process a single transaction from a watched wallet.
   *
   * Decodes swap calldata using SwapDecoder, filters dust transfers,
   * creates CopySignal, and emits it to registered callbacks.
   *
   * @param tx - The transaction response
   * @param blockNumber - The block number containing this transaction
   * @param blockTimestamp - The block timestamp
   */
  private async processTransaction(
    tx: ethers.TransactionResponse,
    blockNumber: number,
    blockTimestamp: number,
  ): Promise<void> {
    // Skip transactions without a destination (contract creation)
    if (!tx.to) {
      log.debug('Skipping contract creation transaction', {
        txHash: tx.hash,
        from: tx.from,
      });
      return;
    }

    // Attempt to decode the transaction calldata
    const decodedSwap = this.swapDecoder.decode(tx.to, tx.data);

    if (!decodedSwap) {
      log.debug('Transaction is not a recognized swap', {
        txHash: tx.hash,
        from: tx.from,
        to: tx.to,
      });
      return;
    }

    // Estimate USDC value for dust filtering (Requirement 2.6, Property 7)
    const usdcValue = this.estimateUsdcValue(decodedSwap);
    const minTransferValueUsdc = this.config.minTransferValueUsdc ?? DEFAULT_MIN_TRANSFER_VALUE_USDC;

    // Filter dust transfers - must be strictly less than threshold to be filtered
    // Transactions at exactly minTransferValueUsdc are NOT filtered
    if (usdcValue < minTransferValueUsdc) {
      this.stats.dustFiltered++;
      log.debug('Skipping dust transfer', {
        txHash: tx.hash,
        usdcValue,
        minTransferValueUsdc,
        from: tx.from,
        tokenIn: decodedSwap.tokenIn,
        tokenOut: decodedSwap.tokenOut,
      });
      return;
    }

    // Increment processed counter
    this.stats.transactionsProcessed++;

    // Create CopySignal (Property 8: CopySignal Field Completeness)
    const signal = this.createCopySignal(
      tx,
      decodedSwap,
      blockNumber,
      blockTimestamp,
      usdcValue,
    );

    // Log the decoded swap and signal details
    log.info('Decoded swap transaction - emitting CopySignal', {
      signalId: signal.id,
      blockNumber,
      txHash: tx.hash,
      from: tx.from,
      router: decodedSwap.router,
      action: decodedSwap.action,
      tokenIn: decodedSwap.tokenIn,
      tokenOut: decodedSwap.tokenOut,
      amountIn: decodedSwap.amountIn.toString(),
      amountOutMin: decodedSwap.amountOutMin.toString(),
      recipient: decodedSwap.recipient,
      usdcValue,
      walletTier: signal.walletTier,
      detectionLatencyMs: signal.detectionLatencyMs,
    });

    // Emit signal to all registered callbacks
    await this.emitSignal(signal);
  }

  /**
   * Get the swap decoder instance (for testing purposes).
   *
   * @returns The SwapDecoder instance
   */
  public getSwapDecoder(): SwapDecoder {
    return this.swapDecoder;
  }

  /**
   * Get current statistics for monitoring and debugging.
   *
   * @returns Statistics object with dust filtered count and other metrics
   */
  public getStats(): WalletWatcherStats {
    return { ...this.stats };
  }

  /**
   * Reset statistics counters (mainly for testing purposes).
   */
  public resetStats(): void {
    this.stats = {
      dustFiltered: 0,
      transactionsProcessed: 0,
      signalsEmitted: 0,
    };
  }

  // ===========================================================================
  // DUST FILTERING (Requirement 2.6, Property 7)
  // ===========================================================================

  /**
   * Estimate the USDC equivalent value of a decoded swap.
   *
   * Calculation rules:
   * - If tokenIn is USDC or USDbC: use amountIn directly (adjusted for 6 decimals)
   * - If tokenOut is USDC or USDbC: use amountOutMin (adjusted for 6 decimals)
   * - If WETH is involved: use hardcoded ETH price estimate ($2500)
   * - For other tokens: return 0 (needs price oracle, skip for now)
   *
   * @param decodedSwap - The decoded swap information
   * @returns Estimated USDC value of the swap
   */
  public estimateUsdcValue(decodedSwap: DecodedSwap): number {
    const tokenInLower = decodedSwap.tokenIn.toLowerCase();
    const tokenOutLower = decodedSwap.tokenOut.toLowerCase();
    const usdcLower = USDC_BASE.toLowerCase();
    const usdbcLower = USDBC_BASE.toLowerCase();
    const wethLower = WETH_BASE.toLowerCase();

    // Case 1: tokenIn is USDC or USDbC - use amountIn
    if (tokenInLower === usdcLower || tokenInLower === usdbcLower) {
      // USDC/USDbC has 6 decimals
      return Number(decodedSwap.amountIn) / Math.pow(10, USDC_DECIMALS);
    }

    // Case 2: tokenOut is USDC or USDbC - use amountOutMin
    if (tokenOutLower === usdcLower || tokenOutLower === usdbcLower) {
      // USDC/USDbC has 6 decimals
      return Number(decodedSwap.amountOutMin) / Math.pow(10, USDC_DECIMALS);
    }

    // Case 3: tokenIn is WETH - convert using ETH price
    if (tokenInLower === wethLower) {
      // WETH has 18 decimals
      const ethAmount = Number(decodedSwap.amountIn) / Math.pow(10, WETH_DECIMALS);
      return ethAmount * ETH_PRICE_USDC;
    }

    // Case 4: tokenOut is WETH - convert using ETH price
    if (tokenOutLower === wethLower) {
      // WETH has 18 decimals
      const ethAmount = Number(decodedSwap.amountOutMin) / Math.pow(10, WETH_DECIMALS);
      return ethAmount * ETH_PRICE_USDC;
    }

    // Case 5: Neither token is a known base token - return 0
    // This will need a price oracle in the future
    log.debug('Cannot estimate USDC value - no base token in swap', {
      tokenIn: decodedSwap.tokenIn,
      tokenOut: decodedSwap.tokenOut,
    });
    return 0;
  }

  // ===========================================================================
  // COPY SIGNAL GENERATION (Requirement 2.8, Property 8)
  // ===========================================================================

  /**
   * Create a CopySignal from a decoded swap transaction.
   *
   * Property 8: CopySignal Field Completeness
   * For any valid swap detected from a monitored wallet, the emitted CopySignal
   * SHALL contain all required fields: id, sourceWallet, walletTier, tokenAddress,
   * poolAddress, action, tradeAmountUsdc, entryPrice, blockNumber, txHash,
   * detectedAt, detectionLatencyMs.
   *
   * @param tx - The transaction response
   * @param decodedSwap - The decoded swap information
   * @param blockNumber - The block number containing this transaction
   * @param blockTimestamp - The block timestamp (in seconds)
   * @param usdcValue - The estimated USDC value of the trade
   * @returns A complete CopySignal
   */
  public createCopySignal(
    tx: ethers.TransactionResponse,
    decodedSwap: DecodedSwap,
    blockNumber: number,
    blockTimestamp: number,
    usdcValue: number,
  ): CopySignal {
    const detectedAt = Date.now();
    const blockTimestampMs = blockTimestamp * 1000;
    const detectionLatencyMs = detectedAt - blockTimestampMs;

    // Determine tokenAddress based on action:
    // BUY: we're acquiring tokenOut (the non-base token)
    // SELL: we're selling tokenIn (the non-base token)
    const tokenAddress = decodedSwap.action === 'BUY'
      ? decodedSwap.tokenOut
      : decodedSwap.tokenIn;

    // Get wallet tier from lookup, default to B_TIER if not found
    const walletTier = this.getWalletTier(tx.from);

    // Calculate entry price: amountIn / amountOut (as bigint)
    // For precision, we scale by 1e18 before division
    const entryPrice = this.calculateEntryPrice(decodedSwap);

    const signal: CopySignal = {
      id: this.generateUUID(),
      sourceWallet: tx.from,
      walletTier,
      tokenAddress,
      poolAddress: tx.to!, // Router address for now - will be improved
      action: decodedSwap.action,
      tradeAmountUsdc: usdcValue,
      entryPrice,
      blockNumber,
      txHash: tx.hash,
      detectedAt,
      detectionLatencyMs,
    };

    return signal;
  }

  /**
   * Get wallet tier from the lookup function.
   *
   * @param address - The wallet address
   * @returns The wallet tier, defaulting to 'B_TIER' if not found
   */
  private getWalletTier(address: string): WalletTier {
    if (this.walletTierLookup) {
      const tier = this.walletTierLookup(address);
      if (tier) {
        return tier;
      }
    }
    // Default to B_TIER if lookup not set or returns null
    return 'B_TIER';
  }

  /**
   * Calculate entry price as a bigint ratio.
   *
   * Entry price represents tokenIn per tokenOut (how much input to get 1 output).
   * We scale by 1e18 for precision since we're working with bigints.
   *
   * @param decodedSwap - The decoded swap information
   * @returns Entry price as a bigint (scaled by 1e18)
   */
  private calculateEntryPrice(decodedSwap: DecodedSwap): bigint {
    const { amountIn, amountOutMin } = decodedSwap;

    // Avoid division by zero
    if (amountOutMin === 0n) {
      return 0n;
    }

    // Scale by 1e18 for precision: (amountIn * 1e18) / amountOutMin
    const SCALE = BigInt(1e18);
    return (amountIn * SCALE) / amountOutMin;
  }

  /**
   * Emit a CopySignal to all registered callbacks.
   *
   * @param signal - The CopySignal to emit
   */
  private async emitSignal(signal: CopySignal): Promise<void> {
    // Increment signals emitted counter
    this.stats.signalsEmitted++;

    log.info('Emitting CopySignal', {
      signalId: signal.id,
      sourceWallet: signal.sourceWallet,
      walletTier: signal.walletTier,
      action: signal.action,
      tokenAddress: signal.tokenAddress,
      tradeAmountUsdc: signal.tradeAmountUsdc,
      callbackCount: this.signalCallbacks.length,
    });

    // Invoke all registered callbacks
    for (const callback of this.signalCallbacks) {
      try {
        await callback(signal);
      } catch (error) {
        log.error('Error in signal callback', {
          signalId: signal.id,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  /**
   * Generate a UUID v4.
   *
   * Uses crypto.randomUUID() if available, otherwise falls back to
   * a simple implementation using Math.random().
   *
   * @returns A UUID v4 string
   */
  public generateUUID(): string {
    // Try to use crypto.randomUUID() first (available in Node.js 16.7+)
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return crypto.randomUUID();
    }

    // Fallback implementation for older environments
    // Format: xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx
    // Where y is 8, 9, a, or b
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  // ===========================================================================
  // UTILITY METHODS
  // ===========================================================================

  /**
   * Mask a URL for logging (hide sensitive parts).
   *
   * @param url - URL to mask
   * @returns Masked URL string
   */
  private maskUrl(url: string): string {
    const match = url.match(/^(wss?:\/\/|https?:\/\/)/);
    if (match) {
      return `${match[1]}***`;
    }
    return '***';
  }
}
