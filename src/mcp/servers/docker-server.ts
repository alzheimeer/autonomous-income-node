/**
 * MCP Docker Management Server
 *
 * Implements the MCP protocol via stdio, exposing three tools:
 *   - provision_container: create and start a new Docker container
 *   - inspect_container:   get status and metadata of a running container
 *   - stop_container:      stop (and optionally remove) a container
 *
 * Uses `dockerode` to communicate with the Docker daemon.
 * If Docker is unavailable, every tool returns a structured error without
 * throwing an unhandled exception (Requirement 13.6).
 *
 * The socket path defaults to the platform default but can be overridden
 * via DOCKER_SOCKET_PATH (Requirement 15.6).
 *
 * Requirements: 13.5, 10.2, 15.6
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import Dockerode from 'dockerode';

// ---------------------------------------------------------------------------
// Docker client singleton
// ---------------------------------------------------------------------------

function createDockerClient(): Dockerode {
  const socketPath = process.env['DOCKER_SOCKET_PATH'];

  if (socketPath) {
    return new Dockerode({ socketPath });
  }

  // Let dockerode use its platform default (/var/run/docker.sock on Linux/Mac,
  // npipe://./pipe/docker_engine on Windows).
  return new Dockerode();
}

let dockerClient: Dockerode | null = null;

function getDocker(): Dockerode {
  if (!dockerClient) {
    dockerClient = createDockerClient();
  }
  return dockerClient;
}

/**
 * Ping Docker daemon and return true if reachable.
 * Requirement 13.5 — graceful unavailability handling.
 */
async function isDockerAvailable(): Promise<boolean> {
  try {
    await getDocker().ping();
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProvisionContainerInput {
  image: string;
  name: string;
  env: Record<string, string>;
  ports?: string[];   // e.g. ["3000:3000", "9090:9090"]
  volumes?: string[]; // e.g. ["./data:/app/data"]
}

export interface ProvisionContainerResult {
  containerId: string;
  status: string;
}

export interface InspectContainerInput {
  containerId: string;
}

export interface InspectContainerResult {
  status: string;
  started: string | null;
  image: string;
  ports: Record<string, string>;
}

export interface StopContainerInput {
  containerId: string;
  removeVolumes?: boolean;
}

export interface StopContainerResult {
  success: boolean;
}

// ---------------------------------------------------------------------------
// Tool definitions
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'provision_container',
    description: 'Create and start a new Docker container for a child agent',
    inputSchema: {
      type: 'object' as const,
      properties: {
        image: {
          type: 'string',
          description: 'Docker image to use (e.g. "autonomous-income-node:latest")',
        },
        name: {
          type: 'string',
          description: 'Unique name for the container',
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Environment variables to inject into the container',
        },
        ports: {
          type: 'array',
          items: { type: 'string' },
          description: 'Port mappings in "hostPort:containerPort" format',
        },
        volumes: {
          type: 'array',
          items: { type: 'string' },
          description: 'Volume mounts in "hostPath:containerPath" format',
        },
      },
      required: ['image', 'name', 'env'],
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_container',
    description: 'Get status, start time, image and exposed ports of a container',
    inputSchema: {
      type: 'object' as const,
      properties: {
        containerId: {
          type: 'string',
          description: 'Container ID or name',
        },
      },
      required: ['containerId'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_container',
    description: 'Stop and remove a running container',
    inputSchema: {
      type: 'object' as const,
      properties: {
        containerId: {
          type: 'string',
          description: 'Container ID or name',
        },
        removeVolumes: {
          type: 'boolean',
          default: false,
          description: 'If true, also remove any anonymous volumes attached to the container',
        },
      },
      required: ['containerId'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Core handlers
// ---------------------------------------------------------------------------

export async function provisionContainer(
  input: ProvisionContainerInput
): Promise<ProvisionContainerResult> {
  const docker = getDocker();

  // Parse port bindings
  const exposedPorts: Record<string, object> = {};
  const portBindings: Record<string, Array<{ HostPort: string }>> = {};

  for (const mapping of input.ports ?? []) {
    const [hostPort, containerPort] = mapping.split(':');
    const containerKey = containerPort.includes('/') ? containerPort : `${containerPort}/tcp`;
    exposedPorts[containerKey] = {};
    portBindings[containerKey] = [{ HostPort: hostPort }];
  }

  // Parse volume bindings
  const binds: string[] = input.volumes ?? [];

  // Build env array
  const envArray = Object.entries(input.env).map(([k, v]) => `${k}=${v}`);

  const container = await docker.createContainer({
    Image: input.image,
    name: input.name,
    Env: envArray,
    ExposedPorts: exposedPorts,
    HostConfig: {
      PortBindings: portBindings,
      Binds: binds,
      RestartPolicy: { Name: 'unless-stopped' },
    },
  });

  await container.start();

  return {
    containerId: container.id,
    status: 'running',
  };
}

export async function inspectContainer(
  input: InspectContainerInput
): Promise<InspectContainerResult> {
  const docker = getDocker();
  const container = docker.getContainer(input.containerId);
  const info = await container.inspect();

  // Build port map: containerPort → hostPort
  const ports: Record<string, string> = {};
  const networkPorts = info.NetworkSettings?.Ports ?? {};
  for (const [containerPort, bindings] of Object.entries(networkPorts)) {
    if (bindings && bindings.length > 0) {
      ports[containerPort] = bindings[0]?.HostPort ?? '';
    }
  }

  return {
    status: info.State?.Status ?? 'unknown',
    started: info.State?.StartedAt ?? null,
    image: info.Config?.Image ?? info.Image,
    ports,
  };
}

export async function stopContainer(
  input: StopContainerInput
): Promise<StopContainerResult> {
  const docker = getDocker();
  const container = docker.getContainer(input.containerId);

  try {
    await container.stop({ t: 10 }); // 10s grace period
  } catch (err) {
    // If already stopped, Docker returns 304 — treat as success
    const message = err instanceof Error ? err.message : String(err);
    if (!message.includes('304') && !message.toLowerCase().includes('not running')) {
      throw err;
    }
  }

  await container.remove({ v: input.removeVolumes ?? false, force: true });

  return { success: true };
}

// ---------------------------------------------------------------------------
// MCP Server bootstrap
// ---------------------------------------------------------------------------

function createDockerServer(): Server {
  const server = new Server(
    { name: 'docker-server', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    // Check Docker availability before every call (graceful degradation)
    const dockerReady = await isDockerAvailable();
    if (!dockerReady) {
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              error: 'Docker daemon is not available. Is Docker running?',
              code: 'DOCKER_UNAVAILABLE',
            }),
          },
        ],
        isError: true,
      };
    }

    try {
      switch (name) {
        case 'provision_container': {
          const input = args as unknown as ProvisionContainerInput;
          if (!input.image || !input.name || !input.env) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing required fields: image, name, env' }) }],
              isError: true,
            };
          }
          const result = await provisionContainer(input);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'inspect_container': {
          const input = args as unknown as InspectContainerInput;
          if (!input.containerId) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing required field: containerId' }) }],
              isError: true,
            };
          }
          const result = await inspectContainer(input);
          return { content: [{ type: 'text', text: JSON.stringify(result) }] };
        }

        case 'stop_container': {
          const input = args as unknown as StopContainerInput;
          if (!input.containerId) {
            return {
              content: [{ type: 'text', text: JSON.stringify({ error: 'Missing required field: containerId' }) }],
              isError: true,
            };
          }
          const result = await stopContainer(input);
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

export async function startDockerServer(): Promise<void> {
  const server = createDockerServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('docker-server.ts') ||
    process.argv[1].endsWith('docker-server.js'));

if (isMain) {
  startDockerServer().catch((err) => {
    process.stderr.write(`Docker server fatal error: ${String(err)}\n`);
    process.exit(1);
  });
}
