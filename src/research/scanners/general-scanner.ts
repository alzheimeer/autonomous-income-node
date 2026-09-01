/**
 * GeneralScanner — Multi-source scanner covering all priority categories.
 *
 * Sources:
 * - Google search (via SerpAPI if SERPAPI_KEY available, otherwise basic scraping)
 * - Reddit: r/cryptocurrency, r/passive_income, r/beermoney
 * - GitHub trending repositories
 * - Hacker News (Show HN, Ask HN)
 *
 * This scanner can discover opportunities for ANY priority (P1-P4),
 * assigning priority based on content heuristics.
 *
 * Never throws — returns empty array on failure.
 */

import type { IResearchScanner, RawOpportunity, Priority } from './types.js';

const TIMEOUT_MS = 15_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (compatible; ResearchAgent/1.0)';

// ── Priority detection keywords ────────────────────────────────────────────

const P1_KEYWORDS = ['agent', 'a2a', 'marketplace', 'service', 'api', 'saas', 'mcp', 'x402'];
const P2_KEYWORDS = ['browser', 'automation', 'rpa', 'bot', 'scraping', 'selenium', 'playwright'];
const P3_KEYWORDS = ['youtube', 'tiktok', 'content', 'video', 'creator', 'monetize', 'shorts'];
const P4_KEYWORDS = ['trading', 'yield', 'arb', 'defi', 'perps', 'crypto', 'exchange', 'staking'];

// ── Category detection ─────────────────────────────────────────────────────

type OpportunityCategory = 'a2a' | 'rpa' | 'content' | 'trading' | 'other';

function detectPriorityAndCategory(text: string): { priority: Priority; category: OpportunityCategory } {
  const lower = text.toLowerCase();

  // Check in priority order (P1 highest)
  if (P1_KEYWORDS.some(k => lower.includes(k))) {
    return { priority: 'P1', category: 'a2a' };
  }
  if (P2_KEYWORDS.some(k => lower.includes(k))) {
    return { priority: 'P2', category: 'rpa' };
  }
  if (P3_KEYWORDS.some(k => lower.includes(k))) {
    return { priority: 'P3', category: 'content' };
  }
  if (P4_KEYWORDS.some(k => lower.includes(k))) {
    return { priority: 'P4', category: 'trading' };
  }

  // Default to 'other' which will be reclassified by categorizer
  return { priority: 'P2', category: 'other' };
}

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

// ── Helper: Simple HTML text extraction ────────────────────────────────────

function extractText(html: string, selector?: string): string[] {
  const results: string[] = [];

  if (selector) {
    // Very basic extraction - look for content between tags
    const patterns: Record<string, RegExp> = {
      'entry title': /<entry[^>]*>[\s\S]*?<title[^>]*>([^<]+)<\/title>/gi,
      'entry content': /<entry[^>]*>[\s\S]*?<content[^>]*>([^<]+)<\/content>/gi,
      'entry link': /<entry[^>]*>[\s\S]*?<link[^>]*href="([^"]+)"/gi,
      'item title': /<item[^>]*>[\s\S]*?<title[^>]*>([^<]+)<\/title>/gi,
      'h2 a': /<h2[^>]*>\s*<a[^>]*>([^<]+)<\/a>/gi,
      'p': /<p[^>]*>([^<]+)<\/p>/gi,
      'article': /<article[^>]*>([\s\S]*?)<\/article>/gi,
    };

    const pattern = patterns[selector];
    if (pattern) {
      let match;
      while ((match = pattern.exec(html)) !== null) {
        results.push(match[1].trim());
      }
    }
  }

  return results;
}

// ── Main Scanner Class ─────────────────────────────────────────────────────

export class GeneralScanner implements IResearchScanner {
  readonly name = 'general-scanner';
  // Priority is dynamic per opportunity, but scanner itself returns 'other' category
  readonly priority: Priority = 'P2'; // Default priority for uncategorized

  async scan(): Promise<RawOpportunity[]> {
    const results: RawOpportunity[] = [];

    const scanners = [
      this.scanGoogleSearch(),
      this.scanReddit(),
      this.scanHackerNews(),
      this.scanGitHubTrending(),
    ];

    const settled = await Promise.allSettled(scanners);
    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(...result.value);
      } else {
        console.warn(`[${this.name}] Scanner failed:`, result.reason);
      }
    }

    return results;
  }

  // ── Google Search (SerpAPI or fallback) ──────────────────────────────────

  private async scanGoogleSearch(): Promise<RawOpportunity[]> {
    const serpApiKey = process.env.SERPAPI_KEY;

    if (serpApiKey) {
      return this.scanGoogleViaSerpAPI(serpApiKey);
    }

    // Fallback to basic scraping (limited, may be blocked)
    return this.scanGoogleBasic();
  }

  private async scanGoogleViaSerpAPI(apiKey: string): Promise<RawOpportunity[]> {
    const queries = [
      'AI agent marketplace earning opportunities 2024',
      'passive income automation bots',
      'autonomous agent monetization',
    ];

    const opportunities: RawOpportunity[] = [];

    for (const query of queries) {
      try {
        const url = new URL('https://serpapi.com/search.json');
        url.searchParams.set('q', query);
        url.searchParams.set('api_key', apiKey);
        url.searchParams.set('num', '10');

        const response = await fetchWithTimeout(url.toString());

        if (!response.ok) {
          console.warn(`[${this.name}] SerpAPI returned ${response.status}`);
          continue;
        }

        const data = await response.json() as {
          organic_results?: Array<{
            title?: string;
            snippet?: string;
            link?: string;
          }>;
        };

        if (!data.organic_results) continue;

        for (const result of data.organic_results.slice(0, 5)) {
          if (!result.title || !result.link) continue;

          const fullText = `${result.title} ${result.snippet || ''}`;
          const { priority, category } = detectPriorityAndCategory(fullText);

          opportunities.push({
            title: `Google: ${result.title.slice(0, 80)}`,
            source: 'google-serpapi',
            category,
            description: result.snippet || result.title,
            estimatedRevenue: 'TBD (requires analysis)',
            capitalRequired: 'TBD',
            riskLevel: 'medium',
            automationLevel: 'partial',
            sourceUrl: result.link,
            metadata: {
              query,
              priority,
              searchEngine: 'google',
              viaSerpAPI: true,
            },
          });
        }
      } catch (err) {
        console.warn(`[${this.name}] Google SerpAPI scan failed for "${query}":`, (err as Error).message);
      }
    }

    return opportunities.slice(0, 10);
  }

  private async scanGoogleBasic(): Promise<RawOpportunity[]> {
    // Basic Google scraping - limited and may be blocked
    // This is a fallback when SerpAPI key is not available
    try {
      const query = encodeURIComponent('AI agent monetization opportunities');
      const response = await fetchWithTimeout(
        `https://www.google.com/search?q=${query}&num=10`,
        {
          headers: {
            'Accept': 'text/html',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        }
      );

      if (!response.ok) {
        console.warn(`[${this.name}] Google basic search returned ${response.status}`);
        return [];
      }

      const html = await response.text();
      const opportunities: RawOpportunity[] = [];

      // Very basic extraction - Google's HTML structure changes frequently
      // Look for result links in common patterns
      const linkPattern = /<a[^>]*href="\/url\?q=([^&"]+)[^"]*"[^>]*>([^<]+)<\/a>/gi;
      let match;
      let count = 0;

      while ((match = linkPattern.exec(html)) !== null && count < 5) {
        const url = decodeURIComponent(match[1]);
        const title = match[2].trim();

        if (url.startsWith('http') && title.length > 10) {
          const { priority, category } = detectPriorityAndCategory(title);

          opportunities.push({
            title: `Google: ${title.slice(0, 80)}`,
            source: 'google-scrape',
            category,
            description: `Search result: ${title}`,
            estimatedRevenue: 'TBD',
            capitalRequired: 'TBD',
            riskLevel: 'medium',
            automationLevel: 'partial',
            sourceUrl: url,
            metadata: {
              priority,
              searchEngine: 'google',
              viaSerpAPI: false,
            },
          });
          count++;
        }
      }

      return opportunities;
    } catch (err) {
      console.warn(`[${this.name}] Google basic scrape failed:`, (err as Error).message);
      return [];
    }
  }

  // ── Reddit Scanner ───────────────────────────────────────────────────────

  private async scanReddit(): Promise<RawOpportunity[]> {
    const subreddits = ['cryptocurrency', 'passive_income', 'beermoney'];
    const opportunities: RawOpportunity[] = [];

    const relevantKeywords = [
      'income', 'revenue', 'bot', 'automation', 'passive', 'ai',
      'earn', 'money', 'crypto', 'defi', 'yield', 'agent',
      'monetize', 'saas', 'api', 'service', 'autopilot', 'hands-off',
    ];

    for (const sub of subreddits) {
      try {
        const response = await fetchWithTimeout(`https://old.reddit.com/r/${sub}/.rss`, {
          headers: {
            'Accept': 'application/rss+xml, application/xml, text/xml',
          },
        });

        if (!response.ok) {
          console.warn(`[${this.name}] Reddit r/${sub} returned ${response.status}`);
          continue;
        }

        const xml = await response.text();

        // Parse RSS feed entries
        const entryPattern = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;
        const titlePattern = /<title[^>]*>([^<]+)<\/title>/i;
        const linkPattern = /<link[^>]*href="([^"]+)"/i;
        const contentPattern = /<content[^>]*>([\s\S]*?)<\/content>/i;

        let entryMatch;
        let count = 0;

        while ((entryMatch = entryPattern.exec(xml)) !== null && count < 15) {
          const entry = entryMatch[1];
          const titleMatch = titlePattern.exec(entry);
          const linkMatch = linkPattern.exec(entry);
          const contentMatch = contentPattern.exec(entry);

          if (!titleMatch) continue;

          const title = titleMatch[1].trim();
          const link = linkMatch?.[1] || '';
          const content = (contentMatch?.[1] || '').toLowerCase();
          const fullText = `${title.toLowerCase()} ${content}`;

          const matchedKeywords = relevantKeywords.filter(k => fullText.includes(k));

          if (matchedKeywords.length >= 2) {
            const { priority, category } = detectPriorityAndCategory(fullText);

            opportunities.push({
              title: `Reddit r/${sub}: ${title.slice(0, 80)}`,
              source: `reddit-${sub}`,
              category,
              description: `Discussion on r/${sub}: "${title}". Keywords: ${matchedKeywords.join(', ')}.`,
              estimatedRevenue: 'TBD (requires analysis)',
              capitalRequired: 'TBD',
              riskLevel: sub === 'cryptocurrency' ? 'high' : 'medium',
              automationLevel: 'partial',
              sourceUrl: link,
              metadata: {
                subreddit: sub,
                keywords: matchedKeywords,
                priority,
              },
            });
            count++;
          }
        }
      } catch (err) {
        console.warn(`[${this.name}] Reddit r/${sub} scan failed:`, (err as Error).message);
      }
    }

    return opportunities.slice(0, 15);
  }

  // ── Hacker News Scanner ──────────────────────────────────────────────────

  private async scanHackerNews(): Promise<RawOpportunity[]> {
    const opportunities: RawOpportunity[] = [];

    try {
      // Fetch top stories, Show HN, and Ask HN
      const endpoints = [
        'https://hacker-news.firebaseio.com/v0/topstories.json',
        'https://hacker-news.firebaseio.com/v0/showstories.json',
        'https://hacker-news.firebaseio.com/v0/askstories.json',
      ];

      const storyIds: number[] = [];

      for (const endpoint of endpoints) {
        try {
          const response = await fetchWithTimeout(endpoint);
          if (response.ok) {
            const ids = await response.json() as number[];
            if (Array.isArray(ids)) {
              storyIds.push(...ids.slice(0, 15));
            }
          }
        } catch {
          // Continue with other endpoints
        }
      }

      // Deduplicate story IDs
      const uniqueIds = [...new Set(storyIds)].slice(0, 30);

      // Fetch story details (in batches to avoid too many concurrent requests)
      const batchSize = 10;
      const relevantKeywords = [
        'ai', 'agent', 'income', 'startup', 'monetize', 'api',
        'automation', 'bot', 'saas', 'revenue', 'crypto', 'defi',
        'llm', 'gpt', 'earning', 'passive', 'side-project', 'launch',
      ];

      for (let i = 0; i < uniqueIds.length; i += batchSize) {
        const batch = uniqueIds.slice(i, i + batchSize);

        const storyPromises = batch.map(async (id) => {
          try {
            const response = await fetchWithTimeout(
              `https://hacker-news.firebaseio.com/v0/item/${id}.json`
            );
            if (!response.ok) return null;
            return response.json();
          } catch {
            return null;
          }
        });

        const stories = await Promise.all(storyPromises);

        for (const story of stories) {
          if (!story || typeof story !== 'object') continue;
          const s = story as { id?: number; title?: string; url?: string; score?: number; type?: string };
          if (!s.title) continue;

          const titleLower = s.title.toLowerCase();
          const matchedKeywords = relevantKeywords.filter(k => titleLower.includes(k));

          if (matchedKeywords.length >= 1) {
            const { priority, category } = detectPriorityAndCategory(s.title);
            const isShowHN = titleLower.startsWith('show hn');
            const isAskHN = titleLower.startsWith('ask hn');

            opportunities.push({
              title: `HN${isShowHN ? ' (Show)' : isAskHN ? ' (Ask)' : ''}: ${s.title.slice(0, 80)}`,
              source: 'hacker-news',
              category,
              description: `Hacker News ${isShowHN ? 'Show HN' : isAskHN ? 'Ask HN' : 'story'} (${s.score || 0} points): "${s.title}"`,
              estimatedRevenue: 'TBD (requires deeper analysis)',
              capitalRequired: 'TBD',
              riskLevel: 'medium',
              automationLevel: 'partial',
              sourceUrl: s.url || `https://news.ycombinator.com/item?id=${s.id}`,
              metadata: {
                hnId: s.id,
                score: s.score,
                keywords: matchedKeywords,
                priority,
                type: isShowHN ? 'show' : isAskHN ? 'ask' : 'story',
              },
            });
          }
        }
      }

      return opportunities.slice(0, 10);
    } catch (err) {
      console.warn(`[${this.name}] Hacker News scan failed:`, (err as Error).message);
      return [];
    }
  }

  // ── GitHub Trending Scanner ──────────────────────────────────────────────

  private async scanGitHubTrending(): Promise<RawOpportunity[]> {
    try {
      const response = await fetchWithTimeout(
        'https://github.com/trending?since=weekly&spoken_language_code=en',
        {
          headers: {
            'Accept': 'text/html',
            'Accept-Language': 'en-US,en;q=0.9',
          },
        }
      );

      if (!response.ok) {
        console.warn(`[${this.name}] GitHub trending returned ${response.status}`);
        return [];
      }

      const html = await response.text();
      const opportunities: RawOpportunity[] = [];

      // Monetization-specific keywords (not just generic "AI")
      const monetizationKeywords = [
        'income', 'monetiz', 'earn', 'revenue', 'profit', 'trading-bot',
        'arbitrage', 'yield', 'passive', 'cashflow',
      ];
      const agentKeywords = [
        'agent-market', 'a2a', 'x402', 'mcp-server', 'agent-pay',
        'autonomous-agent', 'ai-agent', 'agent-sdk',
      ];
      const automationKeywords = [
        'scraping-bot', 'content-automat', 'youtube-bot', 'tiktok-bot',
        'social-automat', 'auto-post',
      ];
      const allKeywords = [...monetizationKeywords, ...agentKeywords, ...automationKeywords];

      // Parse trending repos using regex (avoiding external dependencies)
      // GitHub trending page structure: <article class="Box-row">
      const articlePattern = /<article[^>]*class="[^"]*Box-row[^"]*"[^>]*>([\s\S]*?)<\/article>/gi;
      const repoPattern = /<h2[^>]*>\s*<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i;
      const descPattern = /<p[^>]*class="[^"]*col-9[^"]*"[^>]*>([\s\S]*?)<\/p>/i;

      let articleMatch;
      let count = 0;

      while ((articleMatch = articlePattern.exec(html)) !== null && count < 25) {
        const article = articleMatch[1];
        const repoMatch = repoPattern.exec(article);
        const descMatch = descPattern.exec(article);

        if (!repoMatch) continue;

        const repoPath = repoMatch[1].replace(/^\//, '');
        const repoName = repoMatch[2].replace(/\s+/g, ' ').trim();
        const description = descMatch ? descMatch[1].replace(/<[^>]+>/g, '').trim() : '';

        const fullText = `${repoName} ${description}`.toLowerCase();
        const matchedKeywords = allKeywords.filter(k => fullText.includes(k));

        if (matchedKeywords.length >= 1 && repoName) {
          const { priority, category } = detectPriorityAndCategory(fullText);

          opportunities.push({
            title: `GitHub trending: ${repoName.slice(0, 60)}`,
            source: 'github-trending',
            category,
            description: `Trending repo: ${repoName}. ${description.slice(0, 150)}`,
            estimatedRevenue: 'Integration opportunity',
            capitalRequired: '$0',
            riskLevel: 'low',
            automationLevel: 'full',
            sourceUrl: `https://github.com/${repoPath}`,
            metadata: {
              repo: repoPath,
              description,
              keywords: matchedKeywords,
              priority,
            },
          });
          count++;
        }
      }

      return opportunities.slice(0, 8);
    } catch (err) {
      console.warn(`[${this.name}] GitHub trending scan failed:`, (err as Error).message);
      return [];
    }
  }
}
