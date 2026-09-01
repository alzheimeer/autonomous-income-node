/**
 * Property-Based Tests para SmartMoneyCurator - Tier Assignment
 *
 * Este archivo contiene tests que verifican propiedades invariantes del sistema
 * de clasificación de wallets y asignación de tiers usando fast-check.
 *
 * Propiedades testeadas según design.md:
 * 1. Determinismo: mismo input → mismo tier
 * 2. Consistencia de ranking: scores más altos → tiers iguales o mejores
 * 3. Validez de tiers: siempre S_TIER, A_TIER, o B_TIER
 * 4. Score consistente con fórmula: winRate × profitFactor × sharpeRatio
 *
 * **Validates: Requirements 1.12**
 */

import { describe, it, expect, beforeEach } from "vitest";
import fc from "fast-check";
import {
  SmartMoneyCurator,
  ExtendedWalletMetrics,
  TierAssignmentResult,
} from "../modules/SmartMoneyCurator.js";
import type { WalletTier } from "../interfaces/types.js";

// ═══════════════════════════════════════════════════════════════════════════════
// ARBITRARIES - Generadores de datos para property-based testing
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Arbitrary para generar ExtendedWalletMetrics válidas.
 * Valores constrained a rangos realistas para trading.
 */
const extendedWalletMetricsArbitrary = fc.record({
  winRate: fc.double({ min: 0, max: 1, noNaN: true }),
  totalPnlUsdc: fc.double({ min: -1000000, max: 10000000, noNaN: true }),
  tradeCount: fc.integer({ min: 0, max: 10000 }),
  avgHoldingTimeSec: fc.integer({ min: 0, max: 7 * 24 * 60 * 60 }), // Max 7 days
  volumeUsdc: fc.double({ min: 0, max: 100000000, noNaN: true }),
  sharpeRatio: fc.double({ min: -10, max: 20, noNaN: true }),
  profitFactor: fc.double({ min: 0, max: 100, noNaN: true }),
});

/**
 * Arbitrary para generar métricas con valores estrictamente positivos
 * para asegurar scores positivos.
 */
const positiveMetricsArbitrary = fc.record({
  winRate: fc.double({ min: 0.01, max: 1, noNaN: true }),
  totalPnlUsdc: fc.double({ min: 0, max: 10000000, noNaN: true }),
  tradeCount: fc.integer({ min: 1, max: 10000 }),
  avgHoldingTimeSec: fc.integer({ min: 900, max: 604800 }),
  volumeUsdc: fc.double({ min: 0, max: 100000000, noNaN: true }),
  sharpeRatio: fc.double({ min: 0.1, max: 20, noNaN: true }),
  profitFactor: fc.double({ min: 0.1, max: 100, noNaN: true }),
});


/**
 * Arbitrary para generar un wallet con address y metrics.
 */
const walletWithMetricsArbitrary = fc
  .tuple(
    fc.hexaString({ minLength: 40, maxLength: 40 }).map((s) => `0x${s}`),
    extendedWalletMetricsArbitrary
  )
  .map(([address, metrics]) => ({ address, metrics }));

/**
 * Arbitrary para ranks válidos (1-50).
 */
const validRankArbitrary = fc.integer({ min: 1, max: 50 });

/**
 * Arbitrary para ranks inválidos (fuera de 1-50).
 */
const invalidRankArbitrary = fc.oneof(
  fc.integer({ min: -1000, max: 0 }),
  fc.integer({ min: 51, max: 1000 })
);

// ═══════════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe("SmartMoneyCurator - Property-Based Tests", () => {
  let curator: SmartMoneyCurator;

  beforeEach(() => {
    curator = new SmartMoneyCurator();
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // PROPIEDADES DEL CÁLCULO DE SCORE
  // Formula: score = winRate × profitFactor × sharpeRatio
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Propiedades del cálculo de Score", () => {
    it("PROP: El score es determinístico - mismas métricas producen mismo score", () => {
      /**
       * **Validates: Requirements 1.12**
       * Property 4: Tier Assignment Determinism
       */
      fc.assert(
        fc.property(extendedWalletMetricsArbitrary, (metrics) => {
          const score1 = curator.calculateWalletScore(metrics);
          const score2 = curator.calculateWalletScore(metrics);
          return score1 === score2;
        }),
        { numRuns: 300 }
      );
    });


    it("PROP: El score sigue la fórmula winRate × profitFactor × sharpeRatio", () => {
      /**
       * **Validates: Requirements 1.12**
       * Verifica que el cálculo de score sea consistente con la fórmula documentada.
       */
      fc.assert(
        fc.property(extendedWalletMetricsArbitrary, (metrics) => {
          const calculatedScore = curator.calculateWalletScore(metrics);
          const expectedScore = metrics.winRate * metrics.profitFactor * metrics.sharpeRatio;
          // Usar tolerancia para floating point
          return Math.abs(calculatedScore - expectedScore) < 1e-10;
        }),
        { numRuns: 300 }
      );
    });

    it("PROP: Score con métricas positivas no es NaN", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      fc.assert(
        fc.property(positiveMetricsArbitrary, (metrics) => {
          const score = curator.calculateWalletScore(metrics);
          return !Number.isNaN(score);
        }),
        { numRuns: 300 }
      );
    });

    it("PROP: Mayor winRate (con otras métricas constantes) resulta en score >= al anterior", () => {
      /**
       * **Validates: Requirements 1.12**
       * Monotonía: winRate más alto debería producir score más alto (o igual).
       */
      fc.assert(
        fc.property(
          positiveMetricsArbitrary,
          fc.double({ min: 0, max: 0.5, noNaN: true }),
          (baseMetrics, delta) => {
            if (baseMetrics.winRate + delta > 1) return true; // Skip invalid cases

            const metricsLow = { ...baseMetrics };
            const metricsHigh = {
              ...baseMetrics,
              winRate: baseMetrics.winRate + delta,
            };

            const scoreLow = curator.calculateWalletScore(metricsLow);
            const scoreHigh = curator.calculateWalletScore(metricsHigh);

            return scoreHigh >= scoreLow;
          }
        ),
        { numRuns: 300 }
      );
    });


    it("PROP: Mayor profitFactor resulta en score >= al anterior", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      fc.assert(
        fc.property(
          positiveMetricsArbitrary,
          fc.double({ min: 0, max: 10, noNaN: true }),
          (baseMetrics, delta) => {
            const metricsLow = { ...baseMetrics };
            const metricsHigh = {
              ...baseMetrics,
              profitFactor: baseMetrics.profitFactor + delta,
            };

            const scoreLow = curator.calculateWalletScore(metricsLow);
            const scoreHigh = curator.calculateWalletScore(metricsHigh);

            return scoreHigh >= scoreLow;
          }
        ),
        { numRuns: 300 }
      );
    });

    it("PROP: Mayor sharpeRatio resulta en score >= al anterior", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      fc.assert(
        fc.property(
          positiveMetricsArbitrary,
          fc.double({ min: 0, max: 5, noNaN: true }),
          (baseMetrics, delta) => {
            const metricsLow = { ...baseMetrics };
            const metricsHigh = {
              ...baseMetrics,
              sharpeRatio: baseMetrics.sharpeRatio + delta,
            };

            const scoreLow = curator.calculateWalletScore(metricsLow);
            const scoreHigh = curator.calculateWalletScore(metricsHigh);

            return scoreHigh >= scoreLow;
          }
        ),
        { numRuns: 300 }
      );
    });
  });


  // ═══════════════════════════════════════════════════════════════════════════
  // PROPIEDADES DE ASIGNACIÓN DE TIER POR RANK
  // Ranks: 1-5 → S_TIER, 6-15 → A_TIER, 16-50 → B_TIER
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Propiedades de asignación de Tier por Rank", () => {
    it("PROP: El tier asignado siempre es válido (S_TIER, A_TIER, B_TIER)", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      const validTiers: WalletTier[] = ["S_TIER", "A_TIER", "B_TIER"];

      fc.assert(
        fc.property(validRankArbitrary, (rank) => {
          const tier = curator.assignTier(rank);
          return validTiers.includes(tier);
        }),
        { numRuns: 200 }
      );
    });

    it("PROP: La asignación de tier es determinística por rank", () => {
      /**
       * **Validates: Requirements 1.12**
       * Property 4: Tier Assignment Determinism
       */
      fc.assert(
        fc.property(validRankArbitrary, (rank) => {
          const tier1 = curator.assignTier(rank);
          const tier2 = curator.assignTier(rank);
          return tier1 === tier2;
        }),
        { numRuns: 200 }
      );
    });

    it("PROP: Ranks 1-5 siempre resultan en S_TIER", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 5 }), (rank) => {
          const tier = curator.assignTier(rank);
          return tier === "S_TIER";
        }),
        { numRuns: 50 }
      );
    });

    it("PROP: Ranks 6-15 siempre resultan en A_TIER", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      fc.assert(
        fc.property(fc.integer({ min: 6, max: 15 }), (rank) => {
          const tier = curator.assignTier(rank);
          return tier === "A_TIER";
        }),
        { numRuns: 50 }
      );
    });


    it("PROP: Ranks 16-50 siempre resultan en B_TIER", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      fc.assert(
        fc.property(fc.integer({ min: 16, max: 50 }), (rank) => {
          const tier = curator.assignTier(rank);
          return tier === "B_TIER";
        }),
        { numRuns: 50 }
      );
    });

    it("PROP: Rank más bajo resulta en tier igual o mejor", () => {
      /**
       * **Validates: Requirements 1.12**
       * Property: Rank ordering implies tier ordering.
       */
      const tierOrder: Record<WalletTier, number> = {
        S_TIER: 0,
        A_TIER: 1,
        B_TIER: 2,
      };

      fc.assert(
        fc.property(validRankArbitrary, validRankArbitrary, (rank1, rank2) => {
          const tier1 = curator.assignTier(rank1);
          const tier2 = curator.assignTier(rank2);

          if (rank1 < rank2) {
            return tierOrder[tier1] <= tierOrder[tier2];
          } else if (rank2 < rank1) {
            return tierOrder[tier2] <= tierOrder[tier1];
          }
          return tier1 === tier2;
        }),
        { numRuns: 300 }
      );
    });

    it("PROP: Ranks inválidos (< 1 o > 50) lanzan error", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      fc.assert(
        fc.property(invalidRankArbitrary, (rank) => {
          try {
            curator.assignTier(rank);
            return false; // Should have thrown
          } catch (e) {
            return e instanceof Error && e.message.includes("out of bounds");
          }
        }),
        { numRuns: 100 }
      );
    });

    it("PROP: Los bordes de tier están correctamente definidos", () => {
      /**
       * **Validates: Requirements 1.12**
       * Tests exactos en los bordes de tier.
       */
      // S_TIER boundaries
      expect(curator.assignTier(1)).toBe("S_TIER");
      expect(curator.assignTier(5)).toBe("S_TIER");

      // A_TIER boundaries
      expect(curator.assignTier(6)).toBe("A_TIER");
      expect(curator.assignTier(15)).toBe("A_TIER");

      // B_TIER boundaries
      expect(curator.assignTier(16)).toBe("B_TIER");
      expect(curator.assignTier(50)).toBe("B_TIER");
    });
  });


  // ═══════════════════════════════════════════════════════════════════════════
  // PROPIEDADES DE ASIGNACIÓN MASIVA DE TIERS
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Propiedades de asignación masiva de Tiers", () => {
    it("PROP: assignTiers mantiene la cantidad de wallets", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      fc.assert(
        fc.property(
          fc.array(walletWithMetricsArbitrary, { minLength: 0, maxLength: 50 }),
          (wallets) => {
            const result = curator.assignTiers(wallets);
            return result.length === wallets.length;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("PROP: Cada wallet procesada tiene un tier válido", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      const validTiers: WalletTier[] = ["S_TIER", "A_TIER", "B_TIER"];

      fc.assert(
        fc.property(
          fc.array(walletWithMetricsArbitrary, { minLength: 1, maxLength: 50 }),
          (wallets) => {
            const result = curator.assignTiers(wallets);
            return result.every((w) => validTiers.includes(w.tier));
          }
        ),
        { numRuns: 100 }
      );
    });

    it("PROP: Las direcciones de wallet se preservan", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      fc.assert(
        fc.property(
          fc.array(walletWithMetricsArbitrary, { minLength: 1, maxLength: 50 }),
          (wallets) => {
            const result = curator.assignTiers(wallets);
            const originalAddresses = new Set(wallets.map((w) => w.address));
            const resultAddresses = new Set(result.map((w) => w.address));

            return (
              originalAddresses.size === resultAddresses.size &&
              [...originalAddresses].every((addr) => resultAddresses.has(addr))
            );
          }
        ),
        { numRuns: 100 }
      );
    });


    it("PROP: Los resultados están ordenados por score descendente", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      fc.assert(
        fc.property(
          fc.array(walletWithMetricsArbitrary, { minLength: 2, maxLength: 50 }),
          (wallets) => {
            const result = curator.assignTiers(wallets);

            // Verificar que scores están en orden descendente
            for (let i = 1; i < result.length; i++) {
              if (result[i].score > result[i - 1].score) {
                return false;
              }
            }
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("PROP: assignTiers es idempotente", () => {
      /**
       * **Validates: Requirements 1.12**
       * Property 4: Tier Assignment Determinism
       */
      fc.assert(
        fc.property(
          fc.array(walletWithMetricsArbitrary, { minLength: 1, maxLength: 20 }),
          (wallets) => {
            const result1 = curator.assignTiers(wallets);
            const result2 = curator.assignTiers(wallets);

            // Misma longitud
            if (result1.length !== result2.length) return false;

            // Mismo orden y contenido
            for (let i = 0; i < result1.length; i++) {
              if (
                result1[i].address !== result2[i].address ||
                result1[i].tier !== result2[i].tier ||
                result1[i].score !== result2[i].score
              ) {
                return false;
              }
            }
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });

    it("PROP: assignTiers con más de 50 wallets lanza error", () => {
      /**
       * **Validates: Requirements 1.1, 1.12**
       */
      fc.assert(
        fc.property(
          fc.array(walletWithMetricsArbitrary, { minLength: 51, maxLength: 60 }),
          (wallets) => {
            try {
              curator.assignTiers(wallets);
              return false; // Should have thrown
            } catch (e) {
              return e instanceof Error && e.message.includes("Maximum is 50");
            }
          }
        ),
        { numRuns: 20 }
      );
    });

    it("PROP: Lista vacía de wallets retorna lista vacía", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      const result = curator.assignTiers([]);
      expect(result).toEqual([]);
    });
  });


  // ═══════════════════════════════════════════════════════════════════════════
  // INVARIANTES DEL SISTEMA
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Invariantes del sistema", () => {
    it("PROP: Wallets con métricas idénticas obtienen el mismo score", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      fc.assert(
        fc.property(extendedWalletMetricsArbitrary, (metrics) => {
          const score1 = curator.calculateWalletScore(metrics);
          const score2 = curator.calculateWalletScore({ ...metrics });

          return score1 === score2;
        }),
        { numRuns: 200 }
      );
    });

    it("PROP: El proceso de scoring y tier assignment es idempotente end-to-end", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      fc.assert(
        fc.property(
          fc.array(walletWithMetricsArbitrary, { minLength: 1, maxLength: 30 }),
          (wallets) => {
            const result1 = curator.assignTiers(wallets);

            // Re-crear wallets desde los resultados y volver a asignar
            const walletsFromResult = result1.map((r) => ({
              address: r.address,
              metrics: wallets.find((w) => w.address === r.address)!.metrics,
            }));

            const result2 = curator.assignTiers(walletsFromResult);

            // Verificar que los resultados son idénticos
            return result1.every(
              (r1, i) =>
                r1.address === result2[i].address &&
                r1.tier === result2[i].tier &&
                Math.abs(r1.score - result2[i].score) < 1e-10
            );
          }
        ),
        { numRuns: 100 }
      );
    });

    it("PROP: Addresses generadas son válidas (formato hex de 42 caracteres)", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      fc.assert(
        fc.property(walletWithMetricsArbitrary, (wallet) => {
          return wallet.address.startsWith("0x") && wallet.address.length === 42;
        }),
        { numRuns: 100 }
      );
    });
  });


  // ═══════════════════════════════════════════════════════════════════════════
  // PROPIEDADES DE EDGE CASES
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Propiedades de edge cases", () => {
    it("PROP: Métricas en valores extremos producen scores calculables (no NaN)", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      const extremeMetricsArbitrary = fc.record({
        winRate: fc.constantFrom(0, 0.5, 1),
        totalPnlUsdc: fc.constantFrom(-1000000, 0, 10000000),
        tradeCount: fc.constantFrom(0, 100, 10000),
        avgHoldingTimeSec: fc.constantFrom(0, 3600, 604800),
        volumeUsdc: fc.constantFrom(0, 500000, 100000000),
        sharpeRatio: fc.constantFrom(-5, 0, 5, 10),
        profitFactor: fc.constantFrom(0, 1, 5, 50),
      });

      fc.assert(
        fc.property(extremeMetricsArbitrary, (metrics) => {
          const score = curator.calculateWalletScore(metrics);
          return !Number.isNaN(score);
        }),
        { numRuns: 100 }
      );
    });

    it("PROP: Una sola wallet se procesa correctamente con tier S_TIER", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      fc.assert(
        fc.property(walletWithMetricsArbitrary, (wallet) => {
          const result = curator.assignTiers([wallet]);

          return (
            result.length === 1 &&
            result[0].address === wallet.address &&
            result[0].tier === "S_TIER" // Rank 1 siempre es S_TIER
          );
        }),
        { numRuns: 50 }
      );
    });


    it("PROP: Score de 0 se produce cuando algún factor es 0", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      const metricsWithZeroWinRate: ExtendedWalletMetrics = {
        winRate: 0,
        totalPnlUsdc: 100000,
        tradeCount: 100,
        avgHoldingTimeSec: 3600,
        volumeUsdc: 1000000,
        sharpeRatio: 2.0,
        profitFactor: 3.0,
      };

      const metricsWithZeroProfitFactor: ExtendedWalletMetrics = {
        winRate: 0.8,
        totalPnlUsdc: 100000,
        tradeCount: 100,
        avgHoldingTimeSec: 3600,
        volumeUsdc: 1000000,
        sharpeRatio: 2.0,
        profitFactor: 0,
      };

      const metricsWithZeroSharpe: ExtendedWalletMetrics = {
        winRate: 0.8,
        totalPnlUsdc: 100000,
        tradeCount: 100,
        avgHoldingTimeSec: 3600,
        volumeUsdc: 1000000,
        sharpeRatio: 0,
        profitFactor: 3.0,
      };

      expect(curator.calculateWalletScore(metricsWithZeroWinRate)).toBe(0);
      expect(curator.calculateWalletScore(metricsWithZeroProfitFactor)).toBe(0);
      expect(curator.calculateWalletScore(metricsWithZeroSharpe)).toBe(0);
    });

    it("PROP: Scores negativos son válidos cuando sharpeRatio es negativo", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      const metricsWithNegativeSharpe: ExtendedWalletMetrics = {
        winRate: 0.8,
        totalPnlUsdc: 100000,
        tradeCount: 100,
        avgHoldingTimeSec: 3600,
        volumeUsdc: 1000000,
        sharpeRatio: -2.0,
        profitFactor: 3.0,
      };

      const score = curator.calculateWalletScore(metricsWithNegativeSharpe);
      expect(score).toBe(0.8 * 3.0 * -2.0); // -4.8
      expect(score).toBeLessThan(0);
    });
  });


  // ═══════════════════════════════════════════════════════════════════════════
  // PROPIEDADES DE DISTRIBUCIÓN DE TIERS
  // ═══════════════════════════════════════════════════════════════════════════

  describe("Propiedades de distribución de Tiers", () => {
    it("PROP: Con 50 wallets, la distribución de tiers es correcta", () => {
      /**
       * **Validates: Requirements 1.12**
       * 5 S_TIER (ranks 1-5), 10 A_TIER (ranks 6-15), 35 B_TIER (ranks 16-50)
       */
      fc.assert(
        fc.property(
          fc.array(walletWithMetricsArbitrary, { minLength: 50, maxLength: 50 }),
          (wallets) => {
            // Ensure unique addresses
            const uniqueAddresses = new Set(wallets.map((w) => w.address));
            if (uniqueAddresses.size !== 50) return true; // Skip non-unique

            const result = curator.assignTiers(wallets);

            const sTierCount = result.filter((r) => r.tier === "S_TIER").length;
            const aTierCount = result.filter((r) => r.tier === "A_TIER").length;
            const bTierCount = result.filter((r) => r.tier === "B_TIER").length;

            return sTierCount === 5 && aTierCount === 10 && bTierCount === 35;
          }
        ),
        { numRuns: 20 }
      );
    });

    it("PROP: Con menos de 50 wallets, los tiers se asignan según ranking", () => {
      /**
       * **Validates: Requirements 1.12**
       */
      fc.assert(
        fc.property(
          fc.array(walletWithMetricsArbitrary, { minLength: 1, maxLength: 49 }),
          (wallets) => {
            // Ensure unique addresses
            const uniqueAddresses = new Set(wallets.map((w) => w.address));
            if (uniqueAddresses.size !== wallets.length) return true;

            const result = curator.assignTiers(wallets);

            // Verify each wallet's tier matches its rank
            for (let i = 0; i < result.length; i++) {
              const rank = i + 1;
              const expectedTier =
                rank <= 5 ? "S_TIER" : rank <= 15 ? "A_TIER" : "B_TIER";
              if (result[i].tier !== expectedTier) {
                return false;
              }
            }
            return true;
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});
