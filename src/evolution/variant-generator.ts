/**
 * Strategy Evolution Lab — Variant Generator
 *
 * Generates parameter variants from a parent strategy based on diagnosed weaknesses.
 * Uses archetype presets matched to diagnosis codes, then fills remaining slots
 * with random grid mutations.
 *
 * Invariants:
 *   - Max 20 variants per generation cycle
 *   - Max 3 parameter mutations per variant
 *   - All parameter values within PARAMETER_GRID bounds
 *   - Each variant registered as CANDIDATE with parent_id and config_hash
 *   - Each variant tagged with motivating diagnosis code
 *   - Duplicate config_hash values are skipped
 *
 * Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6
 */

import { randomUUID } from 'node:crypto';
import { EvolutionDatabase } from './evolution-database.js';
import { StrategyRegistry } from './strategy-registry.js';
import type { StrategyRecord, StrategyParameters, DiagnosisCode } from './types.js';

// ─── DiagnosisResult interface (defined locally to avoid circular dependency) ─
// This matches the structure that diagnosis-engine.ts will export.
export interface DiagnosisResult {
  code: DiagnosisCode;
  confidence: number;
  description: string;
  suggested_adjustments: Partial<StrategyParameters>;
}

// ─── Parameter Grid ─────────────────────────────────────────────────────────

export const PARAMETER_GRID = {
  stop_atr: [1.0, 1.5, 2.0, 2.5],
  tp_atr: [2.0, 2.5, 3.0, 3.5, 4.0],
  rsi_trend_low: [30, 35, 40],
  rsi_trend_high: [45, 50, 55, 60],
  rsi_reversion: [25, 28, 30, 32, 35],
  volumeZ: [0.8, 1.0, 1.2, 1.5],
  trade_size: ['$10', '$15', '$20', '$25'],
} as const;

// ─── Archetype Presets ──────────────────────────────────────────────────────

export const ARCHETYPE_PRESETS: Record<string, Partial<StrategyParameters>> = {
  wider_stops: { stop_atr: 2.0, tp_atr: 3.0 },
  bigger_trades: { trade_size: '$20', tp_atr: 2.5 },
  relaxed_gates: { volumeZ: 0.8, rsi_trend: [30, 55] },
  aggressive_tp: { tp_atr: 4.0, stop_atr: 2.0 },
  balanced: { stop_atr: 2.0, tp_atr: 3.0, trade_size: '$15' },
};

// ─── Diagnosis → Archetype Mapping ─────────────────────────────────────────

const DIAGNOSIS_TO_ARCHETYPE: Record<DiagnosisCode, string[]> = {
  COST_DOMINATED: ['wider_stops', 'bigger_trades'],
  COSTS_KILL_EDGE: ['aggressive_tp', 'wider_stops'],
  TP_TOO_SMALL: ['aggressive_tp', 'wider_stops'],
  SL_TOO_TIGHT: ['wider_stops', 'balanced'],
  TOO_FEW_SIGNALS: ['relaxed_gates'],
  GATE_TOO_STRICT: ['relaxed_gates'],
  RISK_OK_STRATEGY_WEAK: ['balanced', 'aggressive_tp'],
  REGIME_NO_OPPORTUNITY: [], // no preset — regime-dependent issue
};

// ─── Variant Generator ──────────────────────────────────────────────────────

export class VariantGenerator {
  private registry: StrategyRegistry;

  constructor(private db: EvolutionDatabase) {
    this.registry = new StrategyRegistry(db);
  }

  /**
   * Generate variants based on parent strategy and diagnosed weaknesses.
   *
   * Algorithm:
   * 1. First, generate archetype-based variants matching the diagnoses
   * 2. Then, generate random grid mutations to fill remaining slots
   * 3. Enforce max 20 variants total and max 3 mutations per variant
   * 4. Register each in the database with status CANDIDATE
   *
   * Returns the created StrategyRecord[] for the variants.
   */
  generate(
    parent: StrategyRecord,
    diagnoses: DiagnosisResult[],
    maxVariants: number = 20,
  ): StrategyRecord[] {
    // Clamp maxVariants to absolute maximum of 20
    const effectiveMax = Math.min(maxVariants, 20);
    const variants: StrategyRecord[] = [];
    const seenHashes = new Set<string>([parent.config_hash]);

    // Phase 1: Archetype-based variants from diagnoses
    for (const diagnosis of diagnoses) {
      if (variants.length >= effectiveMax) break;

      const archetypeNames = DIAGNOSIS_TO_ARCHETYPE[diagnosis.code] ?? [];
      for (const archetypeName of archetypeNames) {
        if (variants.length >= effectiveMax) break;

        const preset = ARCHETYPE_PRESETS[archetypeName];
        if (!preset) continue;

        const newParams = this.applyPreset(parent.parameters, preset);
        const hash = this.registry.computeConfigHash(newParams);

        // Skip duplicates
        if (seenHashes.has(hash)) continue;
        seenHashes.add(hash);

        // Verify max 3 mutations
        if (this.countMutations(parent.parameters, newParams) > 3) continue;

        const record = this.createVariantRecord(
          parent, newParams, hash,
          [diagnosis.code, archetypeName],
        );
        this.db.insertStrategy(record);
        variants.push(this.toFullRecord(record));
      }
    }

    // Phase 2: Random grid mutations to fill remaining slots
    const remaining = effectiveMax - variants.length;
    if (remaining > 0) {
      const gridVariants = this.generateGridMutations(parent, seenHashes, remaining);
      for (const v of gridVariants) {
        const tag = diagnoses.length > 0 ? diagnoses[0].code : 'RISK_OK_STRATEGY_WEAK';
        const record = this.createVariantRecord(parent, v.params, v.hash, [tag, 'grid_mutation']);
        this.db.insertStrategy(record);
        variants.push(this.toFullRecord(record));
      }
    }

    return variants;
  }

  /**
   * Apply a preset to base parameters, merging over the base values.
   */
  private applyPreset(base: StrategyParameters, preset: Partial<StrategyParameters>): StrategyParameters {
    return { ...base, ...preset };
  }

  /**
   * Count the number of parameters that differ between original and modified.
   * RSI trend counts as a single parameter (both low and high together).
   */
  private countMutations(original: StrategyParameters, modified: StrategyParameters): number {
    let count = 0;
    if (original.stop_atr !== modified.stop_atr) count++;
    if (original.tp_atr !== modified.tp_atr) count++;
    if (original.rsi_trend[0] !== modified.rsi_trend[0] || original.rsi_trend[1] !== modified.rsi_trend[1]) count++;
    if (original.rsi_reversion !== modified.rsi_reversion) count++;
    if (original.volumeZ !== modified.volumeZ) count++;
    if (original.trade_size !== modified.trade_size) count++;
    if (original.entry_tf !== modified.entry_tf) count++;
    if (original.regime_tf !== modified.regime_tf) count++;
    return count;
  }

  /**
   * Create a variant record with all required fields for database insertion.
   */
  private createVariantRecord(
    parent: StrategyRecord,
    params: StrategyParameters,
    hash: string,
    tags: string[],
  ): Omit<StrategyRecord, 'created_at' | 'updated_at'> {
    return {
      strategy_id: randomUUID(),
      parent_id: parent.strategy_id,
      status: 'CANDIDATE',
      config_hash: hash,
      parameters: params,
      tags,
      best_regime: parent.best_regime,
      evidence: {},
      notes: `Variant of ${parent.strategy_id}`,
      archived_reason: '',
      revival_rules: null,
    };
  }

  /**
   * Convert a partial record (without timestamps) to a full StrategyRecord.
   * The actual timestamps are set by the database on insert.
   */
  private toFullRecord(record: Omit<StrategyRecord, 'created_at' | 'updated_at'>): StrategyRecord {
    return {
      ...record,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as StrategyRecord;
  }

  /**
   * Generate random grid mutations by picking 1-3 parameters and choosing
   * different values from the PARAMETER_GRID.
   */
  private generateGridMutations(
    parent: StrategyRecord,
    seenHashes: Set<string>,
    maxCount: number,
  ): { params: StrategyParameters; hash: string }[] {
    const results: { params: StrategyParameters; hash: string }[] = [];

    const paramKeys: (keyof typeof PARAMETER_GRID)[] = [
      'stop_atr', 'tp_atr', 'rsi_trend_low', 'rsi_trend_high',
      'rsi_reversion', 'volumeZ', 'trade_size',
    ];

    // Generate combinations by mutating 1-3 parameters from the grid
    for (let mutations = 1; mutations <= 3 && results.length < maxCount; mutations++) {
      for (let i = 0; i < paramKeys.length && results.length < maxCount; i++) {
        for (let j = i; j < (mutations >= 2 ? paramKeys.length : i + 1) && results.length < maxCount; j++) {
          const keys = this.selectMutationKeys(paramKeys, mutations, i, j);

          const newParams = { ...parent.parameters, rsi_trend: [...parent.parameters.rsi_trend] as [number, number] };
          let validMutation = true;

          for (const key of keys) {
            const gridValues = PARAMETER_GRID[key];
            const currentVal = this.getParamValue(parent.parameters, key);
            const candidates = (gridValues as readonly (number | string)[]).filter(
              (v) => v !== currentVal,
            );
            if (candidates.length === 0) {
              validMutation = false;
              break;
            }
            const picked = candidates[Math.floor(Math.random() * candidates.length)];
            this.setParamValue(newParams, key, picked);
          }

          if (!validMutation) continue;

          const hash = this.registry.computeConfigHash(newParams);
          if (seenHashes.has(hash)) continue;
          seenHashes.add(hash);

          results.push({ params: newParams, hash });
        }
      }
    }

    return results;
  }

  /**
   * Select the keys to mutate based on the mutation level and indices.
   */
  private selectMutationKeys(
    paramKeys: (keyof typeof PARAMETER_GRID)[],
    mutations: number,
    i: number,
    j: number,
  ): (keyof typeof PARAMETER_GRID)[] {
    if (mutations === 1) return [paramKeys[i]];
    if (mutations === 2) return [paramKeys[i], paramKeys[j]];
    // mutations === 3: pick a third key after j
    const thirdIdx = Math.min(j + 1, paramKeys.length - 1);
    // Avoid duplicate keys
    if (thirdIdx === i || thirdIdx === j) {
      return [paramKeys[i], paramKeys[j]];
    }
    return [paramKeys[i], paramKeys[j], paramKeys[thirdIdx]];
  }

  /**
   * Get the current value of a parameter from a StrategyParameters object,
   * mapped to the PARAMETER_GRID key name.
   */
  private getParamValue(params: StrategyParameters, key: keyof typeof PARAMETER_GRID): number | string {
    switch (key) {
      case 'stop_atr': return params.stop_atr;
      case 'tp_atr': return params.tp_atr;
      case 'rsi_trend_low': return params.rsi_trend[0];
      case 'rsi_trend_high': return params.rsi_trend[1];
      case 'rsi_reversion': return params.rsi_reversion;
      case 'volumeZ': return params.volumeZ;
      case 'trade_size': return params.trade_size;
    }
  }

  /**
   * Set a parameter value on a StrategyParameters object,
   * mapping the PARAMETER_GRID key name to the actual property.
   */
  private setParamValue(params: StrategyParameters, key: keyof typeof PARAMETER_GRID, value: number | string): void {
    switch (key) {
      case 'stop_atr': params.stop_atr = value as number; break;
      case 'tp_atr': params.tp_atr = value as number; break;
      case 'rsi_trend_low': params.rsi_trend = [value as number, params.rsi_trend[1]]; break;
      case 'rsi_trend_high': params.rsi_trend = [params.rsi_trend[0], value as number]; break;
      case 'rsi_reversion': params.rsi_reversion = value as number; break;
      case 'volumeZ': params.volumeZ = value as number; break;
      case 'trade_size': params.trade_size = value as string; break;
    }
  }
}
