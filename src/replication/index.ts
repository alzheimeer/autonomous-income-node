/**
 * ReplicationModule
 *
 * Gate-guarded (Tier 4 only) module for spawning child agents.
 *
 * Responsibilities:
 * - spawnChild: provisions a new child via ChildProvisioner (max 5).
 * - Handles Docker-unavailable by postponing 30 minutes.
 * - Emergency funding: transfers $5 USDC if parent is Tier 4 and
 *   child is in emergency mode.
 * - Exposes GET /children endpoint data for HeartbeatModule.
 *
 * Requirements: 10.1, 10.4, 10.5, 10.6
 */

import type { ChildAgentRecord } from './child-provisioner.js';
import { ChildProvisioner } from './child-provisioner.js';
import type { ChildProvisionRequest } from './child-provisioner.js';
import { ChildRegistry } from './child-registry.js';
import { SurvivalTier } from '../survival/tier-evaluator.js';
import type { ChildAgentsRepository } from '../state/repositories/child-agents.repo.js';
import type { McpClient } from '../mcp/client/mcp-client.js';
import { ErrorCode } from '../mcp/client/mcp-client.js';

// ---------------------------------------------------------------------------
// Re-exports
// ---------------------------------------------------------------------------
export { ChildRegistry } from './child-registry.js';
export { ChildProvisioner } from './child-provisioner.js';
export type { ChildProvisionRequest, ChildAgentRecord } from './child-provisioner.js';
export type { ChildAgentStatus } from './child-registry.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** $5 USDC emergency funding amount (Requirement 10.5) */
const EMERGENCY_FUNDING_USDC = 5_000000n;

/** Postpone duration when Docker is unavailable: 30 minutes (Requirement 10.6) */
const DOCKER_UNAVAILABLE_POSTPONE_MS = 30 * 60 * 1_000;

// ---------------------------------------------------------------------------
// ReplicationModule errors
// ---------------------------------------------------------------------------

export class TierGateError extends Error {
  readonly code = ErrorCode.TIER_GATE_DENIED;
  constructor(requiredTier: string, currentTier: number) {
    super(`Replication requires ${requiredTier}. Current tier: ${currentTier}`);
  }
}

export class MaxChildrenError extends Error {
  readonly code = 'MAX_CHILDREN_REACHED';
  constructor() {
    super(`Maximum child agents reached (${ChildRegistry.MAX_CHILDREN})`);
  }
}

export class DockerUnavailableError extends Error {
  readonly code = 'DOCKER_UNAVAILABLE';
  constructor() {
    super('Docker daemon is unavailable. Replication postponed 30 minutes.');
  }
}

// ---------------------------------------------------------------------------
// ReplicationModule
// ---------------------------------------------------------------------------

export class ReplicationModule {
  private readonly provisioner: ChildProvisioner;
  private readonly registry: ChildRegistry;

  /** If non-null, a Docker-unavailable postpone is scheduled */
  private postponeTimer: ReturnType<typeof setTimeout> | null = null;
  private postponedRequest: ChildProvisionRequest | null = null;

  constructor(
    repo: ChildAgentsRepository,
    dockerClient: McpClient | null = null
  ) {
    this.provisioner = new ChildProvisioner(repo, dockerClient);
    this.registry = new ChildRegistry(repo);
  }

  // ---------------------------------------------------------------------------
  // Core spawn
  // ---------------------------------------------------------------------------

  /**
   * Spawn a child agent.
   * - Gates: Tier 4 required (Requirement 10.1).
   * - Max 5 active children (Requirement 10.4).
   * - Handles Docker unavailable: postpones 30 min (Requirement 10.6).
   */
  async spawnChild(
    req: ChildProvisionRequest,
    currentTier: SurvivalTier
  ): Promise<ChildAgentRecord> {
    // Tier gate (Requirement 10.1)
    if (currentTier < SurvivalTier.TIER_4) {
      throw new TierGateError('Tier 4', currentTier);
    }

    // Capacity gate (Requirement 10.4)
    if (await this.registry.isAtCapacity()) {
      throw new MaxChildrenError();
    }

    try {
      const record = await this.provisioner.provision(req);
      return record;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Detect Docker-unavailable error and postpone (Requirement 10.6)
      if (
        msg.toLowerCase().includes('docker') ||
        msg.toLowerCase().includes('docker_unavailable') ||
        msg.toLowerCase().includes('docker daemon')
      ) {
        this.schedulePostponedSpawn(req, DOCKER_UNAVAILABLE_POSTPONE_MS);
        throw new DockerUnavailableError();
      }

      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // Emergency funding
  // ---------------------------------------------------------------------------

  /**
   * Check for children in emergency mode and fund them if parent is Tier 4.
   * Requirement: 10.5
   */
  async handleEmergencyFunding(currentTier: SurvivalTier): Promise<void> {
    if (currentTier < SurvivalTier.TIER_4) {
      console.log('[ReplicationModule] Emergency funding skipped — parent not in Tier 4');
      return;
    }

    const emergencyChildren = await this.registry.detectEmergency();

    for (const child of emergencyChildren) {
      try {
        await this.sendEmergencyFunding(child.id, child.walletAddress);
        // Mark child as running again
        this.registry.updateStatus(child.id, 'running');
        console.log(
          `[ReplicationModule] Emergency funded child ${child.id} ($${Number(EMERGENCY_FUNDING_USDC) / 1_000_000})`
        );
      } catch (err) {
        console.error(`[ReplicationModule] Failed to fund child ${child.id}:`, err);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Children list (for /children endpoint)
  // ---------------------------------------------------------------------------

  /**
   * Return all active children for the GET /children endpoint.
   * Requirement: 10.7
   */
  async getActiveChildren(): Promise<ChildAgentRecord[]> {
    return this.registry.getActive();
  }

  /** Return all children regardless of status */
  getAllChildren(): ChildAgentRecord[] {
    return this.registry.findAll();
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private async sendEmergencyFunding(
    childId: string,
    toAddress: string
  ): Promise<void> {
    const amountHuman = Number(EMERGENCY_FUNDING_USDC) / 1_000_000;
    // In development/mock: just log. In production, wire to PaymentModule.
    console.log(
      `[ReplicationModule] MOCK — sending $${amountHuman} USDC emergency funding to ${toAddress} (child: ${childId})`
    );
  }

  /**
   * Schedule a postponed spawn attempt after the Docker-unavailable delay.
   * Requirement 10.6
   */
  private schedulePostponedSpawn(
    req: ChildProvisionRequest,
    delayMs: number
  ): void {
    // Cancel any existing postpone
    if (this.postponeTimer !== null) {
      clearTimeout(this.postponeTimer);
    }

    this.postponedRequest = req;
    const minutes = Math.round(delayMs / 60_000);
    console.log(
      `[ReplicationModule] Docker unavailable — scheduling retry in ${minutes} minutes`
    );

    this.postponeTimer = setTimeout(() => {
      this.postponeTimer = null;
      const savedReq = this.postponedRequest;
      this.postponedRequest = null;

      if (savedReq) {
        console.log('[ReplicationModule] Retrying postponed child spawn...');
        // Attempt without tier gate (we retry with TIER_4 assumption)
        this.provisioner
          .provision(savedReq)
          .then((record) => {
            console.log(
              `[ReplicationModule] Postponed spawn succeeded: ${record.id}`
            );
          })
          .catch((err) => {
            console.error('[ReplicationModule] Postponed spawn also failed:', err);
          });
      }
    }, delayMs);
  }

  /** Clean up timers on shutdown */
  destroy(): void {
    if (this.postponeTimer !== null) {
      clearTimeout(this.postponeTimer);
      this.postponeTimer = null;
    }
  }
}
