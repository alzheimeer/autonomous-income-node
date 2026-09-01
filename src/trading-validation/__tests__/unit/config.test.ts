/**
 * Unit tests for Trading Validation Config Module
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  loadConfig,
  computeConfigHash,
  validateConfig,
  isValidChecksumAddress,
} from '../../config.js';

describe('config module', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    // Reset env vars for each test
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('loadConfig()', () => {
    it('loads default configuration without env vars', () => {
      const config = loadConfig();

      expect(config.mode).toBe('shadow');
      expect(config.configHash).toBeTruthy();
      expect(config.configHash.length).toBe(64); // SHA-256 hex
    });

    it('loads correct default bankroll values', () => {
      const config = loadConfig();

      expect(config.bankroll.initialTotal).toBe(99_630000n);
      expect(config.bankroll.initialActive).toBe(25_000000n);
      expect(config.bankroll.initialReserve).toBe(74_630000n);
      expect(config.bankroll.minActive).toBe(5_000000n);
      expect(config.bankroll.sweepThresholdPct).toBe(0.20);
      expect(config.bankroll.sweepMinExcess).toBe(5_000000n);
      expect(config.bankroll.lowTotalThreshold).toBe(80_000000n);
    });

    it('loads correct default risk values', () => {
      const config = loadConfig();

      expect(config.risk.maxTradeUsdc).toBe(15_000000n);
      expect(config.risk.maxExposureUsdc).toBe(35_000000n);
      expect(config.risk.maxPositions).toBe(1);
      expect(config.risk.maxTradesDay).toBe(5);
      expect(config.risk.maxFailedTxDay).toBe(3);
      expect(config.risk.maxDailyLossUsdc).toBe(5_000000n);
      expect(config.risk.maxExperimentLoss).toBe(15_000000n);
    });

    it('loads correct default gate values', () => {
      const config = loadConfig();

      expect(config.gate.minNetProfitUsdc).toBe(80000n); // $0.08
      expect(config.gate.minNetProfitBps).toBe(50);
      expect(config.gate.safetyMarginBps).toBe(20);
      expect(config.gate.maxQuoteAgeMs).toBe(10_000);
      expect(config.gate.sanityMaxProfitPct).toBe(0.50);
      expect(config.gate.discretionaryMaxGas).toBe(50000n); // $0.05
      expect(config.gate.minLiquidity).toBe(50_000);
    });

    it('applies stricter limits without private RPC (default)', () => {
      const config = loadConfig();

      // Without private RPC (default), slippage = 30 bps, impact = 20 bps
      expect(config.gate.hasPrivateRpc).toBe(false);
      expect(config.gate.maxSlippageBps).toBe(30);
      expect(config.gate.maxPriceImpactBps).toBe(20);
    });

    it('applies standard limits with private RPC', () => {
      process.env.TRADING_HAS_PRIVATE_RPC = 'true';
      const config = loadConfig();

      expect(config.gate.hasPrivateRpc).toBe(true);
      expect(config.gate.maxSlippageBps).toBe(40);
      expect(config.gate.maxPriceImpactBps).toBe(30);
    });

    it('loads correct default strategy values', () => {
      const config = loadConfig();

      expect(config.strategy.pair).toBe('WETH/USDC');
      expect(config.strategy.regimeTimeframe).toBe('1h');
      expect(config.strategy.entryTimeframe).toBe('15m');
      expect(config.strategy.stopLossAtr).toBe(1.8);
      expect(config.strategy.takeProfitAtr).toBe(2.5);
      expect(config.strategy.cooldownMs).toBe(1_800_000);
      expect(config.strategy.warmup1h).toBe(100);
      expect(config.strategy.warmup15m).toBe(200);
      expect(config.strategy.meanRevAtrMax).toBe(2.0);
      expect(config.strategy.volumeZThreshold).toBe(0.5);
    });

    it('loads correct default contract addresses (Base mainnet)', () => {
      const config = loadConfig();

      expect(config.contracts.usdc).toBe('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913');
      expect(config.contracts.weth).toBe('0x4200000000000000000000000000000000000006');
      expect(config.contracts.swapRouter).toBe('0x2626664c2603336E57B271c5C0b26F421741e481');
      expect(config.contracts.quoterV2).toBe('0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a');
      expect(config.contracts.aavePool).toBe('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5');
      expect(config.contracts.aUsdc).toBe('0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB');
    });

    it('builds allowlist from all known contracts', () => {
      const config = loadConfig();

      expect(config.contracts.allowlist).toContain(config.contracts.usdc);
      expect(config.contracts.allowlist).toContain(config.contracts.weth);
      expect(config.contracts.allowlist).toContain(config.contracts.swapRouter);
      expect(config.contracts.allowlist).toContain(config.contracts.quoterV2);
      expect(config.contracts.allowlist).toContain(config.contracts.aavePool);
      expect(config.contracts.allowlist).toContain(config.contracts.aUsdc);
    });

    it('loads correct default gas reserve values', () => {
      const config = loadConfig();

      expect(config.gasReserve.minReserveEth).toBe(5_000_000_000_000_000n); // 0.005 ETH
      expect(config.gasReserve.criticalReserveEth).toBe(2_000_000_000_000_000n); // 0.002 ETH
      expect(config.gasReserve.cyclesRequired).toBe(2);
    });

    it('loads correct default position sizer values', () => {
      const config = loadConfig();

      expect(config.positionSizer.maxRiskPerTrade).toBe(500000n); // $0.50
      expect(config.positionSizer.maxRiskPctBankroll).toBe(0.005);
      expect(config.positionSizer.minTradeSize).toBe(5_000000n); // $5
      expect(config.positionSizer.maxTradeSize).toBe(10_000000n); // $10
      expect(config.positionSizer.minStopFraction).toBe(0.001);
    });

    it('loads correct default exit manager values', () => {
      const config = loadConfig();

      expect(config.exitManager.stopLossAtr).toBe(1.8);
      expect(config.exitManager.takeProfitAtr).toBe(2.5);
      expect(config.exitManager.maxHoldingMs).toBe(28_800_000); // 8h
      expect(config.exitManager.safetyExitMaxGas).toBe(100000n); // $0.10
      expect(config.exitManager.maxExitRetries).toBe(2);
    });

    it('loads correct default AI budget values', () => {
      const config = loadConfig();

      expect(config.aiBudget.globalHardCapDay).toBe(0.20);
      expect(config.aiBudget.tradingBudgetDay).toBe(0.10);
      expect(config.aiBudget.servicesBudgetDay).toBe(0.05);
      expect(config.aiBudget.researchBudgetDay).toBe(0.00);
      expect(config.aiBudget.diagnosticsBudgetDay).toBe(0.02);
      expect(config.aiBudget.sonnetMinProfit).toBe(150000n); // $0.15
    });

    it('loads correct default experiment values', () => {
      const config = loadConfig();

      expect(config.experiment.shadowPassMinTrades).toBe(10);
      expect(config.experiment.shadowPassTargetTrades).toBe(20);
      expect(config.experiment.shadowPassDays).toBe(7);
      expect(config.experiment.microPassMinTrades).toBe(20);
      expect(config.experiment.microPassProfitFactor).toBe(1.2);
      expect(config.experiment.microPassMaxDrawdown).toBe(10_000000n);
      expect(config.experiment.microPassMaxFailedRate).toBe(0.10);
      expect(config.experiment.microPassMaxSlippageDev).toBe(1.5);
    });

    it('loads correct default reconciliation values', () => {
      const config = loadConfig();

      expect(config.reconciliation.confirmationBlocks).toBe(1);
      expect(config.reconciliation.maxRetries).toBe(3);
      expect(config.reconciliation.retryBackoffMs).toBe(1000);
      expect(config.reconciliation.mismatchesForKillSwitch).toBe(3);
    });

    it('loads correct default market data values', () => {
      const config = loadConfig();

      expect(config.marketData.restPollingMs).toBe(10_000);
      expect(config.marketData.staleThresholdMs).toBe(90_000);
      expect(config.marketData.priceMoveTriggerAtrPct).toBe(0.35);
      expect(config.marketData.volumeZTrigger).toBe(1.5);
      expect(config.marketData.maxEvalPerHour).toBe(30);
      expect(config.marketData.debounceMs).toBe(30_000);
    });

    it('overrides defaults with env vars', () => {
      process.env.TRADING_MODE = 'micro';
      process.env.TRADING_BANKROLL_TOTAL = '50000000';
      process.env.TRADING_RISK_MAX_TRADES_DAY = '5';

      const config = loadConfig();

      expect(config.mode).toBe('micro');
      expect(config.bankroll.initialTotal).toBe(50_000000n);
      expect(config.risk.maxTradesDay).toBe(5);
    });

    it('includes aggregator router in allowlist when configured', () => {
      process.env.TRADING_AGGREGATOR_ROUTER = '0x1111111254EEB25477B68fb85Ed929f73A960582';
      const config = loadConfig();

      expect(config.contracts.allowlist).toContain('0x1111111254EEB25477B68fb85Ed929f73A960582');
      expect(config.quoteEngine.aggregatorRouter).toBe('0x1111111254EEB25477B68fb85Ed929f73A960582');
    });

    it('omits aggregator router from allowlist when not configured', () => {
      const config = loadConfig();

      expect(config.quoteEngine.aggregatorRouter).toBeUndefined();
      // allowlist should have 6 entries (the known contracts)
      expect(config.contracts.allowlist.length).toBe(6);
    });
  });

  describe('computeConfigHash()', () => {
    it('returns 64-char hex SHA-256', () => {
      const config = loadConfig();
      const hash = computeConfigHash(config);

      expect(hash).toMatch(/^[a-f0-9]{64}$/);
    });

    it('is deterministic for same config', () => {
      const config = loadConfig();
      const hash1 = computeConfigHash(config);
      const hash2 = computeConfigHash(config);

      expect(hash1).toBe(hash2);
    });

    it('changes when config parameter changes', () => {
      const config1 = loadConfig();
      const hash1 = computeConfigHash(config1);

      process.env.TRADING_RISK_MAX_TRADES_DAY = '10'; // Using 10 to guarantee a change from defaults
      const config2 = loadConfig();
      const hash2 = computeConfigHash(config2);

      expect(hash1).not.toBe(hash2);
    });

    it('config hash is set in both config.configHash and config.experiment.configHash', () => {
      const config = loadConfig();

      expect(config.configHash).toBeTruthy();
      expect(config.experiment.configHash).toBe(config.configHash);
    });
  });

  describe('isValidChecksumAddress()', () => {
    it('validates correct EIP-55 checksummed addresses', () => {
      // Known Base mainnet addresses
      expect(isValidChecksumAddress('0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(true);
      expect(isValidChecksumAddress('0x4200000000000000000000000000000000000006')).toBe(true);
      expect(isValidChecksumAddress('0x2626664c2603336E57B271c5C0b26F421741e481')).toBe(true);
      expect(isValidChecksumAddress('0x3d4e44Eb1374240CE5F1B871ab261CD16335B76a')).toBe(true);
      expect(isValidChecksumAddress('0xA238Dd80C259a72e81d7e4664a9801593F98d1c5')).toBe(true);
      expect(isValidChecksumAddress('0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB')).toBe(true);
    });

    it('rejects incorrectly checksummed addresses', () => {
      // Flip case on a letter that should be specific case
      expect(isValidChecksumAddress('0x833589FCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(false);
    });

    it('rejects all-lowercase (non-checksummed)', () => {
      expect(isValidChecksumAddress('0x833589fcd6edb6e08f4c7c32d4f71b54bda02913')).toBe(false);
    });

    it('rejects invalid format', () => {
      expect(isValidChecksumAddress('not-an-address')).toBe(false);
      expect(isValidChecksumAddress('0x123')).toBe(false);
      expect(isValidChecksumAddress('')).toBe(false);
    });

    it('rejects addresses without 0x prefix', () => {
      expect(isValidChecksumAddress('833589fCD6eDb6E08f4c7C32D4f71b54bdA02913')).toBe(false);
    });
  });

  describe('validateConfig()', () => {
    it('returns no errors for valid default config', () => {
      const config = loadConfig();
      const errors = validateConfig(config);

      expect(errors).toHaveLength(0);
    });

    it('catches invalid mode', () => {
      const config = loadConfig();
      (config as { mode: string }).mode = 'invalid';
      const errors = validateConfig(config);

      expect(errors.some((e) => e.field === 'mode')).toBe(true);
    });

    it('catches invalid contract addresses', () => {
      const config = loadConfig();
      config.contracts.usdc = '0xinvalid';
      const errors = validateConfig(config);

      expect(errors.some((e) => e.field === 'contracts.usdc')).toBe(true);
    });

    it('catches bankroll active > total', () => {
      const config = loadConfig();
      config.bankroll.initialActive = 200_000000n;
      config.bankroll.initialTotal = 100_000000n;
      const errors = validateConfig(config);

      expect(errors.some((e) => e.field === 'bankroll.initialActive')).toBe(true);
    });

    it('catches position sizer min >= max', () => {
      const config = loadConfig();
      config.positionSizer.minTradeSize = 15_000000n;
      config.positionSizer.maxTradeSize = 10_000000n;
      const errors = validateConfig(config);

      expect(errors.some((e) => e.field === 'positionSizer.minTradeSize')).toBe(true);
    });

    it('catches gas reserve critical >= min', () => {
      const config = loadConfig();
      config.gasReserve.criticalReserveEth = 10_000_000_000_000_000n;
      config.gasReserve.minReserveEth = 5_000_000_000_000_000n;
      const errors = validateConfig(config);

      expect(errors.some((e) => e.field === 'gasReserve.criticalReserveEth')).toBe(true);
    });

    it('catches missing wallet address in micro mode', () => {
      process.env.TRADING_MODE = 'micro';
      process.env.TRADING_WALLET_ADDRESS = '';
      const config = loadConfig();
      const errors = validateConfig(config);

      expect(errors.some((e) => e.field === 'txManager.walletAddress')).toBe(true);
    });

    it('catches AI trading budget exceeding global cap', () => {
      const config = loadConfig();
      config.aiBudget.tradingBudgetDay = 0.50;
      config.aiBudget.globalHardCapDay = 0.20;
      const errors = validateConfig(config);

      expect(errors.some((e) => e.field === 'aiBudget.tradingBudgetDay')).toBe(true);
    });
  });
});
