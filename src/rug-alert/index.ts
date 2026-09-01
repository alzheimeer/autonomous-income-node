/**
 * Rug Alert Service — Public API
 *
 * Re-exports the public surface of the rug-alert module.
 * Internal implementation files (detectors, notifiers, ABIs, etc.) are not
 * re-exported here; they are consumed only within this directory.
 *
 * Requirements: 6.1, 6.2
 */

export { RugAlertService } from './rug-alert-service.js';
export type {
  IRugAlertService,
  AlertEvent,
  AlertSeverity,
  AlertReason,
  AlertStats,
} from './types.js';
