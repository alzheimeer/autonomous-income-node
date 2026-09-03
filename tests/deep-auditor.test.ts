import { describe, it, expect } from 'vitest';
import { DeepAuditorEngine } from '../src/research/deep-auditor.js';

describe('DeepAuditorEngine & Alert Pipeline', () => {
  const auditor = new DeepAuditorEngine();

  it('rejects pump.fun / memecoin / sniper opportunities immediately via historical memory', async () => {
    const result = await auditor.auditOpportunity({
      id: 'test-1',
      title: 'Micro-cap Solana sniper on pump.fun',
      description: 'Bot that snipes newly launched tokens with sub-second execution',
      category: 'trading',
      rawScore: 92,
    });

    expect(result.verdict).toBe('REJECTED_HISTORICAL');
    expect(result.trustScore).toBe(0);
  });

  it('rejects sales traps / affiliate courses / VIP signals', async () => {
    const result = await auditor.auditOpportunity({
      id: 'test-2',
      title: 'Secret bot guaranteed income telegram vip signals group',
      description: 'Join our course and signals group for guaranteed passive profits',
      category: 'trading',
      rawScore: 88,
    });

    expect(result.verdict).toBe('REJECTED_SCAM');
    expect(result.salesTrapDetected).toBe(true);
    expect(result.trustScore).toBeLessThan(50);
  });

  it('verifies legitimate opportunities with open-source repositories and high score', async () => {
    const result = await auditor.auditOpportunity({
      id: 'test-3',
      title: 'Open Source MCP Server for Enterprise Document Parsing',
      description: 'High-demand data integration service leveraging verified open-source protocols',
      category: 'rpa',
      sourceUrl: 'https://github.com/example/mcp-server',
      rawScore: 85,
    });

    expect(result.verdict).toBe('VERIFIED_LEGIT');
    expect(result.trustScore).toBeGreaterThanOrEqual(85);
    expect(result.evidenceCollected.length).toBeGreaterThan(0);
  });
});
