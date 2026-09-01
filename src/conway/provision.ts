/**
 * Conway SIWE Provisioning
 *
 * Autentica el agente con Conway usando Sign-In With Ethereum (SIWE).
 * El agente ya tiene una wallet EVM — esa wallet ES su identidad en Conway.
 * No se necesita cuenta manual. El proceso es completamente automático.
 *
 * Flujo:
 * 1. GET /v1/auth/nonce  → nonce aleatorio
 * 2. Firma SIWE con la wallet del agente
 * 3. POST /v1/auth/verify → access_token JWT
 * 4. POST /v1/auth/api-keys → cnwy_k_... API key
 */

import axios from 'axios';

export const CONWAY_API_URL = process.env['CONWAY_API_URL'] ?? 'https://api.conway.tech';

export interface ConwayProvisionResult {
  apiKey: string;
  walletAddress: string;
  keyPrefix: string;
}

/**
 * Construye un mensaje SIWE compatible con EIP-4361.
 * No depende del package 'siwe' — implementación manual.
 */
function buildSiweMessage(params: {
  domain: string;
  address: string;
  statement: string;
  uri: string;
  version: string;
  chainId: number;
  nonce: string;
  issuedAt: string;
}): string {
  return [
    `${params.domain} wants you to sign in with your Ethereum account:`,
    params.address,
    '',
    params.statement,
    '',
    `URI: ${params.uri}`,
    `Version: ${params.version}`,
    `Chain ID: ${params.chainId}`,
    `Nonce: ${params.nonce}`,
    `Issued At: ${params.issuedAt}`,
  ].join('\n');
}

/**
 * Tipo mínimo para una cuenta EVM capaz de firmar mensajes.
 */
export interface SignableAccount {
  address: string;
  signMessage(args: { message: string }): Promise<string>;
}

/**
 * Provisiona una API key de Conway usando SIWE.
 * La wallet del agente firma el challenge — sin formularios, sin email.
 */
export async function provisionConwayApiKey(
  account: SignableAccount,
  apiUrl: string = CONWAY_API_URL,
): Promise<ConwayProvisionResult> {
  // 1. Obtener nonce
  const nonceResp = await axios.post<{ nonce: string }>(`${apiUrl}/v1/auth/nonce`, {}, {
    timeout: 10_000,
  });
  const { nonce } = nonceResp.data;

  // 2. Construir y firmar mensaje SIWE
  const issuedAt = new Date().toISOString();
  const messageString = buildSiweMessage({
    domain: 'conway.tech',
    address: account.address,
    statement: 'Sign in to Conway as an Automaton to provision an API key.',
    uri: `${apiUrl}/v1/auth/verify`,
    version: '1',
    chainId: 8453,
    nonce,
    issuedAt,
  });

  const signature = await account.signMessage({ message: messageString });

  // 3. Verificar firma → JWT
  const verifyResp = await axios.post<{ access_token: string }>(
    `${apiUrl}/v1/auth/verify`,
    { message: messageString, signature },
    { timeout: 10_000 },
  );
  const { access_token } = verifyResp.data;

  // 4. Crear API key permanente
  const keyResp = await axios.post<{ key: string; key_prefix: string }>(
    `${apiUrl}/v1/auth/api-keys`,
    { name: 'autonomous-income-node' },
    {
      headers: { Authorization: `Bearer ${access_token}` },
      timeout: 10_000,
    },
  );

  return {
    apiKey: keyResp.data.key,
    walletAddress: account.address,
    keyPrefix: keyResp.data.key_prefix,
  };
}

/**
 * Verifica si una API key de Conway es válida.
 */
export async function verifyConwayApiKey(
  apiKey: string,
  apiUrl: string = CONWAY_API_URL,
): Promise<boolean> {
  try {
    await axios.get(`${apiUrl}/v1/credits/balance`, {
      headers: { Authorization: apiKey },
      timeout: 5_000,
    });
    return true;
  } catch {
    return false;
  }
}
