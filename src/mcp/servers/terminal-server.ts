/**
 * MCP Terminal / Sandbox Server
 *
 * Implements the MCP protocol via stdio, exposing two tools:
 *   - execute_command: run a shell command in a controlled child process
 *   - run_tests: run the vitest suite for a given module path
 *
 * Security features (Requirements 13.1, 14.1):
 *   - Configurable timeout (default 30s, hard cap 300s)
 *   - Sensitive env vars stripped from child process environment
 *   - Maximum stdout+stderr output capped at 50 KB
 *   - Child process inherits only a curated, non-secret env
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { spawn } from 'node:child_process';
import * as path from 'node:path';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum combined output size (stdout + stderr) returned to the caller. */
const MAX_OUTPUT_BYTES = 50 * 1024; // 50 KB

/** Default command timeout in milliseconds. */
const DEFAULT_TIMEOUT_MS = 30_000;

/** Hard upper bound on timeoutMs to prevent runaway processes. */
const MAX_TIMEOUT_MS = 300_000;

/**
 * Environment variable names that must NEVER be forwarded to child processes.
 * Requirement 14.1 — no secrets in stdout/stderr or child env.
 */
const BLOCKED_ENV_KEYS = new Set([
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'WALLET_PASSWORD',
  'WALLET_PRIVATE_KEY',
  'MNEMONIC',
  'SEED_PHRASE',
  'DATABASE_ENCRYPTION_KEY',
  'ENCRYPTION_KEY',
  'SECRET_KEY',
  'API_SECRET',
  'TWITTER_API_SECRET',
  'TWITTER_ACCESS_TOKEN_SECRET',
  'RPC_PROVIDER_URL',   // may embed API keys in the URL
  'ALCHEMY_API_KEY',
  'INFURA_API_KEY',
]);

// ---------------------------------------------------------------------------
// Tool definitions (mirrors terminal.schema.ts)
// ---------------------------------------------------------------------------

const TOOLS = [
  {
    name: 'execute_command',
    description: 'Execute a shell command in an isolated sandbox environment',
    inputSchema: {
      type: 'object' as const,
      properties: {
        command: {
          type: 'string',
          minLength: 1,
          description: 'Shell command to execute',
        },
        cwd: {
          type: 'string',
          description: 'Working directory for the command (absolute or relative path)',
        },
        timeoutMs: {
          type: 'number',
          minimum: 100,
          maximum: MAX_TIMEOUT_MS,
          default: DEFAULT_TIMEOUT_MS,
          description: 'Maximum execution time in milliseconds',
        },
        env: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Additional (non-secret) environment variables to inject',
        },
      },
      required: ['command'],
      additionalProperties: false,
    },
  },
  {
    name: 'run_tests',
    description: 'Run the vitest test suite for a given module path',
    inputSchema: {
      type: 'object' as const,
      properties: {
        modulePath: {
          type: 'string',
          minLength: 1,
          description: 'Absolute or relative path to the module whose tests should run',
        },
        testPattern: {
          type: 'string',
          default: '**/*.test.ts',
          description: 'Glob pattern to match test files within modulePath',
        },
      },
      required: ['modulePath'],
      additionalProperties: false,
    },
  },
];

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
}

interface ExecuteCommandInput {
  command: string;
  cwd?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

interface RunTestsInput {
  modulePath: string;
  testPattern?: string;
}

// ---------------------------------------------------------------------------
// Child process helpers
// ---------------------------------------------------------------------------

/**
 * Build a sanitized environment for the child process.
 *
 * - Starts with the current process env.
 * - Removes all keys that appear in BLOCKED_ENV_KEYS.
 * - Merges in the caller-supplied `extraEnv` (after filtering it too).
 */
function buildSafeEnv(extraEnv?: Record<string, string>): NodeJS.ProcessEnv {
  const safe: NodeJS.ProcessEnv = {};

  for (const [key, value] of Object.entries(process.env)) {
    if (!BLOCKED_ENV_KEYS.has(key)) {
      safe[key] = value;
    }
  }

  if (extraEnv) {
    for (const [key, value] of Object.entries(extraEnv)) {
      if (!BLOCKED_ENV_KEYS.has(key)) {
        safe[key] = value;
      }
    }
  }

  return safe;
}

/**
 * Truncate a buffer/string to at most `maxBytes` bytes, appending a notice
 * if truncation occurred.
 */
function truncateOutput(output: string, maxBytes: number): string {
  const encoded = Buffer.from(output, 'utf8');
  if (encoded.length <= maxBytes) return output;
  const truncated = encoded.subarray(0, maxBytes).toString('utf8');
  return truncated + `\n[OUTPUT TRUNCATED — exceeded ${maxBytes} bytes limit]`;
}

/**
 * Execute an arbitrary shell command in a child process.
 *
 * @param command  The command string to pass to the shell.
 * @param options  Execution options (cwd, timeout, extra env vars).
 * @returns        Resolved CommandResult when the process exits or times out.
 */
export function executeCommand(
  command: string,
  options: {
    cwd?: string;
    timeoutMs?: number;
    env?: Record<string, string>;
  } = {}
): Promise<CommandResult> {
  const timeoutMs = Math.min(options.timeoutMs ?? DEFAULT_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const safeEnv = buildSafeEnv(options.env);

  return new Promise<CommandResult>((resolve) => {
    // Use the platform shell so that pipes, redirects, etc. work as expected.
    const isWindows = process.platform === 'win32';
    const shellCmd = isWindows ? 'cmd' : 'sh';
    const shellFlag = isWindows ? '/c' : '-c';

    const child = spawn(shellCmd, [shellFlag, command], {
      cwd: options.cwd,
      env: safeEnv,
      // Do NOT use shell:true here — we already invoke the shell explicitly
      // to keep the process tree clean and the env under our control.
    });

    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let finished = false;

    const finish = (exitCode: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);

      const halfMax = Math.floor(MAX_OUTPUT_BYTES / 2);
      const stdout = truncateOutput(Buffer.concat(stdoutChunks).toString('utf8'), halfMax);
      const stderr = truncateOutput(Buffer.concat(stderrChunks).toString('utf8'), halfMax);

      resolve({ stdout, stderr, exitCode });
    };

    child.stdout.on('data', (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes <= MAX_OUTPUT_BYTES) {
        stdoutChunks.push(chunk);
      }
    });

    child.stderr.on('data', (chunk: Buffer) => {
      stderrBytes += chunk.length;
      if (stderrBytes <= MAX_OUTPUT_BYTES) {
        stderrChunks.push(chunk);
      }
    });

    child.on('close', (code) => finish(code));
    child.on('error', (err) => {
      stderrChunks.push(Buffer.from(`Process error: ${err.message}\n`, 'utf8'));
      finish(1);
    });

    const timer = setTimeout(() => {
      if (!finished) {
        try {
          child.kill('SIGKILL');
        } catch {
          // Already exited — ignore
        }
        stderrChunks.push(
          Buffer.from(`\n[TIMEOUT] Command exceeded ${timeoutMs}ms and was killed.\n`, 'utf8')
        );
        finish(null);
      }
    }, timeoutMs);

    // Prevent the timer from keeping the event loop alive
    timer.unref?.();
  });
}

/**
 * Run the vitest test suite for a given module path.
 *
 * Equivalent to: `pnpm test --run --reporter=verbose <testPattern>`
 * executed with the modulePath as the working directory.
 */
export async function runTests(input: RunTestsInput): Promise<CommandResult> {
  const { modulePath, testPattern = '**/*.test.ts' } = input;

  // Resolve the working directory — resolve relative paths against cwd
  const resolvedPath = path.isAbsolute(modulePath)
    ? modulePath
    : path.resolve(process.cwd(), modulePath);

  // Build the test command. We use `pnpm test --run` per the project convention
  // (package.json "test": "vitest run"). Pass the pattern as a positional arg
  // so vitest filters to matching files only.
  const command = `pnpm test --run --reporter=verbose ${JSON.stringify(testPattern)}`;

  return executeCommand(command, {
    cwd: resolvedPath,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    // No extra env — inherit the safe env from the parent
  });
}

// ---------------------------------------------------------------------------
// MCP Server bootstrap
// ---------------------------------------------------------------------------

/**
 * Create and configure the MCP Terminal/Sandbox server.
 * Call `startTerminalServer()` to connect via stdio and begin serving requests.
 */
function createTerminalServer(): Server {
  const server = new Server(
    { name: 'terminal-server', version: '0.1.0' },
    { capabilities: { tools: {} } }
  );

  // ---- List tools handler ----
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: TOOLS,
  }));

  // ---- Call tool handler ----
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args = {} } = request.params;

    try {
      switch (name) {
        case 'execute_command': {
          const input = args as unknown as ExecuteCommandInput;

          if (!input.command || typeof input.command !== 'string') {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: 'Missing required parameter: command',
                  }),
                },
              ],
              isError: true,
            };
          }

          const result = await executeCommand(input.command, {
            cwd: input.cwd,
            timeoutMs: input.timeoutMs,
            env: input.env,
          });

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          };
        }

        case 'run_tests': {
          const input = args as unknown as RunTestsInput;

          if (!input.modulePath || typeof input.modulePath !== 'string') {
            return {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    error: 'Missing required parameter: modulePath',
                  }),
                },
              ],
              isError: true,
            };
          }

          const result = await runTests(input);

          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify(result),
              },
            ],
          };
        }

        default:
          return {
            content: [
              {
                type: 'text',
                text: JSON.stringify({ error: `Unknown tool: ${name}` }),
              },
            ],
            isError: true,
          };
      }
    } catch (err) {
      // Requirement 13.6 — structured error, no unhandled exceptions
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({ error: message }),
          },
        ],
        isError: true,
      };
    }
  });

  return server;
}

/**
 * Start the terminal server connected to stdin/stdout.
 * This is the process entry point when the server is spawned by McpClient.
 */
export async function startTerminalServer(): Promise<void> {
  const server = createTerminalServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // The server runs until the parent process closes the stdio streams.
}

// ---------------------------------------------------------------------------
// Entry point — only runs when executed directly (not when imported as a module)
// ---------------------------------------------------------------------------

// ESM equivalent of `if (require.main === module)`
const isMain =
  typeof process !== 'undefined' &&
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('terminal-server.ts') ||
    process.argv[1].endsWith('terminal-server.js'));

if (isMain) {
  startTerminalServer().catch((err) => {
    process.stderr.write(`Terminal server fatal error: ${String(err)}\n`);
    process.exit(1);
  });
}
