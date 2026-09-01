/**
 * OKX x402 Middleware — Fastify integration for x402 payment protocol.
 *
 * Currently using manual x402 implementation (legacy mode).
 * To migrate to the official @okxweb3/x402-express SDK, set the env vars:
 *   OKX_DEV_API_KEY, OKX_DEV_SECRET_KEY, OKX_DEV_PASSPHRASE
 * from https://web3.okx.com/onchainos/dev-portal
 *
 * NOTE: OKX Exchange API keys (from okx.com account) do NOT work here.
 * The SDK requires OnchainOS Dev Portal credentials specifically.
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const NETWORK = 'eip155:196'; // X Layer Mainnet
const PAY_TO = process.env['OKX_PAY_TO_ADDRESS'] ?? '0x687dd10e8240908069ee760b7a41ac2c451f6031';

const SERVICE_ROUTES: Record<string, { price: string; description: string }> = {
  '/service/text-generation':    { price: '$0.50', description: 'Generate text from a prompt using Claude LLM' },
  '/service/data-summarization': { price: '$0.30', description: 'Summarize a block of text into a concise summary' },
  '/service/web-scraping':       { price: '$0.20', description: 'Fetch and extract structured data from a URL' },
  '/service/code-generation':    { price: '$1.00', description: 'Generate production-quality code from a description' },
};

// ─── Types ────────────────────────────────────────────────────────────────────

type HookableFastify = {
  addHook(event: string, handler: (...args: unknown[]) => unknown): void;
};

type AnyRequest = {
  method?: string;
  url?: string;
  headers?: Record<string, string | string[] | undefined>;
};

type AnyReply = {
  code(n: number): AnyReply;
  header(k: string, v: string): AnyReply;
  send(body: unknown): void;
};

// ─── Main export ──────────────────────────────────────────────────────────────

/**
 * Register OKX x402 payment middleware on a Fastify-compatible server.
 * Uses manual x402 implementation — fully compatible with OKX AI Marketplace.
 */
export async function registerOkxX402Routes(fastify: HookableFastify): Promise<void> {
  registerLegacyMiddleware(fastify);
}

// ─── Manual x402 middleware ───────────────────────────────────────────────────

function registerLegacyMiddleware(fastify: HookableFastify): void {
  fastify.addHook('preHandler', async (rawRequest: unknown, rawReply: unknown): Promise<void> => {
    const req = rawRequest as AnyRequest;
    const rep = rawReply as AnyReply;

    const urlPath = (req.url ?? '').split('?')[0] ?? '';
    if (req.method !== 'POST' || !urlPath.startsWith('/service/')) return;

    const headers = req.headers ?? {};
    if (headers['x-payment'] ?? headers['payment-signature']) return;

    const pathParts = urlPath.split('/').filter(Boolean);
    const serviceId = pathParts[pathParts.length - 1] ?? 'unknown';
    const svc = SERVICE_ROUTES[`/service/${serviceId}`];
    const description = svc?.description ?? `AI Service: ${serviceId}`;

    const protocol = (headers['x-forwarded-proto'] ?? 'https') as string;
    const host = (headers['host'] ?? 'localhost:3001') as string;
    const fullUrl = `${protocol}://${host}${req.url ?? ''}`;

    const challenge = {
      x402Version: 2,
      resource: { url: fullUrl, description, mimeType: 'application/json' },
      accepts: [{
        scheme: 'exact',
        network: NETWORK,
        asset: '0x779ded0c9e1022225f8e0630b35a9b54be713736',
        amount: '500000',
        payTo: PAY_TO,
        maxTimeoutSeconds: 300,
        extra: { name: 'USD₮0', version: '1' },
      }],
    };

    const challengeBase64 = Buffer.from(JSON.stringify(challenge)).toString('base64');
    rep.code(402)
      .header('PAYMENT-REQUIRED', challengeBase64)
      .header('Content-Type', 'application/json')
      .send({ error: 'Payment Required', x402Version: 2, challenge: challengeBase64 });
  });

  console.log('[OKX-x402] Manual x402 middleware registered ✅');
}

// ─── Legacy exports for backward compatibility ────────────────────────────────

export interface OkxX402Config {
  payToAddress: string;
  network: string;
  assetAddress: string;
  services: Record<string, { price: string; description: string }>;
}

export function createOkxX402Middleware(_config: OkxX402Config) {
  return async (_request: unknown, _reply: unknown): Promise<void> => {
    // No-op — replaced by registerOkxX402Routes
  };
}

export function getDefaultOkxX402Config(): OkxX402Config {
  return {
    payToAddress: PAY_TO,
    network: NETWORK,
    assetAddress: '0x779ded0c9e1022225f8e0630b35a9b54be713736',
    services: {
      'text-generation':    { price: '500000',  description: 'Generate text from a prompt' },
      'data-summarization': { price: '300000',  description: 'Summarize text' },
      'web-scraping':       { price: '200000',  description: 'Extract data from URL' },
      'code-generation':    { price: '1000000', description: 'Generate code from description' },
    },
  };
}
