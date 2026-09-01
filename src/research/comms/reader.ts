/**
 * CommsReader — Watches for ACK files from the operator agent.
 *
 * Polls ./investigacion/ every 30s for *_ack.json files.
 * Processes them and notifies callbacks.
 */

import { readdirSync, readFileSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import type { StrategyAck } from './protocol.js';

export type AckHandler = (ack: StrategyAck) => void;

export class CommsReader {
  private readonly dir: string;
  private readonly pollInterval: number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly handlers: AckHandler[] = [];
  private readonly processedFiles = new Set<string>();

  constructor(dir?: string, pollIntervalMs = 30_000) {
    this.dir = dir ?? join(process.cwd(), 'investigacion');
    this.pollInterval = pollIntervalMs;
  }

  /**
   * Register a handler for incoming ACKs.
   */
  onAck(handler: AckHandler): void {
    this.handlers.push(handler);
  }

  /**
   * Start polling for ACK files.
   */
  start(): void {
    if (this.timer) return;
    console.log(`[CommsReader] Polling ${this.dir} every ${this.pollInterval / 1000}s`);
    this.timer = setInterval(() => this.poll(), this.pollInterval);
    // Run immediately
    this.poll();
  }

  /**
   * Stop polling.
   */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private poll(): void {
    try {
      const files = readdirSync(this.dir).filter(
        (f) => f.endsWith('_ack.json') && !this.processedFiles.has(f),
      );

      for (const file of files) {
        try {
          const filepath = join(this.dir, file);
          const content = readFileSync(filepath, 'utf-8');
          const ack = JSON.parse(content) as StrategyAck;

          if (ack.type === 'ack' && ack.originalId) {
            for (const handler of this.handlers) {
              try {
                handler(ack);
              } catch (err) {
                console.warn('[CommsReader] Handler error:', (err as Error).message);
              }
            }
          }

          this.processedFiles.add(file);
          console.log(`[CommsReader] Processed ACK: ${file} (status: ${ack.status})`);
        } catch (err) {
          console.warn(`[CommsReader] Failed to parse ${file}:`, (err as Error).message);
          this.processedFiles.add(file); // Don't retry bad files
        }
      }
    } catch (err) {
      // Directory doesn't exist or read error — non-fatal
      console.warn('[CommsReader] Poll error:', (err as Error).message);
    }
  }
}
