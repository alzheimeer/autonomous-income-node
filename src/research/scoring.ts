/**
 * ScoringEngine — LLM-based opportunity scoring with 4 dimensions.
 *
 * Uses Anthropic Claude API for evaluation.
 *
 * Weights: viability 30%, risk 25%, capital 25%, automation 20%.
 *
 * Context: Autonomous agent with ~$99 USDC on Base chain.
 * Evaluates:
 *   - Viability: Can it be automated? Is it technically feasible with our stack?
 *   - Risk: Probability of capital loss (100 = no risk, 0 = high risk)
 *   - Capital: Does it align with our ~$99 USDC budget?
 *   - Automation: Can it run without manual intervention?
 *
 * If LLM API fails, assigns default score of 50 and flags for re-scoring.
 * Complete scoring within 30 seconds including API latency.
 */

import type { RawOpportunity } from './comms/protocol.js';
import { SCORE_WEIGHTS } from './comms/protocol.js';

// ── Types ──────────────────────────────────────────────────────────────────

export interface ScoreDimensions {
  /** Technical feasibility given current stack (0-100, weight 30%) */
  viability: number;
  /** Risk assessment where 100 = no risk, 0 = high risk (0-100, weight 25%) */
  risk: number;
  /** Alignment with available capital ~$99 USDC (0-100, weight 25%) */
  capital: number;
  /** Ability to execute without manual intervention (0-100, weight 20%) */
  automation: number;
}

export interface ScoringResult {
  /** Composite score (0-100) calculated from weighted dimensions */
  composite: number;
  /** Individual dimension scores */
  dimensions: ScoreDimensions;
  /** LLM reasoning for the assigned score */
  reasoning: string;
  /** Flag indicating if scoring was via fallback (API failed) */
  needsRescore?: boolean;
}

// ── Anthropic API Response Types ───────────────────────────────────────────

interface AnthropicTextContent {
  type: 'text';
  text: string;
}

interface AnthropicResponse {
  content: AnthropicTextContent[];
  model: string;
  stop_reason: string;
  usage: {
    input_tokens: number;
    output_tokens: number;
  };
}

// ── ScoringEngine ──────────────────────────────────────────────────────────

export class ScoringEngine {
  private readonly apiKey: string;
  private readonly apiVersion = '2023-06-01';
  private readonly model = 'claude-3-haiku-20240307'; // Fast, cost-effective
  private readonly baseURL = 'https://api.anthropic.com/v1/messages';
  private readonly timeout = 30_000; // 30 seconds max as per requirement

  constructor() {
    this.apiKey = process.env['ANTHROPIC_API_KEY'] ?? '';
  }

  /**
   * Score an opportunity using LLM evaluation across 4 dimensions.
   * Returns composite score, individual dimensions, and reasoning.
   * Falls back to default score of 50 if API fails.
   */
  async score(opportunity: RawOpportunity): Promise<ScoringResult> {
    if (!this.apiKey) {
      console.warn('[ScoringEngine] No ANTHROPIC_API_KEY — using fallback score.');
      return this.fallbackScore('API key not configured');
    }

    try {
      const prompt = this.buildPrompt(opportunity);
      const response = await this.callAnthropicAPI(prompt);
      return this.parseResponse(response, opportunity);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.warn('[ScoringEngine] LLM scoring failed, using fallback:', errorMessage);
      return this.fallbackScore(errorMessage);
    }
  }

  /**
   * Deep-dive analysis of a promising opportunity.
   * Called only for opportunities with score >= 70.
   * Asks Claude to analyze in detail: implementation steps, risks, timeline, expected ROI.
   */
  async deepDive(
    opportunity: RawOpportunity,
    initialScore: ScoringResult,
  ): Promise<{ analysis: string; conclusion: string; stillViable: boolean } | null> {
    if (!this.apiKey) {
      console.warn('[ScoringEngine] No ANTHROPIC_API_KEY — skipping deep dive.');
      return null;
    }

    const prompt = `You are an autonomous income analyst for an AI agent with $99 USDC on Base blockchain.

OPPORTUNITY (initial score: ${initialScore.composite}/100):
- Title: ${opportunity.title}
- Source: ${opportunity.source}
- Category: ${opportunity.category}
- Description: ${opportunity.description}
- Estimated Revenue: ${opportunity.estimatedRevenue}
- Capital Required: ${opportunity.capitalRequired}
- Risk Level: ${opportunity.riskLevel}
- Automation Level: ${opportunity.automationLevel}

DEEP ANALYSIS REQUIRED:
1. How would this be implemented step-by-step with our stack (TypeScript, Node.js, ethers v6)?
2. What APIs/services would be needed?
3. How long would implementation take?
4. What's the realistic ROI in the first 30 days with $99 capital? Be EXTREMELY REALISTIC — not optimistic.
5. Are there any showstoppers not obvious at first glance?

IMPORTANT: If the realistic monthly ROI is less than $5, the opportunity is NOT viable for our autonomous agent. There's an opportunity cost to implementing this vs. searching for higher-ROI opportunities.

Respond ONLY with valid JSON (no markdown):
{
  "analysis": "Detailed analysis here (3-5 paragraphs)",
  "conclusion": "One line: viable/not viable and why",
  "stillViable": true/false,
  "implementationSteps": ["step1", "step2", ...],
  "estimatedDays": 1-30,
  "realisticMonthlyRoi": "$X"
}`;

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 45_000);

      try {
        const response = await fetch(this.baseURL, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.apiKey,
            'anthropic-version': this.apiVersion,
          },
          body: JSON.stringify({
            model: this.model,
            max_tokens: 1500,
            messages: [{ role: 'user', content: prompt }],
          }),
          signal: controller.signal,
        });

        if (!response.ok) {
          const errorText = await response.text();
          throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
        }

        const data = (await response.json()) as AnthropicResponse;
        const textContent = data.content.find((c) => c.type === 'text');

        if (!textContent?.text) {
          throw new Error('No text content in Anthropic response');
        }

        const content = textContent.text;

        // Parse JSON from response
        let jsonStr = content.trim();
        const jsonMatch = jsonStr.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          jsonStr = jsonMatch[0];
        }

        const parsed = JSON.parse(jsonStr) as {
          analysis?: string;
          conclusion?: string;
          stillViable?: boolean;
        };

        return {
          analysis: parsed.analysis ?? 'No analysis provided',
          conclusion: parsed.conclusion ?? 'Inconclusive',
          stillViable: parsed.stillViable ?? true,
        };
      } finally {
        clearTimeout(timeoutId);
      }
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);
      console.warn('[ScoringEngine] Deep-dive failed:', errorMessage);
      return null;
    }
  }

  /**
   * Build the scoring prompt for Claude.
   * Provides context about the autonomous agent and asks for JSON response.
   */
  private buildPrompt(opp: RawOpportunity): string {
    return `You are evaluating a monetization opportunity for an autonomous AI agent.

AGENT CONTEXT:
- The agent has ~$99 USDC on Base blockchain
- It can run TypeScript/Node.js code 24/7 autonomously
- Stack includes: ethers v6, Fastify, SQLite, Anthropic API access
- Goal: Generate passive income through automated strategies

OPPORTUNITY TO EVALUATE:
- Title: ${opp.title}
- Source: ${opp.source}
- Category: ${opp.category}
- Description: ${opp.description}
- Estimated Revenue: ${opp.estimatedRevenue}
- Capital Required: ${opp.capitalRequired}
- Risk Level: ${opp.riskLevel}
- Automation Level: ${opp.automationLevel}
${opp.sourceUrl ? `- Source URL: ${opp.sourceUrl}` : ''}

SCORING INSTRUCTIONS:
Score this opportunity on 4 dimensions (each 0-100):

1. **viability** (weight 30%): Is this technically feasible with our stack?
   - 100: Straightforward to implement with existing tools
   - 50: Possible but requires new dependencies/learning
   - 0: Impossible with our tech stack

2. **risk** (weight 25%): What's the probability of capital loss?
   - 100: No capital at risk, zero-loss scenario
   - 50: Moderate risk, could lose 20-50% of capital
   - 0: High risk, could lose all capital

3. **capital** (weight 25%): Does it align with our ~$99 USDC budget?
   - 100: No capital required or fits perfectly
   - 50: Needs $50-200, slightly outside our range
   - 0: Requires $1000+ we don't have

4. **automation** (weight 20%): Can it run without manual intervention?
   - 100: Fully autonomous once deployed
   - 50: Needs occasional human checks/decisions
   - 0: Requires constant human involvement

RESPONSE FORMAT:
Respond ONLY with valid JSON in this exact format (no markdown, no explanation outside JSON):
{"viability":N,"risk":N,"capital":N,"automation":N,"reasoning":"2-3 sentences explaining your scores"}`;
  }

  /**
   * Call Anthropic Claude API with the scoring prompt.
   * Uses fetch with timeout for reliability.
   */
  private async callAnthropicAPI(prompt: string): Promise<string> {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), this.timeout);

    try {
      const response = await fetch(this.baseURL, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.apiKey,
          'anthropic-version': this.apiVersion,
        },
        body: JSON.stringify({
          model: this.model,
          max_tokens: 512,
          messages: [
            {
              role: 'user',
              content: prompt,
            },
          ],
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`Anthropic API error ${response.status}: ${errorText}`);
      }

      const data = (await response.json()) as AnthropicResponse;
      const textContent = data.content.find((c) => c.type === 'text');

      if (!textContent?.text) {
        throw new Error('No text content in Anthropic response');
      }

      return textContent.text;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  /**
   * Parse the LLM response into a ScoringResult.
   * Extracts JSON from response and calculates composite score.
   */
  private parseResponse(text: string, _opportunity: RawOpportunity): ScoringResult {
    try {
      // Extract JSON from response (handle potential markdown code blocks)
      let jsonStr = text.trim();

      // Remove markdown code blocks if present
      const jsonMatch = jsonStr.match(/```(?:json)?\s*([\s\S]*?)```/);
      if (jsonMatch) {
        jsonStr = jsonMatch[1].trim();
      }

      // Try to find JSON object in the text
      const objectMatch = jsonStr.match(/\{[\s\S]*\}/);
      if (objectMatch) {
        jsonStr = objectMatch[0];
      }

      const parsed = JSON.parse(jsonStr) as {
        viability?: number;
        risk?: number;
        capital?: number;
        automation?: number;
        reasoning?: string;
      };

      const dimensions: ScoreDimensions = {
        viability: this.clamp(parsed.viability ?? 50),
        risk: this.clamp(parsed.risk ?? 50),
        capital: this.clamp(parsed.capital ?? 50),
        automation: this.clamp(parsed.automation ?? 50),
      };

      // Calculate composite using specified weights
      const composite = Math.round(
        dimensions.viability * SCORE_WEIGHTS.viability +
          dimensions.risk * SCORE_WEIGHTS.risk +
          dimensions.capital * SCORE_WEIGHTS.capital +
          dimensions.automation * SCORE_WEIGHTS.automation
      );

      const reasoning =
        typeof parsed.reasoning === 'string' && parsed.reasoning.length > 0
          ? parsed.reasoning
          : `LLM scored: V=${dimensions.viability}, R=${dimensions.risk}, C=${dimensions.capital}, A=${dimensions.automation}`;

      return {
        composite,
        dimensions,
        reasoning,
      };
    } catch (parseError) {
      console.warn('[ScoringEngine] Failed to parse LLM response:', parseError);
      console.warn('[ScoringEngine] Raw response:', text.slice(0, 500));
      return this.fallbackScore('Failed to parse LLM response');
    }
  }

  /**
   * Generate fallback score when LLM API fails.
   * Assigns default score of 50 and flags for re-scoring.
   */
  private fallbackScore(reason: string): ScoringResult {
    const defaultScore = 50;

    return {
      composite: defaultScore,
      dimensions: {
        viability: defaultScore,
        risk: defaultScore,
        capital: defaultScore,
        automation: defaultScore,
      },
      reasoning: `Fallback score (${reason}). Flagged for re-scoring.`,
      needsRescore: true,
    };
  }

  /**
   * Clamp a value to 0-100 range.
   */
  private clamp(value: number): number {
    if (typeof value !== 'number' || isNaN(value)) {
      return 50;
    }
    return Math.max(0, Math.min(100, Math.round(value)));
  }
}

// ── Utility: Calculate composite from dimensions ───────────────────────────

export function calculateComposite(dimensions: ScoreDimensions): number {
  return Math.round(
    dimensions.viability * SCORE_WEIGHTS.viability +
      dimensions.risk * SCORE_WEIGHTS.risk +
      dimensions.capital * SCORE_WEIGHTS.capital +
      dimensions.automation * SCORE_WEIGHTS.automation
  );
}

// ── Default export for convenience ─────────────────────────────────────────

export default ScoringEngine;
