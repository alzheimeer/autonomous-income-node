/**
 * Bootstrap Script
 *
 * This is the true entry point for the agent in production.
 * It configures SSL/TLS settings BEFORE loading ethers.js to ensure
 * proper certificate handling in Docker containers.
 *
 * Usage: node dist/agent/bootstrap.js
 */

// ════════════════════════════════════════════════════════════════════════════════
// Global Error Handlers — MUST be first
// ════════════════════════════════════════════════════════════════════════════════

process.on('uncaughtException', (err) => {
  console.error('[Bootstrap] FATAL uncaughtException:', err.message);
  console.error('[Bootstrap] Stack:', err.stack);
  process.exit(1);
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('[Bootstrap] FATAL unhandledRejection at:', promise);
  console.error('[Bootstrap] Reason:', reason);
  process.exit(1);
});

// ════════════════════════════════════════════════════════════════════════════════
// SSL/TLS Configuration — MUST be before any network imports
// ════════════════════════════════════════════════════════════════════════════════

// Ensure SSL bypass is applied if configured
if (process.env['NODE_TLS_REJECT_UNAUTHORIZED'] === '0') {
  console.log('[Bootstrap] SSL certificate verification disabled via NODE_TLS_REJECT_UNAUTHORIZED=0');
}

// Set explicit SSL cert paths for containerized environments
if (!process.env['SSL_CERT_DIR']) {
  process.env['SSL_CERT_DIR'] = '/etc/ssl/certs';
}
if (!process.env['NODE_EXTRA_CA_CERTS'] && process.platform === 'linux') {
  process.env['NODE_EXTRA_CA_CERTS'] = '/etc/ssl/certs/ca-certificates.crt';
}

// ════════════════════════════════════════════════════════════════════════════════
// Start Agent
// ════════════════════════════════════════════════════════════════════════════════

console.log('[Bootstrap] Starting Autonomous Income Node...');
console.log('[Bootstrap] Node version:', process.version);
console.log('[Bootstrap] SSL_CERT_DIR:', process.env['SSL_CERT_DIR']);
console.log('[Bootstrap] NODE_EXTRA_CA_CERTS:', process.env['NODE_EXTRA_CA_CERTS']);

async function main() {
  try {
    console.log('[Bootstrap] Importing index module...');
    const { AgentCore } = await import('./index.js');
    console.log('[Bootstrap] Index module imported successfully');
    
    console.log('[Bootstrap] Creating AgentCore instance...');
    const agent = new AgentCore();
    
    console.log('[Bootstrap] Starting AgentCore...');
    await agent.start();
    
    console.log('[Bootstrap] Agent started successfully');
  } catch (err) {
    const error = err as Error;
    console.error('[Bootstrap] Failed to start agent:', error.message);
    console.error('[Bootstrap] Stack trace:', error.stack);
    process.exit(1);
  }
}

main();
