/**
 * CommsWriter — Writes JSON files to ./investigacion/ for inter-agent communication.
 *
 * Naming convention: {timestamp}_{type}_{id}.json
 */

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { StrategyProposal } from './protocol.js';

export class CommsWriter {
  private readonly dir: string;

  constructor(dir?: string) {
    this.dir = dir ?? join(process.cwd(), 'investigacion');
    // Ensure directory exists
    try {
      mkdirSync(this.dir, { recursive: true });
    } catch {
      // Directory already exists
    }
  }

  /**
   * Write a strategy proposal for the operator agent to read.
   */
  writeStrategyProposal(proposal: StrategyProposal): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const id = proposal.payload.opportunityId;
    const filename = `${timestamp}_strategy_proposal_${id}.json`;
    const filepath = join(this.dir, filename);

    writeFileSync(filepath, JSON.stringify(proposal, null, 2), 'utf-8');
    console.log(`[CommsWriter] Wrote proposal: ${filename}`);
    return filepath;
  }

  /**
   * Write a generic message file.
   */
  writeMessage(type: string, id: string, data: Record<string, unknown>): string {
    const timestamp = Math.floor(Date.now() / 1000);
    const filename = `${timestamp}_${type}_${id}.json`;
    const filepath = join(this.dir, filename);

    writeFileSync(filepath, JSON.stringify(data, null, 2), 'utf-8');
    console.log(`[CommsWriter] Wrote message: ${filename}`);
    return filepath;
  }
}
