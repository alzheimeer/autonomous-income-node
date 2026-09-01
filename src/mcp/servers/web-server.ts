/**
 * MCP Web Scraping Server
 *
 * Implements the MCP protocol via stdio, exposing three tools:
 *   - fetch_page:   HTTP GET a URL and return raw HTML, status code and headers
 *   - extract_data: Parse HTML with cheerio and extract data via CSS selectors
 *   - get_json:     HTTP GET a URL expecting a JSON response
 *
 * Requirements: 13.3, 7.3, 8.6
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import axios, { type AxiosRequestConfig } from 'axios';
import * as cheerio from 'cheerio';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15_000;
const MAX_BODY_BYTES = 5 * 1024 * 1024; // 5 MB

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface FetchPageResult {
  html: string;
  statusCode: number;
  headers: Record<string, string>;
}

export interface ExtractDataResult {
  data: Record<string, string[]>;
}

export interface GetJsonResult {
  data: unknown;
  statusCode: number;
}

interface FetchPageInput {
  url: string;
  options?: {
    timeoutMs?: number;
    headers?: Record<string, string>;
    followRedirects?: boolean;
  };
}

interface ExtractDataInput {
  html: string;
  selectors: Record<string, string>; // key → CSS selector
}

interface GetJsonInput {
  url: string;
  headers?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'fetch_page',
    description: 'Fetch an HTTP page and return its HTML content, status code, and response headers',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'Full URL to fetch (must start with http:// or https://)',
        },
        options: {
          type: 'object',
          properties: {
            timeoutMs: {
              type: 'number',
              minimum: 500,
              maximum: 60_000,
              default: DEFAULT_TIMEOUT_MS,
              description: 'Request timeout in milliseconds',
            },
            headers: {
              type: 'object',
              additionalProperties: { type: 'string' },
              description: 'Additional HTTP request headers',
            },
            followRedirects: {
              type: 'boolean',
              default: true,
              description: 'Whether to follow HTTP redirects',
            },
          },
          additionalProperties: false,
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
  {
    name: 'extract_data',
    description: 'Parse HTML and extract text content using CSS selectors via cheerio',
    inputSchema: {
      type: 'object' as const,
      properties: {
        html: {
          type: 'string',
          description: 'Raw HTML string to parse',
        },
        selectors: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Map of { resultKey: "css-selector" } pairs',
        },
      },
      required: ['html', 'selectors'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_json',
    description: 'HTTP GET a URL expecting a JSON response; returns parsed data and status code',
    inputSchema: {
      type: 'object' as const,
      properties: {
        url: {
          type: 'string',
          description: 'Full URL to fetch',
        },
        headers: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Optional HTTP request headers',
        },
      },
      required: ['url'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Core handlers
// ---------------------------------------------------------------------------

/**
 * Normalise an axios headers object to a flat Record<string, string>.
 * Axios headers values can be string | string[] | number | boolean | null.
 */
function flattenHeaders(raw: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (v === null || v === undefined) continue;
    if (Array.isArray(v)) {
      out[k] = v.join(', ');
    } else {
      out[k] = String(v);
    }
  }
  return out;
}

export async function fetchPage(input: FetchPageInput): Promise<FetchPageResult> {
  const { url, options = {} } = input;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

  const config: AxiosRequestConfig = {
    url,
    method: 'GET',
    timeout: timeoutMs,
    maxContentLength: MAX_BODY_BYTES,
    maxBodyLength: MAX_BODY_BYTES,
    responseType: 'text',
    maxRedirects: options.followRedirects === false ? 0 : 10,
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; AutonomousIncomeNode/0.1)',
      ...options.headers,
    },
    // Return the response even for non-2xx status codes so we can relay the code
    validateStatus: () => true,
  };

  const response = await axios(config);

  return {
    html: typeof response.data === 'string' ? response.data : String(response.data),
    statusCode: response.status,
    headers: flattenHeaders(response.headers as Record<string, unknown>),
  };
}

export function extractData(input: ExtractDataInput): ExtractDataResult {
  const $ = cheerio.load(input.html);
  const data: Record<string, string[]> = {};

  for (const [key, selector] of Object.entries(input.selectors)) {
    const values: string[] = [];
    $(selector).each((_index, element) => {
      const text = $(element).text().trim();
      if (text) values.push(text);
    });
    data[key] = values;
  }

  return { data };
}

export async function getJson(input: GetJsonInput): Promise<GetJsonResult> {
  const config: AxiosRequestConfig = {
    url: input.url,
    method: 'GET',
    timeout: DEFAULT_TIMEOUT_MS,
    maxContentLength: MAX_BODY_BYTES,
    responseType: 'json',
    headers: {
      Accept: 'application/json',
      'User-Agent': 'AutonomousIncomeNode/0.1',
      ...input.headers,
    },
    validateStatus: () => true,
  };

  const response = await axios(config);

  return {
    data: response.data,
    statusCode: response.status,
  };
}

// ---------------------------------------------------------------------------
// MCP Server bootstrap
// ---------------------------------------------------------------------------

function createWebServer(): Server {
  const server = new Server(
    { name: 'web-server', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case 'fetch_page': {
          const input = args as unknown as FetchPageInput;
          if (!input.url || typeof input.url !== 'string') {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing required field: url' }) }],
              isError: true,
            };
          }
          const result = await fetchPage(input);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'extract_data': {
          const input = args as unknown as ExtractDataInput;
          if (!input.html || typeof input.html !== 'string') {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing required field: html' }) }],
              isError: true,
            };
          }
          if (!input.selectors || typeof input.selectors !== 'object') {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing required field: selectors (must be an object)' }) }],
              isError: true,
            };
          }
          const result = extractData(input);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'get_json': {
          const input = args as unknown as GetJsonInput;
          if (!input.url || typeof input.url !== 'string') {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing required field: url' }) }],
              isError: true,
            };
          }
          const result = await getJson(input);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        default:
          return {
            content: [{ type: 'text', text: JSON.stringify({ error: `Unknown tool: ${name}` }) }],
            isError: true,
          };
      }
    } catch (err) {
      // Requirement 13.6 — structured error, no unhandled exceptions
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
        isError: true,
      };
    }
  });

  return server;
}

export async function startWebServer(): Promise<void> {
  const server = createWebServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('web-server.ts') ||
    process.argv[1].endsWith('web-server.js'));

if (isMain) {
  startWebServer().catch((err) => {
    process.stderr.write(`Web server fatal error: ${String(err)}\n`);
    process.exit(1);
  });
}
