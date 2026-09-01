/**
 * Content Strategy Module — barrel export
 *
 * Integrates content generation and platform posting with capability gate
 * enforcement from the SurvivalModule.
 *
 * Requirements: 8.1–8.7
 */

export { ContentGenerator } from './content-generator.js';
export { PlatformPoster } from './platform-poster.js';
export type { ValidationResult, PostResult } from './platform-poster.js';
