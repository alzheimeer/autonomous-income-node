/**
 * Social Module — barrel export
 *
 * Provides Twitter client and engagement monitoring.
 *
 * Requirements: 8.1–8.7
 */

export { TwitterClient } from './twitter-client.js';
export type { TweetResult } from './twitter-client.js';

export { TelegramClient } from './telegram-client.js';
export type { TelegramResult } from './telegram-client.js';

export { EngagementMonitor } from './engagement-monitor.js';
export type { EngagementMetrics } from './engagement-monitor.js';
