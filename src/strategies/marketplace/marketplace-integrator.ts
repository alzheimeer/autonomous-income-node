/**
 * Marketplace Integrator — Autonomous Task Discovery & Execution
 *
 * Registers agent capabilities on decentralized agent marketplaces
 * (x402 Bazaar, Clawlancer, 0xWork) and autonomously discovers,
 * evaluates, and executes tasks for income generation.
 *
 * 100% automated — no human intervention required.
 *
 * Requirements: 2.1, 2.2, 2.3, 9.1
 */

import { randomUUID } from 'node:crypto';

import type { McpClient } from '../../mcp/client/mcp-client.js';
import type { IStrategyTracker } from '../../intelligence/strategy-tracker.js';
import type { MarketplaceTasksRepository } from '../../state/repositories/marketplace-tasks.repo.js';

// ═══════════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════════

export type MarketplaceName = 'x402_bazaar' | 'clawlancer' | '0xwork';
export type ServiceCapability = 'text-gen' | 'code-gen' | 'summarize' | 'scrape';

export interface MarketplaceTask {
  id: string;
  marketplace: MarketplaceName;
  title: string;
  description: string;
  requiredCapability: ServiceCapability;
  paymentUsdc: bigint;
  deadline: number;
  estimatedCostUsdc: bigint;
  viabilityScore: number;
}

export interface TaskExecutionResult {
  taskId: string;
  success: boolean;
  result: string | null;
  costUsdc: bigint;
  revenueUsdc: bigint;
  executionTimeMs: number;
  submittedAt: number;
}

export interface IMarketplaceIntegrator {
  registerCapabilities(): Promise<void>;
  evaluateTask(task: MarketplaceTask): Promise<{ accept: boolean; reason: string }>;
  executeTask(task: MarketplaceTask): Promise<TaskExecutionResult>;
  getActiveTasks(): MarketplaceTask[];
  pollForTasks(): Promise<MarketplaceTask[]>;
}

// ═══════════════════════════════════════════════════════════════════════════════
// Configuration
// ═══════════════════════════════════════════════════════════════════════════════

export interface MarketplaceIntegratorConfig {
  capabilities: ServiceCapability[];
  walletAddress: string;
}

/** Minimum profit margin (20%) required to accept a task. */
const MIN_MARGIN_MULTIPLIER = 1.20;

/** Minimum time buffer before deadline (5 minutes in ms). */
const MIN_DEADLINE_BUFFER_MS = 5 * 60 * 1000;

/** Approximate cost per 1K tokens in USDC (6 decimals). $0.01 = 10000n */
const COST_PER_1K_TOKENS_USDC = 10_000n;

/** Average tokens per task execution (conservative estimate). */
const AVG_TOKENS_PER_TASK = 2_000;

// ═══════════════════════════════════════════════════════════════════════════════
// Implementation
// ═══════════════════════════════════════════════════════════════════════════════

export class MarketplaceIntegrator implements IMarketplaceIntegrator {
  private readonly repo: MarketplaceTasksRepository;
  private readonly strategyTracker: IStrategyTracker;
  private readonly llmClient: McpClient;
  private readonly config: MarketplaceIntegratorConfig;

  constructor(
    repo: MarketplaceTasksRepository,
    strategyTracker: IStrategyTracker,
    llmClient: McpClient,
    config: MarketplaceIntegratorConfig,
  ) {
    this.repo = repo;
    this.strategyTracker = strategyTracker;
    this.llmClient = llmClient;
    this.config = config;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // registerCapabilities
  // ─────────────────────────────────────────────────────────────────────────

  async registerCapabilities(): Promise<void> {
    const { capabilities, walletAddress } = this.config;

    // x402 Bazaar — registration handled by BazaarRegistrar module
    console.info(
      `[MarketplaceIntegrator] Capabilities registered on x402 Bazaar: ${capabilities.join(', ')} ` +
      `(wallet: ${walletAddress})`,
    );

    // TODO: Clawlancer — register when API documentation is available
    // Planned: POST https://api.clawlancer.xyz/v1/agents/register
    // Body: { capabilities, walletAddress, endpoint }
    console.info('[MarketplaceIntegrator] Clawlancer registration: pending API docs');

    // TODO: 0xWork — register when API documentation is available
    // Planned: POST https://api.0xwork.io/v1/register-agent
    // Body: { skills: capabilities, paymentAddress: walletAddress }
    console.info('[MarketplaceIntegrator] 0xWork registration: pending API docs');
  }

  // ─────────────────────────────────────────────────────────────────────────
  // evaluateTask
  // ─────────────────────────────────────────────────────────────────────────

  async evaluateTask(
    task: MarketplaceTask,
  ): Promise<{ accept: boolean; reason: string }> {
    // Check capability match
    if (!this.config.capabilities.includes(task.requiredCapability)) {
      return {
        accept: false,
        reason: `Capability "${task.requiredCapability}" not supported. Available: ${this.config.capabilities.join(', ')}`,
      };
    }

    // Check deadline viability (at least 5 minutes from now)
    const timeUntilDeadline = task.deadline - Date.now();
    if (timeUntilDeadline < MIN_DEADLINE_BUFFER_MS) {
      return {
        accept: false,
        reason: `Deadline too tight: ${Math.round(timeUntilDeadline / 1000)}s remaining, minimum is ${MIN_DEADLINE_BUFFER_MS / 1000}s`,
      };
    }

    // Check profit margin (payment must be >= estimatedCost * 1.20)
    const minPaymentRequired = (task.estimatedCostUsdc * 120n) / 100n;
    if (task.paymentUsdc < minPaymentRequired) {
      return {
        accept: false,
        reason: `Insufficient margin: payment ${task.paymentUsdc} < required ${minPaymentRequired} (cost ${task.estimatedCostUsdc} × ${MIN_MARGIN_MULTIPLIER})`,
      };
    }

    return {
      accept: true,
      reason: `Task viable: capability=${task.requiredCapability}, margin=${Number((task.paymentUsdc - task.estimatedCostUsdc) * 100n / task.estimatedCostUsdc)}%, deadline=${Math.round(timeUntilDeadline / 60000)}min`,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // executeTask
  // ─────────────────────────────────────────────────────────────────────────

  async executeTask(task: MarketplaceTask): Promise<TaskExecutionResult> {
    const startMs = Date.now();

    // Mark task as executing in DB
    this.repo.updateStatus(task.id, 'executing', {
      accepted_at: startMs,
    });

    try {
      // Build prompt based on capability type
      const systemPrompt = this.buildSystemPrompt(task.requiredCapability);
      const userPrompt = `Task: ${task.title}\n\nDescription: ${task.description}`;

      // Execute via LLM
      const result = await this.llmClient.callTool<{ text: string; tokens?: number }>('infer', {
        systemPrompt,
        prompt: userPrompt,
        maxTokens: 4096,
      });

      const executionTimeMs = Date.now() - startMs;

      if (!result.ok) {
        // LLM failure — mark task as failed
        return this.handleTaskFailure(task, executionTimeMs, result.error.message);
      }

      // Calculate cost based on estimated token usage
      const tokensUsed = result.value.tokens ?? AVG_TOKENS_PER_TASK;
      const costUsdc = (BigInt(tokensUsed) * COST_PER_1K_TOKENS_USDC) / 1000n;

      // Record revenue and cost in strategy tracker
      this.strategyTracker.recordRevenue('marketplace', task.paymentUsdc, task.id);
      this.strategyTracker.recordCost('marketplace', costUsdc, task.id);
      this.strategyTracker.recordExecution('marketplace', true);

      // Persist result in repository
      this.repo.updateStatus(task.id, 'completed', {
        result_summary: result.value.text.slice(0, 500),
        execution_time_ms: executionTimeMs,
        completed_at: Date.now(),
      });

      return {
        taskId: task.id,
        success: true,
        result: result.value.text,
        costUsdc,
        revenueUsdc: task.paymentUsdc,
        executionTimeMs,
        submittedAt: Date.now(),
      };
    } catch (error) {
      const executionTimeMs = Date.now() - startMs;
      const errorMessage = error instanceof Error ? error.message : String(error);
      return this.handleTaskFailure(task, executionTimeMs, errorMessage);
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // pollForTasks
  // ─────────────────────────────────────────────────────────────────────────

  async pollForTasks(): Promise<MarketplaceTask[]> {
    const discoveredTasks: MarketplaceTask[] = [];

    // Poll x402 Bazaar
    const bazaarTasks = await this.pollBazaar();
    discoveredTasks.push(...bazaarTasks);

    // TODO: Poll Clawlancer when API is available
    // const clawlancerTasks = await this.pollClawlancer();
    // discoveredTasks.push(...clawlancerTasks);

    // TODO: Poll 0xWork when API is available
    // const oxworkTasks = await this.poll0xWork();
    // discoveredTasks.push(...oxworkTasks);

    // Persist discovered tasks
    for (const task of discoveredTasks) {
      this.repo.insert({
        id: task.id,
        marketplace: task.marketplace,
        title: task.title,
        description: task.description,
        required_capability: task.requiredCapability,
        payment_usdc: task.paymentUsdc.toString(),
        estimated_cost_usdc: task.estimatedCostUsdc.toString(),
        deadline: task.deadline,
        status: 'discovered',
      });
    }

    return discoveredTasks;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // getActiveTasks
  // ─────────────────────────────────────────────────────────────────────────

  getActiveTasks(): MarketplaceTask[] {
    const acceptedRows = this.repo.getByStatus('accepted');
    const executingRows = this.repo.getByStatus('executing');
    const allActive = [...acceptedRows, ...executingRows];

    return allActive.map((row) => ({
      id: row.id,
      marketplace: row.marketplace as MarketplaceName,
      title: row.title,
      description: row.description ?? '',
      requiredCapability: row.required_capability as ServiceCapability,
      paymentUsdc: BigInt(row.payment_usdc),
      deadline: row.deadline ?? 0,
      estimatedCostUsdc: BigInt(row.estimated_cost_usdc ?? '0'),
      viabilityScore: 0,
    }));
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Private helpers
  // ═══════════════════════════════════════════════════════════════════════════

  /**
   * Poll x402 Bazaar for available tasks matching agent capabilities.
   */
  private async pollBazaar(): Promise<MarketplaceTask[]> {
    const tasks: MarketplaceTask[] = [];
    const bazaarUrl = process.env['BAZAAR_API_URL'];

    if (!bazaarUrl) {
      console.debug('[MarketplaceIntegrator] BAZAAR_API_URL not configured, skipping Bazaar poll');
      return tasks;
    }

    for (const capability of this.config.capabilities) {
      try {
        const response = await fetch(
          `${bazaarUrl}/v1/tasks?capability=${encodeURIComponent(capability)}&status=open`,
          {
            method: 'GET',
            headers: {
              'Accept': 'application/json',
              'X-Agent-Wallet': this.config.walletAddress,
            },
            signal: AbortSignal.timeout(10_000),
          },
        );

        if (!response.ok) {
          console.warn(
            `[MarketplaceIntegrator] Bazaar API returned ${response.status} for capability "${capability}"`,
          );
          continue;
        }

        const data = await response.json() as BazaarTasksResponse;

        for (const item of data.tasks ?? []) {
          tasks.push({
            id: randomUUID(),
            marketplace: 'x402_bazaar',
            title: item.title,
            description: item.description ?? '',
            requiredCapability: capability,
            paymentUsdc: BigInt(item.payment_usdc ?? '0'),
            deadline: item.deadline ?? Date.now() + 3_600_000,
            estimatedCostUsdc: this.estimateCost(capability),
            viabilityScore: item.viability_score ?? 50,
          });
        }
      } catch (error) {
        // Marketplace unreachable — log warning and skip
        const msg = error instanceof Error ? error.message : String(error);
        console.warn(`[MarketplaceIntegrator] Bazaar unreachable for "${capability}": ${msg}`);
      }
    }

    return tasks;
  }

  /**
   * Handle task execution failure: record cost, update DB, report to marketplace.
   */
  private handleTaskFailure(
    task: MarketplaceTask,
    executionTimeMs: number,
    errorMessage: string,
  ): TaskExecutionResult {
    // Estimate partial cost (LLM may have consumed some tokens before failing)
    const costUsdc = (BigInt(AVG_TOKENS_PER_TASK / 2) * COST_PER_1K_TOKENS_USDC) / 1000n;

    // Record cost and failed execution
    this.strategyTracker.recordCost('marketplace', costUsdc, task.id);
    this.strategyTracker.recordExecution('marketplace', false);

    // Persist failure in repository
    this.repo.updateStatus(task.id, 'failed', {
      result_summary: `FAILED: ${errorMessage.slice(0, 400)}`,
      execution_time_ms: executionTimeMs,
      completed_at: Date.now(),
    });

    console.error(
      `[MarketplaceIntegrator] Task ${task.id} failed: ${errorMessage}`,
    );

    // TODO: Report failure to marketplace API when endpoints are available
    // await this.reportFailureToMarketplace(task, errorMessage);

    return {
      taskId: task.id,
      success: false,
      result: null,
      costUsdc,
      revenueUsdc: 0n,
      executionTimeMs,
      submittedAt: Date.now(),
    };
  }

  /**
   * Build a system prompt tailored to the capability type.
   */
  private buildSystemPrompt(capability: ServiceCapability): string {
    switch (capability) {
      case 'text-gen':
        return 'You are a professional content writer. Produce high-quality, original text based on the task description. Be concise, accurate, and well-structured.';
      case 'code-gen':
        return 'You are an expert software engineer. Write clean, well-documented, production-ready code based on the task requirements. Include comments and handle edge cases.';
      case 'summarize':
        return 'You are an expert summarizer. Distill the provided content into a clear, accurate summary that captures all key points. Be concise but comprehensive.';
      case 'scrape':
        return 'You are a data extraction specialist. Parse and structure the requested information accurately. Return clean, well-formatted data.';
    }
  }

  /**
   * Estimate execution cost for a given capability.
   * Returns USDC amount (6 decimals).
   */
  private estimateCost(capability: ServiceCapability): bigint {
    // Different capabilities have different average token consumption
    const tokenEstimates: Record<ServiceCapability, number> = {
      'text-gen': 2_500,
      'code-gen': 3_000,
      'summarize': 1_500,
      'scrape': 1_000,
    };

    const tokens = tokenEstimates[capability] ?? AVG_TOKENS_PER_TASK;
    return (BigInt(tokens) * COST_PER_1K_TOKENS_USDC) / 1000n;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// Internal API response types
// ═══════════════════════════════════════════════════════════════════════════════

/** Shape of the x402 Bazaar GET /v1/tasks response */
interface BazaarTasksResponse {
  tasks: BazaarTaskItem[];
}

interface BazaarTaskItem {
  id: string;
  title: string;
  description?: string;
  payment_usdc?: string;
  deadline?: number;
  viability_score?: number;
}
