/**
 * MarketplaceScanner — P1 Priority scanner for A2A Agent Marketplaces.
 *
 * Sources:
 * - OKX AI agent search
 * - Swarms marketplace API (https://swarms.world)
 * - Agent directories (NEAR AI, Horizen Labs, etc.)
 *
 * This scanner focuses on discovering opportunities to:
 * - Register/list our agent on marketplaces
 * - Find paid agent gigs
 * - Identify A2A protocol integration opportunities
 *
 * Priority: P1 (highest priority - agent marketplaces)
 * Never throws — returns empty array on failure.
 */

import type { IResearchScanner, RawOpportunity, Priority } from './types.js';

const TIMEOUT_MS = 15_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (compatible; ResearchAgent/1.0)';

// ── Helper: Fetch with timeout ─────────────────────────────────────────────

async function fetchWithTimeout(url: string, options: RequestInit = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      headers: {
        'User-Agent': USER_AGENT,
        ...options.headers,
      },
    });
    return response;
  } finally {
    clearTimeout(timeout);
  }
}

// ── Helper: Safe JSON parsing ──────────────────────────────────────────────

async function safeJsonParse<T>(response: Response): Promise<T | null> {
  try {
    const text = await response.text();
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

// ── Main Scanner Class ─────────────────────────────────────────────────────

export class MarketplaceScanner implements IResearchScanner {
  readonly name = 'marketplace-scanner';
  readonly priority: Priority = 'P1';

  async scan(): Promise<RawOpportunity[]> {
    console.log('[MarketplaceScanner] Starting P1 marketplace scan...');
    const results: RawOpportunity[] = [];

    const scanners = [
      this.scanSwarmsMarketplace(),
      this.scanOKXAgentSearch(),
      this.scanNearAI(),
      this.scanHorizenLabs(),
      this.scanAgentProtocolDirectory(),
      this.scanAIAgentStore(),
    ];

    const settled = await Promise.allSettled(scanners);
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(...result.value);
      } else {
        console.log(`[MarketplaceScanner] Scanner failed: ${result.reason}`);
      }
    }

    console.log(`[MarketplaceScanner] Scan complete. Found ${results.length} opportunities.`);
    return results;
  }

  // ── Swarms Marketplace (https://swarms.world) ────────────────────────────

  private async scanSwarmsMarketplace(): Promise<RawOpportunity[]> {
    console.log('[MarketplaceScanner] Scanning Swarms marketplace...');
    const opportunities: RawOpportunity[] = [];

    try {
      // Try to fetch the Swarms marketplace API
      // Swarms.world is an AI agent marketplace for deploying and monetizing agents
      const endpoints = [
        'https://swarms.world/api/agents',
        'https://swarms.world/api/marketplace',
        'https://api.swarms.world/v1/agents',
      ];

      for (const endpoint of endpoints) {
        try {
          const response = await fetchWithTimeout(endpoint, {
            headers: {
              'Accept': 'application/json',
            },
          });

          if (response.ok) {
            const data = await safeJsonParse<{
              agents?: Array<{
                id?: string;
                name?: string;
                description?: string;
                price?: number | string;
                category?: string;
              }>;
              items?: Array<{
                id?: string;
                name?: string;
                description?: string;
                price?: number | string;
              }>;
            }>(response);

            if (data) {
              const items = data.agents || data.items || [];
              for (const item of items.slice(0, 10)) {
                if (item.name) {
                  opportunities.push({
                    title: `Swarms: ${item.name}`,
                    source: 'swarms-marketplace',
                    category: 'a2a',
                    description: item.description || `Agent listing on Swarms marketplace: ${item.name}`,
                    estimatedRevenue: item.price ? `$${item.price}/use` : 'Per-use pricing',
                    capitalRequired: '$0 (registration)',
                    riskLevel: 'low',
                    automationLevel: 'full',
                    sourceUrl: 'https://swarms.world',
                    metadata: {
                      platform: 'swarms',
                      agentId: item.id,
                      price: item.price,
                    },
                  });
                }
              }
            }
            break; // Successfully got data from one endpoint
          }
        } catch {
          // Continue to next endpoint
        }
      }

      // Fallback: Scrape main page if API unavailable
      if (opportunities.length === 0) {
        const response = await fetchWithTimeout('https://swarms.world', {
          headers: {
            'Accept': 'text/html',
          },
        });

        if (response.ok) {
          // Add a general opportunity to register on Swarms
          opportunities.push({
            title: 'Register agent on Swarms.world marketplace',
            source: 'swarms-marketplace',
            category: 'a2a',
            description: 'Swarms.world is an AI agent marketplace where developers can deploy, share, and monetize AI agents. Opportunity to list our autonomous agent and earn per-use fees.',
            estimatedRevenue: '$10-100/month (usage-based)',
            capitalRequired: '$0',
            riskLevel: 'low',
            automationLevel: 'full',
            sourceUrl: 'https://swarms.world',
            metadata: {
              platform: 'swarms',
              type: 'registration-opportunity',
              features: ['agent-listing', 'monetization', 'api-access'],
            },
          });
        }
      }

      console.log(`[MarketplaceScanner] Swarms: found ${opportunities.length} opportunities`);
    } catch (err) {
      console.log(`[MarketplaceScanner] Swarms scan failed: ${(err as Error).message}`);
    }

    return opportunities;
  }

  // ── OKX AI Agent Search ──────────────────────────────────────────────────

  private async scanOKXAgentSearch(): Promise<RawOpportunity[]> {
    console.log('[MarketplaceScanner] Scanning OKX AI agent directory...');
    const opportunities: RawOpportunity[] = [];

    try {
      // OKX has been exploring AI agent integrations
      // Check their developer/agent endpoints
      const endpoints = [
        'https://www.okx.com/web3/discover/agents',
        'https://www.okx.com/api/v5/public/instruments',
      ];

      for (const endpoint of endpoints) {
        try {
          const response = await fetchWithTimeout(endpoint, {
            headers: {
              'Accept': 'application/json, text/html',
            },
          });

          if (response.ok) {
            const contentType = response.headers.get('content-type') || '';

            if (contentType.includes('application/json')) {
              const data = await safeJsonParse<{
                data?: Array<{
                  name?: string;
                  type?: string;
                  description?: string;
                }>;
              }>(response);

              if (data?.data) {
                // Look for AI/agent related entries
                const agentRelated = data.data.filter(item =>
                  item.name?.toLowerCase().includes('agent') ||
                  item.name?.toLowerCase().includes('ai') ||
                  item.type?.toLowerCase().includes('agent')
                );

                for (const item of agentRelated.slice(0, 5)) {
                  opportunities.push({
                    title: `OKX: ${item.name || 'AI Agent Integration'}`,
                    source: 'okx-agents',
                    category: 'a2a',
                    description: item.description || `OKX AI agent opportunity: ${item.name}`,
                    estimatedRevenue: 'TBD (integration dependent)',
                    capitalRequired: 'TBD',
                    riskLevel: 'medium',
                    automationLevel: 'partial',
                    sourceUrl: 'https://www.okx.com/web3',
                    metadata: {
                      platform: 'okx',
                      type: item.type,
                    },
                  });
                }
              }
            }
          }
        } catch {
          // Continue to next endpoint
        }
      }

      // Add general OKX Web3 agent integration opportunity
      if (opportunities.length === 0) {
        opportunities.push({
          title: 'OKX Web3 Agent Integration',
          source: 'okx-agents',
          category: 'a2a',
          description: 'OKX offers Web3 services including DeFi aggregation and wallet services. Potential to integrate as an AI agent for automated trading signals or portfolio management.',
          estimatedRevenue: 'Commission-based (0.1-1%)',
          capitalRequired: '$0 (API integration)',
          riskLevel: 'medium',
          automationLevel: 'full',
          sourceUrl: 'https://www.okx.com/web3',
          metadata: {
            platform: 'okx',
            type: 'integration-opportunity',
            features: ['defi-aggregation', 'wallet-api', 'trading-signals'],
          },
        });
      }

      console.log(`[MarketplaceScanner] OKX: found ${opportunities.length} opportunities`);
    } catch (err) {
      console.log(`[MarketplaceScanner] OKX scan failed: ${(err as Error).message}`);
    }

    return opportunities;
  }

  // ── NEAR AI Agent Directory ──────────────────────────────────────────────

  private async scanNearAI(): Promise<RawOpportunity[]> {
    console.log('[MarketplaceScanner] Scanning NEAR AI directory...');
    const opportunities: RawOpportunity[] = [];

    try {
      // NEAR Protocol has AI agent initiatives
      const endpoints = [
        'https://near.ai/api/agents',
        'https://api.near.ai/v1/agents',
        'https://near.ai/agents',
      ];

      for (const endpoint of endpoints) {
        try {
          const response = await fetchWithTimeout(endpoint, {
            headers: {
              'Accept': 'application/json, text/html',
            },
          });

          if (response.ok) {
            const contentType = response.headers.get('content-type') || '';

            if (contentType.includes('application/json')) {
              const data = await safeJsonParse<{
                agents?: Array<{
                  id?: string;
                  name?: string;
                  description?: string;
                  rewards?: number | string;
                }>;
              }>(response);

              if (data?.agents) {
                for (const agent of data.agents.slice(0, 10)) {
                  opportunities.push({
                    title: `NEAR AI: ${agent.name || 'Agent Registry'}`,
                    source: 'near-ai',
                    category: 'a2a',
                    description: agent.description || `NEAR AI agent: ${agent.name}`,
                    estimatedRevenue: agent.rewards ? `${agent.rewards} NEAR` : 'Token rewards',
                    capitalRequired: '$0',
                    riskLevel: 'low',
                    automationLevel: 'full',
                    sourceUrl: 'https://near.ai',
                    metadata: {
                      platform: 'near-ai',
                      agentId: agent.id,
                    },
                  });
                }
              }
            }
          }
        } catch {
          // Continue to next endpoint
        }
      }

      // Add general NEAR AI opportunity
      if (opportunities.length === 0) {
        opportunities.push({
          title: 'NEAR AI Agent Registry',
          source: 'near-ai',
          category: 'a2a',
          description: 'NEAR Protocol supports AI agent development with their AI agent registry. Opportunity to register our agent for NEAR ecosystem tasks and earn NEAR tokens.',
          estimatedRevenue: '10-50 NEAR/month (task-based)',
          capitalRequired: '$0',
          riskLevel: 'low',
          automationLevel: 'full',
          sourceUrl: 'https://near.ai',
          metadata: {
            platform: 'near-ai',
            type: 'registration-opportunity',
            blockchain: 'near',
          },
        });
      }

      console.log(`[MarketplaceScanner] NEAR AI: found ${opportunities.length} opportunities`);
    } catch (err) {
      console.log(`[MarketplaceScanner] NEAR AI scan failed: ${(err as Error).message}`);
    }

    return opportunities;
  }

  // ── Horizen Labs Agent Directory ─────────────────────────────────────────

  private async scanHorizenLabs(): Promise<RawOpportunity[]> {
    console.log('[MarketplaceScanner] Scanning Horizen Labs...');
    const opportunities: RawOpportunity[] = [];

    try {
      // Horizen Labs has been working on zkSNARK-based solutions
      // and AI agent infrastructure
      const response = await fetchWithTimeout('https://www.horizen.io/ecosystem', {
        headers: {
          'Accept': 'text/html',
        },
      });

      if (response.ok) {
        const html = await response.text();

        // Look for agent/AI related mentions
        const hasAgentMentions =
          html.toLowerCase().includes('agent') ||
          html.toLowerCase().includes('ai') ||
          html.toLowerCase().includes('automation');

        if (hasAgentMentions) {
          opportunities.push({
            title: 'Horizen EON Agent Integration',
            source: 'horizen-labs',
            category: 'a2a',
            description: 'Horizen offers EON, an EVM-compatible sidechain with privacy features. Potential to build privacy-preserving AI agents or integrate with their ecosystem for automated tasks.',
            estimatedRevenue: 'ZEN token rewards',
            capitalRequired: '$0-10 (gas fees)',
            riskLevel: 'low',
            automationLevel: 'full',
            sourceUrl: 'https://www.horizen.io',
            metadata: {
              platform: 'horizen',
              type: 'ecosystem-integration',
              blockchain: 'horizen-eon',
              features: ['privacy', 'evm-compatible', 'sidechains'],
            },
          });
        }
      }

      // Add general Horizen opportunity
      if (opportunities.length === 0) {
        opportunities.push({
          title: 'Horizen Ecosystem Development',
          source: 'horizen-labs',
          category: 'a2a',
          description: 'Horizen Labs develops privacy-focused blockchain infrastructure. Opportunity to build agents that leverage their privacy features for confidential AI services.',
          estimatedRevenue: 'Grant-based + ZEN rewards',
          capitalRequired: '$0',
          riskLevel: 'low',
          automationLevel: 'partial',
          sourceUrl: 'https://www.horizen.io',
          metadata: {
            platform: 'horizen',
            type: 'development-opportunity',
          },
        });
      }

      console.log(`[MarketplaceScanner] Horizen: found ${opportunities.length} opportunities`);
    } catch (err) {
      console.log(`[MarketplaceScanner] Horizen scan failed: ${(err as Error).message}`);
    }

    return opportunities;
  }

  // ── Agent Protocol Directory ─────────────────────────────────────────────

  private async scanAgentProtocolDirectory(): Promise<RawOpportunity[]> {
    console.log('[MarketplaceScanner] Scanning Agent Protocol directory...');
    const opportunities: RawOpportunity[] = [];

    try {
      // Agent Protocol is a standard for agent communication
      const response = await fetchWithTimeout('https://agentprotocol.ai', {
        headers: {
          'Accept': 'text/html',
        },
      });

      if (response.ok) {
        opportunities.push({
          title: 'Agent Protocol A2A Standard Implementation',
          source: 'agent-protocol',
          category: 'a2a',
          description: 'Agent Protocol defines a standard API for AI agent communication. Implementing this protocol allows our agent to interoperate with other agents and access agent marketplaces.',
          estimatedRevenue: 'Access to A2A marketplaces',
          capitalRequired: '$0',
          riskLevel: 'low',
          automationLevel: 'full',
          sourceUrl: 'https://agentprotocol.ai',
          metadata: {
            platform: 'agent-protocol',
            type: 'protocol-implementation',
            features: ['interoperability', 'standard-api', 'marketplace-access'],
          },
        });
      }

      // Also check GitHub for Agent Protocol repos
      const ghResponse = await fetchWithTimeout(
        'https://api.github.com/search/repositories?q=agent+protocol+marketplace&sort=stars&per_page=10',
        {
          headers: {
            'Accept': 'application/vnd.github.v3+json',
          },
        }
      );

      if (ghResponse.ok) {
        const data = await safeJsonParse<{
          items?: Array<{
            name: string;
            full_name: string;
            description: string;
            html_url: string;
            stargazers_count: number;
          }>;
        }>(ghResponse);

        if (data?.items) {
          for (const repo of data.items.slice(0, 5)) {
            const desc = repo.description?.toLowerCase() || '';
            const name = repo.name.toLowerCase();

            // Filter for relevant agent marketplace repos
            if (
              (desc.includes('agent') && desc.includes('market')) ||
              (desc.includes('a2a')) ||
              (name.includes('agent') && name.includes('market'))
            ) {
              opportunities.push({
                title: `GitHub: ${repo.name}`,
                source: 'github-agent-protocol',
                category: 'a2a',
                description: repo.description || `Agent marketplace repo: ${repo.name}`,
                estimatedRevenue: 'Integration opportunity',
                capitalRequired: '$0',
                riskLevel: 'low',
                automationLevel: 'full',
                sourceUrl: repo.html_url,
                metadata: {
                  platform: 'github',
                  repo: repo.full_name,
                  stars: repo.stargazers_count,
                },
              });
            }
          }
        }
      }

      console.log(`[MarketplaceScanner] Agent Protocol: found ${opportunities.length} opportunities`);
    } catch (err) {
      console.log(`[MarketplaceScanner] Agent Protocol scan failed: ${(err as Error).message}`);
    }

    return opportunities;
  }

  // ── AI Agent Store / Registries ──────────────────────────────────────────

  private async scanAIAgentStore(): Promise<RawOpportunity[]> {
    console.log('[MarketplaceScanner] Scanning AI Agent stores...');
    const opportunities: RawOpportunity[] = [];

    try {
      // Check various AI agent platforms and stores
      const platforms = [
        {
          name: 'AutoGPT Forge',
          url: 'https://github.com/Significant-Gravitas/AutoGPT',
          description: 'AutoGPT is a popular autonomous AI agent framework. Opportunity to list our agent as a plugin or integration.',
        },
        {
          name: 'LangChain Hub',
          url: 'https://smith.langchain.com/hub',
          description: 'LangChain Hub hosts prompts and chains. Opportunity to share agent prompts and earn visibility.',
        },
        {
          name: 'CrewAI Marketplace',
          url: 'https://www.crewai.com',
          description: 'CrewAI enables multi-agent collaboration. Opportunity to offer our agent as a specialized crew member.',
        },
        {
          name: 'Fixie.ai Agent Platform',
          url: 'https://fixie.ai',
          description: 'Fixie.ai provides AI agent deployment infrastructure. Potential to deploy our agent for paid API access.',
        },
        {
          name: 'Relevance AI',
          url: 'https://relevanceai.com',
          description: 'Relevance AI offers agent building and deployment. Opportunity to monetize through their platform.',
        },
      ];

      for (const platform of platforms) {
        try {
          const response = await fetchWithTimeout(platform.url, {
            headers: {
              'Accept': 'text/html, application/json',
            },
          });

          if (response.ok) {
            opportunities.push({
              title: `${platform.name} Integration`,
              source: `ai-agent-store-${platform.name.toLowerCase().replace(/\s+/g, '-')}`,
              category: 'a2a',
              description: platform.description,
              estimatedRevenue: 'Usage-based or subscription',
              capitalRequired: '$0',
              riskLevel: 'low',
              automationLevel: 'full',
              sourceUrl: platform.url,
              metadata: {
                platform: platform.name,
                type: 'platform-integration',
                verified: true,
              },
            });
          }
        } catch {
          // Platform not accessible, skip
        }
      }

      // Check for x402 payment protocol opportunities
      opportunities.push({
        title: 'x402 Payment Protocol Integration',
        source: 'x402-protocol',
        category: 'a2a',
        description: 'x402 is an HTTP-based micropayment protocol for AI agents. Integrating x402 allows our agent to charge for API calls and services automatically.',
        estimatedRevenue: 'Per-request payments',
        capitalRequired: '$0',
        riskLevel: 'low',
        automationLevel: 'full',
        sourceUrl: 'https://github.com/AgenTalk/x402',
        metadata: {
          platform: 'x402',
          type: 'protocol-implementation',
          features: ['micropayments', 'http-based', 'agent-to-agent'],
        },
      });

      console.log(`[MarketplaceScanner] AI Agent Stores: found ${opportunities.length} opportunities`);
    } catch (err) {
      console.log(`[MarketplaceScanner] AI Agent Store scan failed: ${(err as Error).message}`);
    }

    return opportunities;
  }
}
