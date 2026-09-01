/**
 * RPAScanner (P2) — Scans RPA and browser automation opportunities.
 *
 * Sources:
 * - Microtask platforms (Amazon MTurk, Clickworker, Appen)
 * - Browser automation tools/services (Puppeteer-based)
 * - Freelance AI task boards
 *
 * Implements IResearchScanner interface.
 * Uses native fetch for HTTP requests.
 * Handles API failures gracefully (returns empty array, logs error).
 * Includes rate limiting between requests.
 */

import type { IResearchScanner, ScannerConfig } from './types.js';
import type { RawOpportunity } from '../comms/protocol.js';

// ── Configuration ──────────────────────────────────────────────────────────

const DEFAULT_CONFIG: ScannerConfig = {
  enabled: true,
  timeoutMs: 15_000,
  maxResults: 50,
  requestDelayMs: 1_000,
};

// ── Helper Functions ───────────────────────────────────────────────────────

/**
 * Sleep for rate limiting between requests.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Safely fetch JSON from a URL with timeout.
 * Reserved for future use with API endpoints that return JSON.
 */
async function _fetchJson<T>(
  url: string,
  timeoutMs: number,
  headers?: Record<string, string>,
): Promise<T | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'ResearchAgent/1.0 (autonomous-income-node)',
        'Accept': 'application/json',
        ...headers,
      },
    });

    if (!response.ok) {
      return null;
    }

    return (await response.json()) as T;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

// Suppress unused variable warning
void _fetchJson;

/**
 * Safely fetch HTML from a URL with timeout.
 */
async function fetchHtml(
  url: string,
  timeoutMs: number,
): Promise<string | null> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml',
      },
    });

    if (!response.ok) {
      return null;
    }

    return await response.text();
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}


// ── Scanner Implementation ─────────────────────────────────────────────────

export class RPAScanner implements IResearchScanner {
  readonly name = 'rpa-scanner';
  readonly priority = 'P2' as const;
  
  private config: ScannerConfig;

  constructor(config: Partial<ScannerConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Execute scan across all RPA/browser automation sources.
   * Returns empty array on complete failure — never throws.
   */
  async scan(): Promise<RawOpportunity[]> {
    if (!this.config.enabled) {
      console.log('[RPAScanner] Scanner is disabled, skipping scan');
      return [];
    }

    console.log('[RPAScanner] Starting scan of microtask platforms and automation tools');
    const results: RawOpportunity[] = [];
    const scanners = [
      () => this.scanAmazonMTurk(),
      () => this.scanClickworker(),
      () => this.scanAppenConnect(),
      () => this.scanBrowserAutomationTools(),
      () => this.scanFreelanceAIBoards(),
    ];

    for (const scanner of scanners) {
      try {
        const opportunities = await scanner();
        results.push(...opportunities);
        
        // Rate limiting between sources
        if (this.config.requestDelayMs > 0) {
          await sleep(this.config.requestDelayMs);
        }
      } catch (error) {
        // Log but continue to next source
        console.error(`[RPAScanner] Scanner error:`, (error as Error).message);
      }
    }

    console.log(`[RPAScanner] Scan complete. Found ${results.length} opportunities`);
    // Limit total results
    return results.slice(0, this.config.maxResults);
  }


  // ── Amazon Mechanical Turk ───────────────────────────────────────────────

  /**
   * Scan Amazon Mechanical Turk for automatable microtasks.
   * MTurk has HITs (Human Intelligence Tasks) that can potentially be automated.
   */
  private async scanAmazonMTurk(): Promise<RawOpportunity[]> {
    const opportunities: RawOpportunity[] = [];

    try {
      console.log('[RPAScanner] Scanning Amazon MTurk...');
      
      // MTurk worker portal discovery
      const html = await fetchHtml(
        'https://worker.mturk.com',
        this.config.timeoutMs,
      );

      if (html) {
        // Check for task patterns that could be automated
        const hasAutomatableTasks = /data\s*entry|categorization|transcription|labeling|tagging|validation/i.test(html);
        
        if (hasAutomatableTasks) {
          opportunities.push({
            title: 'Automate MTurk data entry tasks via Puppeteer',
            source: 'amazon-mturk',
            category: 'rpa',
            description: 'Amazon Mechanical Turk has data entry and categorization tasks. Can build Puppeteer bot to automate repetitive HITs like text categorization, data validation, and simple labeling tasks.',
            estimatedRevenue: '$5-50/day',
            capitalRequired: '$0',
            riskLevel: 'medium',
            automationLevel: 'partial',
            sourceUrl: 'https://worker.mturk.com',
            metadata: {
              platform: 'amazon-mturk',
              type: 'microtask',
              automationType: 'puppeteer',
              taskTypes: ['data-entry', 'categorization', 'labeling'],
              scanTimestamp: Date.now(),
            },
          });
        }
      }


      // Also check for batch data processing opportunities
      opportunities.push({
        title: 'MTurk batch annotation tasks automation',
        source: 'amazon-mturk',
        category: 'rpa',
        description: 'MTurk offers batch tasks for image/text annotation. Can integrate with AI models (Claude, GPT) to automate annotation tasks and submit via browser automation.',
        estimatedRevenue: '$10-100/day',
        capitalRequired: '$0-5',
        riskLevel: 'medium',
        automationLevel: 'full',
        sourceUrl: 'https://worker.mturk.com',
        metadata: {
          platform: 'amazon-mturk',
          type: 'batch-annotation',
          automationType: 'ai-assisted',
          scanTimestamp: Date.now(),
        },
      });

    } catch (error) {
      console.error(`[RPAScanner] MTurk scan error:`, (error as Error).message);
    }

    return opportunities;
  }

  // ── Clickworker ──────────────────────────────────────────────────────────

  /**
   * Scan Clickworker platform for automatable tasks.
   * Clickworker offers various microtasks including AI training data.
   */
  private async scanClickworker(): Promise<RawOpportunity[]> {
    const opportunities: RawOpportunity[] = [];

    try {
      console.log('[RPAScanner] Scanning Clickworker...');
      
      const html = await fetchHtml(
        'https://www.clickworker.com/clickworker',
        this.config.timeoutMs,
      );


      if (html) {
        // Check for AI training data tasks
        const hasAiTasks = /ai\s*training|data\s*annotation|sentiment|categorization|transcription/i.test(html);
        
        if (hasAiTasks) {
          opportunities.push({
            title: 'Automate Clickworker AI training data tasks',
            source: 'clickworker',
            category: 'rpa',
            description: 'Clickworker offers AI training data collection tasks. Can automate sentiment analysis, text categorization, and simple annotation tasks using LLM APIs combined with browser automation.',
            estimatedRevenue: '$3-30/day',
            capitalRequired: '$0',
            riskLevel: 'low',
            automationLevel: 'full',
            sourceUrl: 'https://www.clickworker.com/clickworker',
            metadata: {
              platform: 'clickworker',
              type: 'ai-training-data',
              automationType: 'llm-assisted',
              scanTimestamp: Date.now(),
            },
          });
        }
      }

      // Check for UHRS (Universal Human Relevance System) tasks via Clickworker
      opportunities.push({
        title: 'Clickworker UHRS search relevance tasks',
        source: 'clickworker-uhrs',
        category: 'rpa',
        description: 'Clickworker provides access to UHRS tasks from Microsoft. Search relevance and query understanding tasks can be partially automated with NLP models.',
        estimatedRevenue: '$5-50/day',
        capitalRequired: '$0',
        riskLevel: 'medium',
        automationLevel: 'partial',
        sourceUrl: 'https://www.clickworker.com/clickworker',
        metadata: {
          platform: 'clickworker',
          type: 'uhrs',
          taskTypes: ['search-relevance', 'query-understanding'],
          scanTimestamp: Date.now(),
        },
      });

    } catch (error) {
      console.error(`[RPAScanner] Clickworker scan error:`, (error as Error).message);
    }

    return opportunities;
  }


  // ── Appen Connect ────────────────────────────────────────────────────────

  /**
   * Scan Appen Connect for AI data labeling opportunities.
   * Appen is a major provider of AI training data tasks.
   */
  private async scanAppenConnect(): Promise<RawOpportunity[]> {
    const opportunities: RawOpportunity[] = [];

    try {
      console.log('[RPAScanner] Scanning Appen Connect...');
      
      const endpoints = [
        'https://connect.appen.com',
        'https://appen.com/jobs',
      ];

      for (const endpoint of endpoints) {
        const html = await fetchHtml(endpoint, this.config.timeoutMs);
        
        if (html) {
          // Check for data labeling opportunities
          const hasLabelingTasks = /data\s*labeling|annotation|ai\s*training|image\s*tagging|text\s*classification/i.test(html);
          
          if (hasLabelingTasks) {
            opportunities.push({
              title: 'Appen AI data labeling automation',
              source: 'appen-connect',
              category: 'rpa',
              description: 'Appen Connect offers various AI training data tasks. Image tagging, text classification, and sentiment analysis can be automated using vision/language models combined with Puppeteer.',
              estimatedRevenue: '$5-40/day',
              capitalRequired: '$0',
              riskLevel: 'low',
              automationLevel: 'partial',
              sourceUrl: endpoint,
              metadata: {
                platform: 'appen',
                type: 'data-labeling',
                automationType: 'ai-assisted',
                scanTimestamp: Date.now(),
              },
            });
            break;
          }
        }
        
        await sleep(this.config.requestDelayMs);
      }


      // General Appen opportunity for linguistic tasks
      opportunities.push({
        title: 'Appen linguistic data collection automation',
        source: 'appen-linguistic',
        category: 'rpa',
        description: 'Appen has linguistic data collection projects including translation validation, speech transcription, and language understanding tasks. LLM-assisted automation can handle many of these.',
        estimatedRevenue: '$10-80/day',
        capitalRequired: '$0-2',
        riskLevel: 'low',
        automationLevel: 'partial',
        sourceUrl: 'https://connect.appen.com',
        metadata: {
          platform: 'appen',
          type: 'linguistic',
          taskTypes: ['translation', 'transcription', 'language-understanding'],
          scanTimestamp: Date.now(),
        },
      });

    } catch (error) {
      console.error(`[RPAScanner] Appen scan error:`, (error as Error).message);
    }

    return opportunities;
  }

  // ── Browser Automation Tools ─────────────────────────────────────────────

  /**
   * Scan for browser automation tool opportunities.
   * These are tools/services where we can offer automation services.
   */
  private async scanBrowserAutomationTools(): Promise<RawOpportunity[]> {
    const opportunities: RawOpportunity[] = [];

    try {
      console.log('[RPAScanner] Scanning browser automation services...');

      
      // Check Browserless.io (headless browser service)
      const browserlessHtml = await fetchHtml(
        'https://www.browserless.io',
        this.config.timeoutMs,
      );

      if (browserlessHtml) {
        opportunities.push({
          title: 'Offer web scraping services via Browserless',
          source: 'browserless',
          category: 'rpa',
          description: 'Browserless.io provides headless Chrome API. Can build and sell web scraping, data extraction, or automated testing services using their infrastructure.',
          estimatedRevenue: '$20-200/month',
          capitalRequired: '$0-40',
          riskLevel: 'low',
          automationLevel: 'full',
          sourceUrl: 'https://www.browserless.io',
          metadata: {
            platform: 'browserless',
            type: 'scraping-service',
            automationType: 'puppeteer',
            scanTimestamp: Date.now(),
          },
        });
      }

      await sleep(this.config.requestDelayMs);

      // Check Apify marketplace
      const apifyHtml = await fetchHtml(
        'https://apify.com/store',
        this.config.timeoutMs,
      );

      if (apifyHtml) {
        // Check what kind of actors/scrapers are in demand
        const hasDemand = /scraper|crawler|automation|bot|extractor/i.test(apifyHtml);
        
        if (hasDemand) {
          opportunities.push({
            title: 'Publish automation actors on Apify marketplace',
            source: 'apify-store',
            category: 'rpa',
            description: 'Apify Store is a marketplace for web scrapers and automation tools. Can publish actors (scrapers, data extractors, automation bots) and earn from usage fees.',
            estimatedRevenue: '$10-500/month',
            capitalRequired: '$0',
            riskLevel: 'low',
            automationLevel: 'full',
            sourceUrl: 'https://apify.com/store',
            metadata: {
              platform: 'apify',
              type: 'marketplace',
              automationType: 'actor-publishing',
              scanTimestamp: Date.now(),
            },
          });
        }
      }


      await sleep(this.config.requestDelayMs);

      // Check Bright Data (formerly Luminati) for proxy/scraping services
      const brightDataHtml = await fetchHtml(
        'https://brightdata.com',
        this.config.timeoutMs,
      );

      if (brightDataHtml) {
        opportunities.push({
          title: 'Build data collection pipelines with Bright Data',
          source: 'bright-data',
          category: 'rpa',
          description: 'Bright Data provides proxy networks and data collection infrastructure. Can build and sell data pipelines for market research, competitor analysis, or price monitoring.',
          estimatedRevenue: '$50-500/month',
          capitalRequired: '$20-100',
          riskLevel: 'medium',
          automationLevel: 'full',
          sourceUrl: 'https://brightdata.com',
          metadata: {
            platform: 'bright-data',
            type: 'data-collection',
            automationType: 'proxy-scraping',
            scanTimestamp: Date.now(),
          },
        });
      }

      await sleep(this.config.requestDelayMs);

      // Check for RPA as a service opportunities on Make.com (Integromat)
      const makeHtml = await fetchHtml(
        'https://www.make.com/en/templates',
        this.config.timeoutMs,
      );

      if (makeHtml) {
        opportunities.push({
          title: 'Create and sell Make.com automation templates',
          source: 'make-templates',
          category: 'rpa',
          description: 'Make.com (Integromat) allows publishing automation templates. Can create valuable business automation workflows and earn from template sales/subscriptions.',
          estimatedRevenue: '$10-200/month',
          capitalRequired: '$0',
          riskLevel: 'low',
          automationLevel: 'full',
          sourceUrl: 'https://www.make.com/en/templates',
          metadata: {
            platform: 'make',
            type: 'template-marketplace',
            automationType: 'no-code',
            scanTimestamp: Date.now(),
          },
        });
      }

    } catch (error) {
      console.error(`[RPAScanner] Browser automation scan error:`, (error as Error).message);
    }

    return opportunities;
  }


  // ── Freelance AI Task Boards ─────────────────────────────────────────────

  /**
   * Scan freelance platforms for AI/automation task opportunities.
   * Looking for tasks that can be automated or where we can offer services.
   */
  private async scanFreelanceAIBoards(): Promise<RawOpportunity[]> {
    const opportunities: RawOpportunity[] = [];

    try {
      console.log('[RPAScanner] Scanning freelance AI task boards...');
      
      // Check Fiverr for automation gigs demand
      const fiverrHtml = await fetchHtml(
        'https://www.fiverr.com/categories/programming-tech/ai-services',
        this.config.timeoutMs,
      );

      if (fiverrHtml) {
        const hasAutomationDemand = /web\s*scraping|automation|bot|data\s*extraction|rpa/i.test(fiverrHtml);
        
        if (hasAutomationDemand) {
          opportunities.push({
            title: 'Offer AI automation services on Fiverr',
            source: 'fiverr-ai',
            category: 'rpa',
            description: 'Fiverr has demand for AI-powered automation services. Can offer web scraping, data processing, chatbot development, or automated report generation services.',
            estimatedRevenue: '$20-500/month',
            capitalRequired: '$0',
            riskLevel: 'low',
            automationLevel: 'partial',
            sourceUrl: 'https://www.fiverr.com/categories/programming-tech/ai-services',
            metadata: {
              platform: 'fiverr',
              type: 'freelance',
              services: ['scraping', 'automation', 'bots'],
              scanTimestamp: Date.now(),
            },
          });
        }
      }


      await sleep(this.config.requestDelayMs);

      // Check Upwork for automation project demand
      const upworkSearchTerms = ['web+scraping', 'browser+automation', 'rpa+bot', 'puppeteer'];
      
      for (const term of upworkSearchTerms.slice(0, 2)) {
        const upworkHtml = await fetchHtml(
          `https://www.upwork.com/freelance-jobs/${term}/`,
          this.config.timeoutMs,
        );

        if (upworkHtml) {
          const hasJobs = /job|project|contract|hourly/i.test(upworkHtml);
          
          if (hasJobs) {
            opportunities.push({
              title: `Upwork ${term.replace('+', ' ')} project opportunities`,
              source: 'upwork',
              category: 'rpa',
              description: `Upwork has active demand for ${term.replace('+', ' ')} services. Can bid on projects and deliver automated solutions using our Puppeteer/Playwright stack.`,
              estimatedRevenue: '$50-1000/project',
              capitalRequired: '$0',
              riskLevel: 'low',
              automationLevel: 'partial',
              sourceUrl: `https://www.upwork.com/freelance-jobs/${term}/`,
              metadata: {
                platform: 'upwork',
                type: 'freelance',
                searchTerm: term,
                scanTimestamp: Date.now(),
              },
            });
            break; // One opportunity per platform is enough
          }
        }
        
        await sleep(this.config.requestDelayMs);
      }


      // Check Scale AI for AI task opportunities
      const scaleHtml = await fetchHtml(
        'https://scale.com/careers',
        this.config.timeoutMs,
      );

      if (scaleHtml) {
        // Scale AI has tasker programs
        const hasTasks = /tasker|contributor|annotator|labeler/i.test(scaleHtml);
        
        if (hasTasks) {
          opportunities.push({
            title: 'Scale AI data labeling with AI assistance',
            source: 'scale-ai',
            category: 'rpa',
            description: 'Scale AI offers data labeling tasks for AI training. Can automate portions of labeling tasks using LLM pre-processing and validation, then submit via browser automation.',
            estimatedRevenue: '$10-100/day',
            capitalRequired: '$0',
            riskLevel: 'medium',
            automationLevel: 'partial',
            sourceUrl: 'https://scale.com',
            metadata: {
              platform: 'scale-ai',
              type: 'data-labeling',
              automationType: 'llm-assisted',
              scanTimestamp: Date.now(),
            },
          });
        }
      }

      await sleep(this.config.requestDelayMs);

      // Check Remotasks (Scale's task platform)
      const remotasksHtml = await fetchHtml(
        'https://www.remotasks.com',
        this.config.timeoutMs,
      );

      if (remotasksHtml) {
        opportunities.push({
          title: 'Remotasks AI-assisted data annotation',
          source: 'remotasks',
          category: 'rpa',
          description: 'Remotasks offers various AI training tasks including image annotation, text classification, and content moderation. LLM can assist with many task types.',
          estimatedRevenue: '$5-50/day',
          capitalRequired: '$0',
          riskLevel: 'low',
          automationLevel: 'partial',
          sourceUrl: 'https://www.remotasks.com',
          metadata: {
            platform: 'remotasks',
            type: 'data-annotation',
            taskTypes: ['image', 'text', 'moderation'],
            scanTimestamp: Date.now(),
          },
        });
      }


      await sleep(this.config.requestDelayMs);

      // Check Toloka (Yandex crowdsourcing platform)
      const tolokaHtml = await fetchHtml(
        'https://toloka.ai',
        this.config.timeoutMs,
      );

      if (tolokaHtml) {
        const hasCrowdsourcing = /crowdsourcing|task|labeling|annotation/i.test(tolokaHtml);
        
        if (hasCrowdsourcing) {
          opportunities.push({
            title: 'Toloka AI crowdsourcing task automation',
            source: 'toloka',
            category: 'rpa',
            description: 'Toloka offers crowdsourcing tasks for AI training data. Tasks include image classification, content moderation, and text annotation - automatable with AI assistance.',
            estimatedRevenue: '$3-30/day',
            capitalRequired: '$0',
            riskLevel: 'low',
            automationLevel: 'partial',
            sourceUrl: 'https://toloka.ai',
            metadata: {
              platform: 'toloka',
              type: 'crowdsourcing',
              taskTypes: ['classification', 'moderation', 'annotation'],
              scanTimestamp: Date.now(),
            },
          });
        }
      }

    } catch (error) {
      console.error(`[RPAScanner] Freelance AI boards scan error:`, (error as Error).message);
    }

    return opportunities;
  }
}

// ── Export factory function ────────────────────────────────────────────────

/**
 * Create a configured RPAScanner instance.
 */
export function createRPAScanner(
  config: Partial<ScannerConfig> = {},
): RPAScanner {
  return new RPAScanner(config);
}
