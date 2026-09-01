/**
 * JSON Schema definitions for the MCP Docker Management server tools.
 * Requirements: 13.5, 13.8
 */

import type { JSONSchemaObject } from '../client/mcp-client.js';

// ---------------------------------------------------------------------------
// provision_container
// ---------------------------------------------------------------------------

export const provisionContainerSchema: JSONSchemaObject = {
  type: 'object',
  properties: {
    image: {
      type: 'string',
      minLength: 1,
      description: 'Docker image name (e.g. "autonomous-income-node:latest")',
    },
    name: {
      type: 'string',
      pattern: '^[a-zA-Z0-9][a-zA-Z0-9_.-]+$',
      description: 'Container name — must be unique on the Docker host',
    },
    env: {
      type: 'object',
      additionalProperties: { type: 'string' },
      description: 'Environment variables to inject into the container',
    },
    ports: {
      type: 'array',
      items: {
        type: 'string',
        pattern: '^\\d+(:\\d+)?(/tcp|/udp)?$',
        description: 'Port mapping in Docker format, e.g. "3000:3000" or "9090"',
      },
      description: 'Optional host-to-container port mappings',
    },
    volumes: {
      type: 'array',
      items: {
        type: 'string',
        description: 'Volume mount in Docker format, e.g. "./data:/app/data"',
      },
      description: 'Optional volume mounts',
    },
  },
  required: ['image', 'name', 'env'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// inspect_container
// ---------------------------------------------------------------------------

export const inspectContainerSchema: JSONSchemaObject = {
  type: 'object',
  properties: {
    containerId: {
      type: 'string',
      minLength: 1,
      description: 'Container ID or name to inspect',
    },
  },
  required: ['containerId'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// stop_container
// ---------------------------------------------------------------------------

export const stopContainerSchema: JSONSchemaObject = {
  type: 'object',
  properties: {
    containerId: {
      type: 'string',
      minLength: 1,
      description: 'Container ID or name to stop and remove',
    },
    removeVolumes: {
      type: 'boolean',
      default: false,
      description: 'If true, also remove anonymous volumes attached to the container',
    },
  },
  required: ['containerId'],
  additionalProperties: false,
};

// ---------------------------------------------------------------------------
// Barrel
// ---------------------------------------------------------------------------

export const DOCKER_SCHEMAS = {
  provision_container: provisionContainerSchema,
  inspect_container: inspectContainerSchema,
  stop_container: stopContainerSchema,
} as const satisfies Record<string, JSONSchemaObject>;
