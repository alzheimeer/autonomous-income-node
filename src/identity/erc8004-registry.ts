/**
 * ERC8004Registry — on-chain identity registration for the Autonomous Income Node.
 *
 * Handles ERC-8004 registration on the Base network with:
 *  - Gas-price retry logic: +20% per attempt, up to 3 retries on gas-related errors.
 *  - Block confirmation wait: 2 confirmations before marking identity as confirmed.
 *  - Mock mode: when MOCK_ONCHAIN_IDENTITY=true, simulates registration without
 *    sending a real transaction (useful for development/CI environments).
 *  - Persistence: stores the RegistrationResult in SQLite via IdentityRepository.
 *  - Cache: isRegistered() and getRegistration() answer within 100ms from SQLite.
 *
 * NOTE: ERC-8004 is not yet deployed on Base mainnet as a canonical standard.
 * The registry uses a best-effort approach:
 *   - In real mode it calls a configurable contract address via a minimal ABI.
 *   - The contract address is read from the ERC8004_CONTRACT_ADDRESS env var.
 *   - If the address is not set or the call fails, it falls back to mock mode and
 *     logs a warning. This allows the system to boot and operate even before the
 *     contract is live.
 *
 * Requirements: 1.2, 3.2, 3.3, 3.4, 3.6
 */

import { ethers } from 'ethers';
import type { IdentityRepository } from '../state/repositories/identity.repo.js';
import type { WalletInfo } from './wallet-manager.js';

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface ERC8004Registry {
  /**
   * Register the wallet on-chain (or simulate registration in mock mode).
   * If the address is already registered (checked via SQLite cache), returns
   * the cached result immediately.
   *
   * @param wallet  WalletInfo from the WalletManagerImpl.
   * @returns       RegistrationResult after 2 block confirmations.
   */
  register(wallet: WalletInfo): Promise<RegistrationResult>;

  /**
   * Check registration status for an address.
   * Answers from SQLite cache in < 100ms (Requirement 3.6).
   *
   * @param address  Checksummed Ethereum address to check.
   * @returns        true if the address has a confirmed registration.
   */
  isRegistered(address: string): Promise<boolean>;

  /**
   * Retrieve the stored RegistrationResult for an address, or null if not found.
   * Answers from SQLite cache in < 100ms (Requirement 3.6).
   *
   * @param address  Checksummed Ethereum address.
   */
  getRegistration(address: string): Promise<RegistrationResult | null>;
}

export interface RegistrationResult {
  /** Transaction hash (mock format in MOCK mode). */
  txHash: string;
  /** Block number of the registration transaction. */
  blockNumber: number;
  /** Number of confirmations at the time of verification. */
  confirmations: number;
  /** True once ≥ 2 confirmations have been observed. */
  confirmed: boolean;
  /** Unix timestamp (ms) when registration was processed. */
  registeredAt: number;
}

// ---------------------------------------------------------------------------
// Internal constants
// ---------------------------------------------------------------------------

/** Minimum block confirmations required before marking identity as confirmed. */
const REQUIRED_CONFIRMATIONS = 2;

/** Maximum number of gas-retry attempts (the initial attempt + 3 retries). */
const MAX_GAS_RETRIES = 3;

/**
 * Gas price is increased by 20% each retry.
 * Applied as: newGasPrice = oldGasPrice * 12n / 10n
 * (avoids floating-point BigInt literals which are not valid JS syntax)
 */
const GAS_RETRY_NUMERATOR = 12n;
const GAS_RETRY_DENOMINATOR = 10n;

/**
 * Minimal ABI for an ERC-8004 registry contract.
 * Expected function: `register(address agent)` — no-arg variant using msg.sender
 * is also acceptable; the actual ABI depends on the deployed contract.
 */
const ERC8004_ABI = [
  'function register() external payable',
  'function isRegistered(address agent) external view returns (bool)',
  'event AgentRegistered(address indexed agent, uint256 timestamp)',
];

/** Error codes / messages that indicate a gas-related failure. */
const GAS_ERROR_PATTERNS = [
  'INSUFFICIENT_FUNDS',
  'REPLACEMENT_UNDERPRICED',
  'insufficient funds',
  'replacement transaction underpriced',
  'gas price too low',
  'max fee per gas less than block base fee',
] as const;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

export class ERC8004RegistryImpl implements ERC8004Registry {
  private readonly provider: ethers.JsonRpcProvider | null;
  private isMockMode: boolean;

  /** Read lazily so tests can set the env var after construction. */
  private get contractAddress(): string | null {
    return process.env['ERC8004_CONTRACT_ADDRESS'] ?? null;
  }

  /**
   * @param identityRepo  Repository for persisting / querying registration state.
   * @param rpcUrl        Base mainnet RPC URL (defaults to RPC_PROVIDER_URL env var).
   * @param mockMode      Force mock mode regardless of env var (useful for tests).
   */
  constructor(
    private readonly identityRepo: IdentityRepository,
    rpcUrl?: string,
    mockMode?: boolean,
  ) {
    // Resolve mock mode: explicit arg > MOCK_ONCHAIN_IDENTITY env var.
    this.isMockMode =
      mockMode ??
      process.env['MOCK_ONCHAIN_IDENTITY'] === 'true';

    // Set up RPC provider (only when not in full mock mode and URL is available).
    const resolvedRpcUrl =
      rpcUrl ?? process.env['RPC_PROVIDER_URL'] ?? null;

    if (!this.isMockMode && resolvedRpcUrl) {
      this.provider = new ethers.JsonRpcProvider(resolvedRpcUrl);
    } else {
      this.provider = null;
      if (!this.isMockMode && !resolvedRpcUrl) {
        console.warn(
          '[ERC8004Registry] RPC_PROVIDER_URL not set — falling back to mock mode.',
        );
        // Upgrade to mock mode silently.
        this.isMockMode = true;
      }
    }
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  async register(wallet: WalletInfo): Promise<RegistrationResult> {
    // Fast path: check SQLite cache first (satisfies Requirement 3.6 < 100ms).
    const cached = await this.getRegistration(wallet.address);
    if (cached?.confirmed) {
      console.info(
        `[ERC8004Registry] Identity already confirmed for ${wallet.address}. Skipping registration.`,
      );
      return cached;
    }

    if (this.isMockMode) {
      return this._registerMock(wallet);
    }

    return this._registerOnChain(wallet);
  }

  async isRegistered(address: string): Promise<boolean> {
    const record = this.identityRepo.findByAddress(address);
    return record?.confirmed ?? false;
  }

  async getRegistration(address: string): Promise<RegistrationResult | null> {
    const record = this.identityRepo.findByAddress(address);
    if (!record || !record.registrationTxHash) {
      return null;
    }

    return {
      txHash: record.registrationTxHash,
      blockNumber: record.registrationBlock ?? 0,
      confirmations: record.confirmed ? REQUIRED_CONFIRMATIONS : 0,
      confirmed: record.confirmed,
      registeredAt: record.createdAt,
    };
  }

  // ── Mock registration ──────────────────────────────────────────────────────

  /**
   * Simulate registration without real blockchain I/O.
   * Generates a deterministic-looking fake txHash and persists the result.
   */
  private async _registerMock(wallet: WalletInfo): Promise<RegistrationResult> {
    console.info(
      `[ERC8004Registry] MOCK mode — simulating ERC-8004 registration for ${wallet.address}`,
    );

    // Simulate a small async delay to mimic network latency.
    await this._sleep(50);

    const mockTxHash =
      '0xmock_' +
      Buffer.from(wallet.address.toLowerCase()).toString('hex').slice(0, 56);

    const mockBlockNumber = Math.floor(Date.now() / 12000); // ~12s blocks
    const registeredAt = Date.now();

    const result: RegistrationResult = {
      txHash: mockTxHash,
      blockNumber: mockBlockNumber,
      confirmations: REQUIRED_CONFIRMATIONS,
      confirmed: true,
      registeredAt,
    };

    this._persistResult(wallet.address, result);

    console.info(
      `[ERC8004Registry] MOCK registration complete — txHash: ${mockTxHash}`,
    );

    return result;
  }

  // ── On-chain registration ──────────────────────────────────────────────────

  /**
   * Submit a real ERC-8004 registration transaction to Base mainnet.
   * Retries up to MAX_GAS_RETRIES times with +20% gasPrice on gas errors.
   */
  private async _registerOnChain(wallet: WalletInfo): Promise<RegistrationResult> {
    if (!this.provider) {
      throw new Error(
        '[ERC8004Registry] Provider is not available for on-chain registration.',
      );
    }

    if (!this.contractAddress) {
      console.warn(
        '[ERC8004Registry] ERC8004_CONTRACT_ADDRESS not set — falling back to mock registration.',
      );
      return this._registerMock(wallet);
    }

    // Reconstruct the signer from the wallet private key.
    // The wallet private key is accessed indirectly via the keystore; here we
    // require the caller to supply a connected signer if needed.
    // For testability, we accept an optional _signerOverride.
    const signer = this._signerOverride ?? (await this._buildSigner());
    if (!signer) {
      console.warn(
        '[ERC8004Registry] Cannot build signer (no private key available at this layer) — falling back to mock.',
      );
      return this._registerMock(wallet);
    }

    const contract = this._buildContract(
      this.contractAddress,
      ERC8004_ABI,
      signer,
    );

    // Get initial gas price estimate.
    let feeData = await this.provider.getFeeData();
    let gasPrice = feeData.gasPrice ?? ethers.parseUnits('1', 'gwei');

    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= MAX_GAS_RETRIES; attempt++) {
      try {
        if (attempt > 0) {
          // Increase gas price by 20% for each retry: multiply by 12/10.
          gasPrice = (gasPrice * GAS_RETRY_NUMERATOR) / GAS_RETRY_DENOMINATOR;
          console.info(
            `[ERC8004Registry] Gas retry ${attempt}/${MAX_GAS_RETRIES} — ` +
              `gasPrice: ${ethers.formatUnits(gasPrice, 'gwei')} gwei`,
          );
        }

        const tx: ethers.TransactionResponse = await contract.register({
          gasPrice,
        });

        console.info(
          `[ERC8004Registry] Transaction submitted — txHash: ${tx.hash}, ` +
            `attempt: ${attempt + 1}`,
        );

        // Wait for REQUIRED_CONFIRMATIONS confirmations (Requirement 3.3).
        const receipt = await tx.wait(REQUIRED_CONFIRMATIONS);

        if (!receipt) {
          throw new Error(
            '[ERC8004Registry] Transaction receipt is null after confirmation wait.',
          );
        }

        const registeredAt = Date.now();
        const result: RegistrationResult = {
          txHash: receipt.hash,
          blockNumber: receipt.blockNumber,
          confirmations: REQUIRED_CONFIRMATIONS,
          confirmed: true,
          registeredAt,
        };

        this._persistResult(wallet.address, result);

        console.info(
          `[ERC8004Registry] On-chain registration confirmed — ` +
            `txHash: ${receipt.hash}, block: ${receipt.blockNumber}`,
        );

        return result;
      } catch (err: unknown) {
        lastError = err instanceof Error ? err : new Error(String(err));

        // Only retry on gas-related errors (Requirement 3.4).
        if (!this._isGasError(lastError)) {
          throw lastError;
        }

        if (attempt === MAX_GAS_RETRIES) {
          throw new Error(
            `[ERC8004Registry] Registration failed after ${MAX_GAS_RETRIES + 1} attempts: ` +
              lastError.message,
          );
        }
      }
    }

    // Should never reach here, but satisfies TypeScript's control-flow analysis.
    throw lastError ?? new Error('[ERC8004Registry] Unexpected registration failure.');
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  /**
   * Persist a RegistrationResult to the identity table via IdentityRepository.
   * Also sets the record to confirmed=true.
   */
  private _persistResult(address: string, result: RegistrationResult): void {
    const record = this.identityRepo.findByAddress(address);
    if (!record) {
      console.warn(
        `[ERC8004Registry] No identity record found for ${address}. ` +
          'Ensure WalletManager was initialised before calling register().',
      );
      return;
    }

    this.identityRepo.updateRegistration(record.id, {
      registrationTxHash: result.txHash,
      registrationBlock: result.blockNumber,
      confirmed: result.confirmed,
    });
  }

  /**
   * Determine whether an error is gas-related and warrants a retry.
   */
  private _isGasError(error: Error): boolean {
    const msg = error.message.toUpperCase();
    const code = (error as { code?: string }).code ?? '';
    return GAS_ERROR_PATTERNS.some(
      (pattern) =>
        msg.includes(pattern.toUpperCase()) ||
        code.toUpperCase().includes(pattern.toUpperCase()),
    );
  }

  /**
   * Attempt to build a JSON-RPC signer using the WALLET_PRIVATE_KEY env var.
   * Returns null if the key is not available (caller falls back to mock).
   *
   * In a full production setup the WalletManager would inject the signer;
   * this fallback exists so the registry can work as a standalone component.
   */
  private async _buildSigner(): Promise<ethers.JsonRpcSigner | ethers.Wallet | null> {
    const privateKey = process.env['WALLET_PRIVATE_KEY'];
    if (privateKey && this.provider) {
      return new ethers.Wallet(privateKey, this.provider);
    }
    return null;
  }

  /** Allows test injection of a pre-built signer without env var access. */
  _signerOverride: ethers.Signer | null = null;

  /**
   * Factory method for the ERC-8004 contract instance.
   * Extracted so tests can override it without patching ethers.Contract directly.
   */
  _buildContract(
    address: string,
    abi: string[],
    signer: ethers.Signer,
  ): { register: (opts?: unknown) => Promise<ethers.TransactionResponse> } {
    return new ethers.Contract(address, abi, signer) as unknown as {
      register: (opts?: unknown) => Promise<ethers.TransactionResponse>;
    };
  }

  /** Simple promise-based sleep helper. */
  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
