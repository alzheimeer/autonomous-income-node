/**
 * JSON Schema definitions for the MCP Web Scraping server tools.
 * Requirements: 13.3, 13.8
 */

import type { JSONSchemaObject } from '../client/mcp-client.js';

// ---------------------------------------------------------------------------
// fetch_page
// ---------------------------------------------------------------------------

export const fetchPageSchema: JSONSchemaObject = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      format: 'uri',
      description: 'Full URL of the page to fetch',
    },
    selector: {
      type: 'string',
      description: 'Optional CSS selector to extract a specific DOM subtree',
    },
  },
  required: ['url'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// extract_data
// ---------------------------------------------------------------------------

export const extractDataSchema: JSONSchemaObject = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      format: 'uri',
      description: 'Full URL of the page to scrape',
    },
    selectors: {
      type: 'object',
      additionalProperties: { type: 'string' },
      minProperties: 1,
      description:
        'Map of { fieldName: cssSelector }. Each selector is evaluated against the page.',
    },
  },
  required: ['url', 'selectors'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// get_json
// ---------------------------------------------------------------------------

export const getJsonSchema: JSONSchemaObject = {
  type: 'object',
  properties: {
    url: {
      type: 'string',
      format: 'uri',
      description: 'URL of the JSON endpoint to fetch',
    },
    headers: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Optional HTTP headers to send with the request',
    },
  },
  required: ['url'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const WEB_SCHEMAS = {
  fetch_page: fetchPageSchema,
  extract_data: extractDataSchema,
  get_json: getJsonSchema,
} as const satisfies Record<string, JSONSchemaObject>;
