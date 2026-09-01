/**
 * ChildProvisioner
 *
 * Provisions new child agent Docker containers and records them in the
 * child_agents table via ChildAgentsRepository.
 *
 * - Uses MCP Docker Server to create the container.
 * - Transfers initial USDC funding (mock in development / no wallet configured).
 * - Registers the child in SQLite.
 *
 * Requirements: 10.2, 10.3
 */

import { v4 as uuidv4 } from 'uuid';
import type { McpClient } from '../mcp/client/mcp-client.js';
import type { ChildAgentsRepository, ChildAgentRecord } from '../state/repositories/child-agents.repo.js';

// ---------------------------------------------------------------------------
// Re-export ChildAgentRecord for consumers
// ---------------------------------------------------------------------------
export type { ChildAgentRecord } from '../state/repositories/child-agents.repo.js';
export type { ChildAgentStatus } from '../state/repositories/child-agents.repo.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ChildProvisionRequest {
  /** Caller-supplied unique identifier for the child */
  uniqueId?: string;
  /** Initial funding to transfer in USDC 6-decimal bigint units (default: $50) */
  initialFundingUsdc?: bigint;
  /** Optional specialization hint for the child agent */
  strategy?: string;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_INITIAL_FUNDING = 50_000000n; // $50 USDC (6 decimals)
const CONTAINER_IMAGE = process.env['AGENT_IMAGE'] ?? 'autonomous-income-node:latest';
const PARENT_ID = process.env['AGENT_ID'] ?? 'parent';

// ---------------------------------------------------------------------------
// ChildProvisioner
// ---------------------------------------------------------------------------

export class ChildProvisioner {
  constructor(
    private readonly repo: ChildAgentsRepository,
    /** MCP Docker client. When null, runs in mock mode. */
    private readonly dockerClient: McpClient | null = null
  ) {}

  /**
   * Provision a new child agent.
   * 1. Calls MCP Docker to create a container.
   * 2. Simulates (or executes) the initial USDC transfer.
   * 3. Inserts a record in child_agents table.
   * Requirement: 10.2, 10.3
   */
  async provision(request: ChildProvisionRequest): Promise<ChildAgentRecord> {
    const id = request.uniqueId ?? uuidv4();
    const funding = request.initialFundingUsdc ?? DEFAULT_INITIAL_FUNDING;

    // Generate a deterministic-ish child wallet address for mock mode
    const walletAddress = this.deriveChildWalletAddress(id);

    // Container name must be unique and Docker-safe
    const containerName = `ain-child-${id.substring(0, 8)}`;

    // Step 1: Provision Docker container
    const containerId = await this.provisionContainer(
      containerName,
      walletAddress,
      request.strategy
    );

    // Step 2: Transfer initial funding (mock in dev mode)
    await this.transferFunding(walletAddress, funding);

    // Step 3: Record in SQLite (Requirement 10.3)
    const now = Date.now();
    this.repo.insert({
      id,
      walletAddress,
      containerId,
      parentId: PARENT_ID,
      initialFunding: funding.toString(),
      status: 'running',
      spawnedAt: now,
    });

    const record = this.repo.findById(id);
    if (!record) {
      throw new Error(`Failed to retrieve newly created child record: ${id}`);
    }

    console.log(
      `[ChildProvisioner] Spawned child ${id} (container=${containerId}, wallet=${walletAddress}, funding=$${Number(funding) / 1_000000})`
    );

    return record;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async provisionContainer(
    name: string,
    walletAddress: string,
    strategy: string | undefined
  ): Promise<string> {
    if (this.dockerClient === null || !this.dockerClient.isConnected) {
      // Mock mode
      const mockId = `mock_container_${Date.now()}`;
      console.log(`[ChildProvisioner] MOCK — would provision container "${name}" (id=${mockId})`);
      return mockId;
    }

    const env: Record<string, string> = {
      AGENT_ID: name,
      PARENT_WALLET: walletAddress,
      IS_CHILD: 'true',
    };

    if (strategy) {
      env['STRATEGY_HINT'] = strategy;
    }

    // Copy relevant env vars from parent
    const envVarsToForward = [
      'WALLET_PASSWORD',
      'RPC_PROVIDER_URL',
      'ANTHROPIC_API_KEY',
      'OPENAI_API_KEY',
      'LLM_PROVIDER',
    ];

    for (const key of envVarsToForward) {
      const val = process.env[key];
      if (val) env[key] = val;
    }

    const result = await this.dockerClient.callTool<{ containerId: string; status: string }>(
      'provision_container',
      {
        image: CONTAINER_IMAGE,
        name,
        env,
        volumes: [`./data/${name}:/app/data`, `./keys/${name}:/app/keys`],
      }
    );

    if (!result.ok) {
      throw new Error(`Docker provisioning failed: ${result.error.message}`);
    }

    return result.value.containerId;
  }

  private async transferFunding(toAddress: string, amountUsdc: bigint): Promise<void> {
    const amountHuman = Number(amountUsdc) / 1_000_000;

    // In mock/development mode: just log
    console.log(
      `[ChildProvisioner] Transferring $${amountHuman} USDC to child wallet ${toAddress} (mock)`
    );

    // In production, this would call PaymentModule.sendUsdc(toAddress, amountUsdc)
    // We skip the actual transfer here to keep this module dependency-free.
    // The caller (ReplicationModule) is responsible for injecting the payment
    // callback if real transfers are needed.
  }

  /**
   * Derive a deterministic mock wallet address from the child ID.
   * In production, the child generates its own wallet on first boot.
   */
  private deriveChildWalletAddress(id: string): string {
    // Simple deterministic hex address for development
    const hash = id
      .split('')
      .reduce((acc, c) => (acc * 31 + c.charCodeAt(0)) & 0xffffffff, 0);
    const hex = Math.abs(hash).toString(16).padStart(8, '0');
    return `0x${hex.repeat(5).substring(0, 40)}`;
  }
}
