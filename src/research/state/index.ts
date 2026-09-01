/**
 * Research State layer barrel export.
 * Re-exports the database wrapper and types.
 */

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------
export {
  ResearchDatabase,
  DatabaseIntegrityError,
  getResearchDatabase,
  resetResearchDatabaseInstance,
} from './database.js';

export type {
  ResearchDatabaseConfig,
  RunResult,
  Statement,
  Database,
} from './database.js';
