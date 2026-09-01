/**
 * ContentScanner — P3 Priority Scanner for Content Generation Opportunities.
 *
 * Sources:
 * - YouTube trending topics (via API or scraping)
 * - TikTok trends (trending hashtags and sounds)
 * - Content automation tools and platforms
 *
 * Discovers opportunities for:
 * - Video generation (shorts, reels, automated content)
 * - Text-to-speech services
 * - Automatic thumbnail creation
 * - Content scheduling and posting automation
 *
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

// ── Helper: Delay for rate limiting ────────────────────────────────────────

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ── Main Scanner Class ─────────────────────────────────────────────────────

export class ContentScanner implements IResearchScanner {
  readonly name = 'content-scanner';
  readonly priority: Priority = 'P3';

  async scan(): Promise<RawOpportunity[]> {
    console.log(`[ContentScanner] Starting P3 content scan...`);
    const results: RawOpportunity[] = [];
    const startTime = Date.now();

    const scanners = [
      this.scanYouTubeTrending(),
      this.scanTikTokTrends(),
      this.scanContentAutomationTools(),
    ];

    const settled = await Promise.allSettled(scanners);

    for (const result of settled) {
      if (result.status === 'fulfilled') {
        results.push(...result.value);
        console.log(`[ContentScanner] Source completed with ${result.value.length} opportunities`);
      } else {
        console.log(`[ContentScanner] Source failed: ${result.reason}`);
      }
    }

    const elapsed = Date.now() - startTime;
    console.log(`[ContentScanner] Scan completed in ${elapsed}ms, found ${results.length} total opportunities`);

    return results;
  }

  // ── YouTube Trending Topics ──────────────────────────────────────────────

  private async scanYouTubeTrending(): Promise<RawOpportunity[]> {
    console.log(`[ContentScanner] Scanning YouTube trending topics...`);
    const opportunities: RawOpportunity[] = [];

    try {
      // Try YouTube API if key is available
      const youtubeApiKey = process.env.YOUTUBE_API_KEY;

      if (youtubeApiKey) {
        const apiOpps = await this.scanYouTubeViaAPI(youtubeApiKey);
        opportunities.push(...apiOpps);
      } else {
        // Fallback to public trending page scraping
        const scrapeOpps = await this.scanYouTubeTrendingScrape();
        opportunities.push(...scrapeOpps);
      }

      // Also scan for trending content niches
      const nicheOpps = await this.scanYouTubeNiches();
      opportunities.push(...nicheOpps);

    } catch (err) {
      console.log(`[ContentScanner] YouTube scan error: ${(err as Error).message}`);
    }

    return opportunities;
  }

  private async scanYouTubeViaAPI(apiKey: string): Promise<RawOpportunity[]> {
    const opportunities: RawOpportunity[] = [];

    try {
      // Fetch trending videos
      const url = new URL('https://www.googleapis.com/youtube/v3/videos');
      url.searchParams.set('part', 'snippet,statistics');
      url.searchParams.set('chart', 'mostPopular');
      url.searchParams.set('regionCode', 'US');
      url.searchParams.set('maxResults', '25');
      url.searchParams.set('key', apiKey);

      const response = await fetchWithTimeout(url.toString());

      if (!response.ok) {
        console.log(`[ContentScanner] YouTube API returned ${response.status}`);
        return [];
      }

      const data = await response.json() as {
        items?: Array<{
          id?: string;
          snippet?: {
            title?: string;
            description?: string;
            categoryId?: string;
            tags?: string[];
            channelTitle?: string;
          };
          statistics?: {
            viewCount?: string;
            likeCount?: string;
          };
        }>;
      };

      if (!data.items) return [];

      // Analyze trends for content creation opportunities
      const categories = new Map<string, number>();
      const trendingTags = new Map<string, number>();

      for (const video of data.items) {
        const categoryId = video.snippet?.categoryId || 'other';
        categories.set(categoryId, (categories.get(categoryId) || 0) + 1);

        for (const tag of video.snippet?.tags || []) {
          const normalizedTag = tag.toLowerCase();
          trendingTags.set(normalizedTag, (trendingTags.get(normalizedTag) || 0) + 1);
        }
      }

      // Create opportunities from trending patterns
      const topTags = Array.from(trendingTags.entries())
        .sort((a, b) => b[1] - a[1])
        .slice(0, 10);

      if (topTags.length > 0) {
        opportunities.push({
          title: `YouTube: Trending tags for automated content`,
          source: 'youtube-api',
          category: 'content',
          description: `Top trending tags: ${topTags.map(t => t[0]).join(', ')}. Create automated short-form videos using these tags for higher discoverability.`,
          estimatedRevenue: '$50-500/month (ad revenue + sponsorships)',
          capitalRequired: '$0-50 (AI tools)',
          riskLevel: 'low',
          automationLevel: 'full',
          sourceUrl: 'https://www.youtube.com/feed/trending',
          metadata: {
            trendingTags: topTags,
            analysisType: 'tag-frequency',
            platform: 'youtube',
          },
        });
      }

      // Shorts opportunity
      opportunities.push({
        title: 'YouTube Shorts: AI-generated faceless content',
        source: 'youtube-api',
        category: 'content',
        description: 'Create faceless YouTube Shorts using AI voice generation (ElevenLabs, Play.ht) and stock footage. Topics: facts, motivation, history, tech explanations.',
        estimatedRevenue: '$100-1000/month per channel',
        capitalRequired: '$20-50/month (AI tools)',
        riskLevel: 'low',
        automationLevel: 'full',
        sourceUrl: 'https://www.youtube.com/shorts',
        metadata: {
          contentType: 'shorts',
          automationTools: ['elevenlabs', 'pictory', 'invideo'],
          platform: 'youtube',
        },
      });

    } catch (err) {
      console.log(`[ContentScanner] YouTube API error: ${(err as Error).message}`);
    }

    return opportunities;
  }

  private async scanYouTubeTrendingScrape(): Promise<RawOpportunity[]> {
    const opportunities: RawOpportunity[] = [];

    try {
      const response = await fetchWithTimeout('https://www.youtube.com/feed/trending', {
        headers: {
          'Accept': 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!response.ok) {
        console.log(`[ContentScanner] YouTube trending page returned ${response.status}`);
        return [];
      }

      const html = await response.text();

      // Extract trending video titles for topic analysis
      const titlePattern = /"title":\s*\{"runs":\s*\[\s*\{"text":\s*"([^"]+)"/g;
      const titles: string[] = [];
      let match;

      while ((match = titlePattern.exec(html)) !== null && titles.length < 20) {
        titles.push(match[1]);
      }

      if (titles.length > 0) {
        // Analyze common words/themes
        const words = titles.join(' ').toLowerCase().split(/\s+/);
        const wordFreq = new Map<string, number>();
        const stopWords = new Set(['the', 'a', 'an', 'is', 'are', 'was', 'were', 'in', 'on', 'at', 'to', 'for', 'of', 'with', '|', '-', '&']);

        for (const word of words) {
          if (word.length > 3 && !stopWords.has(word)) {
            wordFreq.set(word, (wordFreq.get(word) || 0) + 1);
          }
        }

        const topTopics = Array.from(wordFreq.entries())
          .sort((a, b) => b[1] - a[1])
          .slice(0, 8)
          .map(t => t[0]);

        opportunities.push({
          title: 'YouTube Trending: Content creation using hot topics',
          source: 'youtube-scrape',
          category: 'content',
          description: `Current trending topics: ${topTopics.join(', ')}. Create AI-generated content around these themes for better visibility.`,
          estimatedRevenue: '$50-300/month',
          capitalRequired: '$0-30',
          riskLevel: 'low',
          automationLevel: 'full',
          sourceUrl: 'https://www.youtube.com/feed/trending',
          metadata: {
            trendingTopics: topTopics,
            sampleTitles: titles.slice(0, 5),
            platform: 'youtube',
          },
        });
      }

    } catch (err) {
      console.log(`[ContentScanner] YouTube scrape error: ${(err as Error).message}`);
    }

    return opportunities;
  }

  private async scanYouTubeNiches(): Promise<RawOpportunity[]> {
    // Pre-defined high-automation content niches
    return [
      {
        title: 'YouTube: AI News Aggregator Channel',
        source: 'youtube-analysis',
        category: 'content',
        description: 'Automated daily AI news channel using text-to-speech and automated editing. Aggregate news from TechCrunch, VentureBeat, AI-focused subreddits.',
        estimatedRevenue: '$200-800/month',
        capitalRequired: '$30/month (tools)',
        riskLevel: 'low',
        automationLevel: 'full',
        sourceUrl: 'https://www.youtube.com',
        metadata: {
          niche: 'ai-news',
          frequency: 'daily',
          tools: ['elevenlabs', 'pictory', 'rss-feeds'],
        },
      },
      {
        title: 'YouTube: Ambient/Lo-Fi Music Generation',
        source: 'youtube-analysis',
        category: 'content',
        description: 'Generate lo-fi, ambient, or study music using AI (Suno, Mubert). Upload long-form content for ad revenue.',
        estimatedRevenue: '$100-500/month',
        capitalRequired: '$20/month (Suno/Mubert)',
        riskLevel: 'low',
        automationLevel: 'full',
        sourceUrl: 'https://www.youtube.com',
        metadata: {
          niche: 'music-generation',
          tools: ['suno', 'mubert', 'soundraw'],
          contentLength: 'long-form',
        },
      },
    ];
  }

  // ── TikTok Trends ────────────────────────────────────────────────────────

  private async scanTikTokTrends(): Promise<RawOpportunity[]> {
    console.log(`[ContentScanner] Scanning TikTok trends...`);
    const opportunities: RawOpportunity[] = [];

    try {
      // TikTok doesn't have a public API, so we use alternative trend sources
      const trendSources = [
        this.scanTikTokCreativeCenter(),
        this.scanTikTokTrendingSounds(),
        this.scanTikTokHashtags(),
      ];

      const results = await Promise.allSettled(trendSources);

      for (const result of results) {
        if (result.status === 'fulfilled') {
          opportunities.push(...result.value);
        }
      }

    } catch (err) {
      console.log(`[ContentScanner] TikTok trends error: ${(err as Error).message}`);
    }

    // Always add general TikTok automation opportunities
    opportunities.push(...this.getTikTokAutomationOpportunities());

    return opportunities;
  }

  private async scanTikTokCreativeCenter(): Promise<RawOpportunity[]> {
    const opportunities: RawOpportunity[] = [];

    try {
      // TikTok Creative Center has public trending data
      const response = await fetchWithTimeout('https://ads.tiktok.com/business/creativecenter/inspiration/popular/pc/en', {
        headers: {
          'Accept': 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (response.ok) {
        opportunities.push({
          title: 'TikTok: Creative Center Trend Analysis',
          source: 'tiktok-creative-center',
          category: 'content',
          description: 'Use TikTok Creative Center to identify trending sounds, hashtags, and video formats. Create automated content that follows these patterns.',
          estimatedRevenue: '$50-500/month (Creator Fund + brand deals)',
          capitalRequired: '$0-20',
          riskLevel: 'low',
          automationLevel: 'partial',
          sourceUrl: 'https://ads.tiktok.com/business/creativecenter/inspiration/popular/pc/en',
          metadata: {
            platform: 'tiktok',
            source: 'creative-center',
          },
        });
      }

    } catch (err) {
      console.log(`[ContentScanner] TikTok Creative Center error: ${(err as Error).message}`);
    }

    return opportunities;
  }

  private async scanTikTokTrendingSounds(): Promise<RawOpportunity[]> {
    // Trending sounds discovery via third-party trackers
    return [
      {
        title: 'TikTok: Trending Sound Automation',
        source: 'tiktok-sounds',
        category: 'content',
        description: 'Monitor trending sounds on TikTok and create automated content using them. Use tools like Tokboard or TrendTok for sound discovery.',
        estimatedRevenue: '$100-1000/month',
        capitalRequired: '$0-50',
        riskLevel: 'low',
        automationLevel: 'partial',
        sourceUrl: 'https://tokboard.com',
        metadata: {
          platform: 'tiktok',
          automationType: 'sound-based',
          tools: ['tokboard', 'trendtok'],
        },
      },
    ];
  }

  private async scanTikTokHashtags(): Promise<RawOpportunity[]> {
    const opportunities: RawOpportunity[] = [];

    // High-monetization TikTok niches
    const profitableNiches = [
      { niche: 'finance-tips', hashtags: ['#moneytok', '#financetok', '#investing'], cpm: 'high' },
      { niche: 'ai-tools', hashtags: ['#aitok', '#aitools', '#chatgpt'], cpm: 'high' },
      { niche: 'productivity', hashtags: ['#productivitytok', '#lifehacks'], cpm: 'medium' },
      { niche: 'tech-reviews', hashtags: ['#techtok', '#techreview'], cpm: 'high' },
    ];

    for (const { niche, hashtags, cpm } of profitableNiches) {
      opportunities.push({
        title: `TikTok: ${niche} automated content`,
        source: 'tiktok-hashtags',
        category: 'content',
        description: `Create automated TikTok content in the ${niche} niche using hashtags: ${hashtags.join(', ')}. ${cpm} CPM niche.`,
        estimatedRevenue: cpm === 'high' ? '$200-800/month' : '$100-400/month',
        capitalRequired: '$0-30',
        riskLevel: 'low',
        automationLevel: 'full',
        sourceUrl: `https://www.tiktok.com/tag/${hashtags[0].replace('#', '')}`,
        metadata: {
          platform: 'tiktok',
          niche,
          hashtags,
          cpmLevel: cpm,
        },
      });
    }

    return opportunities;
  }

  private getTikTokAutomationOpportunities(): RawOpportunity[] {
    return [
      {
        title: 'TikTok: AI Avatar Video Generation',
        source: 'tiktok-automation',
        category: 'content',
        description: 'Use AI avatar tools (HeyGen, Synthesia, D-ID) to create faceless TikTok content. Combine with trending sounds and hashtags.',
        estimatedRevenue: '$100-500/month',
        capitalRequired: '$30-100/month (AI tools)',
        riskLevel: 'low',
        automationLevel: 'full',
        sourceUrl: 'https://www.heygen.com',
        metadata: {
          platform: 'tiktok',
          tools: ['heygen', 'synthesia', 'd-id'],
          contentType: 'ai-avatar',
        },
      },
      {
        title: 'TikTok: Automated Story/Fact Compilation',
        source: 'tiktok-automation',
        category: 'content',
        description: 'Create automated fact/story compilation videos using AI voiceover and stock footage. High engagement niche.',
        estimatedRevenue: '$50-300/month',
        capitalRequired: '$20/month',
        riskLevel: 'low',
        automationLevel: 'full',
        sourceUrl: 'https://www.tiktok.com',
        metadata: {
          platform: 'tiktok',
          contentType: 'compilation',
          tools: ['elevenlabs', 'canva', 'capcut'],
        },
      },
    ];
  }

  // ── Content Automation Tools ─────────────────────────────────────────────

  private async scanContentAutomationTools(): Promise<RawOpportunity[]> {
    console.log(`[ContentScanner] Scanning content automation tools...`);
    const opportunities: RawOpportunity[] = [];

    try {
      // Scan Product Hunt for new automation tools
      const phOpps = await this.scanProductHuntAutomation();
      opportunities.push(...phOpps);

    } catch (err) {
      console.log(`[ContentScanner] Content automation scan error: ${(err as Error).message}`);
    }

    // Add known high-value automation tool opportunities
    opportunities.push(...this.getKnownAutomationOpportunities());

    return opportunities;
  }

  private async scanProductHuntAutomation(): Promise<RawOpportunity[]> {
    const opportunities: RawOpportunity[] = [];

    try {
      const response = await fetchWithTimeout('https://www.producthunt.com/topics/artificial-intelligence', {
        headers: {
          'Accept': 'text/html',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });

      if (!response.ok) {
        console.log(`[ContentScanner] Product Hunt returned ${response.status}`);
        return [];
      }

      const html = await response.text();

      // Extract product names and descriptions
      const productPattern = /<h3[^>]*>([^<]+)<\/h3>/gi;
      const products: string[] = [];
      let match;

      while ((match = productPattern.exec(html)) !== null && products.length < 10) {
        products.push(match[1].trim());
      }

      // Filter for content/automation related
      const contentKeywords = ['video', 'content', 'youtube', 'tiktok', 'social', 'automat', 'ai', 'generate'];
      const contentProducts = products.filter(p =>
        contentKeywords.some(k => p.toLowerCase().includes(k))
      );

      if (contentProducts.length > 0) {
        opportunities.push({
          title: 'Product Hunt: New content automation tools',
          source: 'product-hunt',
          category: 'content',
          description: `Recently launched content tools: ${contentProducts.slice(0, 5).join(', ')}. Potential early-mover advantage for automation.`,
          estimatedRevenue: 'TBD (evaluate tools)',
          capitalRequired: 'TBD',
          riskLevel: 'low',
          automationLevel: 'full',
          sourceUrl: 'https://www.producthunt.com/topics/artificial-intelligence',
          metadata: {
            products: contentProducts,
            source: 'product-hunt',
          },
        });
      }

    } catch (err) {
      console.log(`[ContentScanner] Product Hunt scrape error: ${(err as Error).message}`);
    }

    return opportunities;
  }

  private getKnownAutomationOpportunities(): RawOpportunity[] {
    return [
      {
        title: 'Content Automation: Video batch generation pipeline',
        source: 'content-tools',
        category: 'content',
        description: 'Build automated video generation pipeline: RSS feeds → AI script → TTS → Video assembly → Multi-platform upload. Tools: n8n/Make + ElevenLabs + Pictory/InVideo.',
        estimatedRevenue: '$200-1000/month (multiple channels)',
        capitalRequired: '$50-100/month',
        riskLevel: 'low',
        automationLevel: 'full',
        sourceUrl: 'https://n8n.io',
        metadata: {
          pipelineType: 'video-generation',
          tools: ['n8n', 'elevenlabs', 'pictory', 'invideo'],
          platforms: ['youtube', 'tiktok', 'instagram'],
        },
      },
      {
        title: 'Content Automation: Thumbnail generation service',
        source: 'content-tools',
        category: 'content',
        description: 'Offer AI thumbnail generation service for YouTubers. Use DALL-E/Midjourney + templates. Sell on Fiverr or direct.',
        estimatedRevenue: '$100-500/month',
        capitalRequired: '$20/month (AI tools)',
        riskLevel: 'low',
        automationLevel: 'partial',
        sourceUrl: 'https://www.fiverr.com/categories/graphics-design/youtube-thumbnail',
        metadata: {
          serviceType: 'thumbnail-generation',
          tools: ['midjourney', 'dalle', 'canva'],
          marketplace: 'fiverr',
        },
      },
      {
        title: 'Content Automation: Podcast to clips pipeline',
        source: 'content-tools',
        category: 'content',
        description: 'Automated podcast-to-short-clips pipeline. Use Opus Clip or similar to extract viral moments, auto-caption, and post to TikTok/Shorts/Reels.',
        estimatedRevenue: '$100-400/month',
        capitalRequired: '$30/month (Opus Clip)',
        riskLevel: 'low',
        automationLevel: 'full',
        sourceUrl: 'https://www.opus.pro',
        metadata: {
          pipelineType: 'podcast-clips',
          tools: ['opus-clip', 'descript', 'capcut'],
          platforms: ['tiktok', 'youtube-shorts', 'instagram-reels'],
        },
      },
      {
        title: 'Content Automation: Blog to video converter',
        source: 'content-tools',
        category: 'content',
        description: 'Convert blog posts to videos using AI. Scrape trending articles → Generate script → TTS → Video. Monetize via YouTube AdSense.',
        estimatedRevenue: '$50-300/month',
        capitalRequired: '$20/month',
        riskLevel: 'low',
        automationLevel: 'full',
        sourceUrl: 'https://lumen5.com',
        metadata: {
          pipelineType: 'blog-to-video',
          tools: ['lumen5', 'pictory', 'invideo'],
          sourceContent: 'blog-articles',
        },
      },
      {
        title: 'Content Automation: Multi-platform scheduling',
        source: 'content-tools',
        category: 'content',
        description: 'Use Buffer, Later, or Publer for automated cross-platform posting. Generate content once, distribute everywhere.',
        estimatedRevenue: 'Efficiency gain (10+ hours/week saved)',
        capitalRequired: '$15-30/month',
        riskLevel: 'low',
        automationLevel: 'full',
        sourceUrl: 'https://buffer.com',
        metadata: {
          toolType: 'scheduling',
          tools: ['buffer', 'later', 'publer', 'hootsuite'],
          platforms: ['twitter', 'instagram', 'tiktok', 'linkedin'],
        },
      },
      {
        title: 'AI Voice Cloning: Custom TTS for content',
        source: 'content-tools',
        category: 'content',
        description: 'Use ElevenLabs voice cloning to create unique AI voices for content. Offer as service or use for own channels.',
        estimatedRevenue: '$50-200/month (service) or content revenue',
        capitalRequired: '$22/month (ElevenLabs)',
        riskLevel: 'low',
        automationLevel: 'full',
        sourceUrl: 'https://elevenlabs.io',
        metadata: {
          toolType: 'voice-cloning',
          provider: 'elevenlabs',
          useCase: 'content-creation',
        },
      },
    ];
  }
}
