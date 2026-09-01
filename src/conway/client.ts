/**
 * Conway API Client
 *
 * Cliente para la API de Conway Cloud — sandboxes, créditos, inference.
 * Portado del original Conway-Research/automaton con adaptaciones para
 * autonomous-income-node (sin dependencia de `conway` package).
 *
 * Endpoints usados:
 *   GET  /v1/credits/balance          → balance de créditos en centavos
 *   POST /v1/credits/transfer         → transferir créditos a otro agente
 *   GET  /v1/sandboxes                → listar sandboxes
 *   POST /v1/sandboxes                → crear sandbox
 *   POST /v1/sandboxes/:id/exec       → ejecutar comando en sandbox
 */

import axios, { type AxiosInstance } from 'axios';
import { CONWAY_API_URL } from './provision.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ConwayCreditBalance {
  balanceCents: number;
  walletAddress: string;
}

export interface ConwayTransferResult {
  transferId: string;
  status: string;
  toAddress: string;
  amountCents: number;
  balanceAfterCents?: number;
}

export interface ConwaySandboxInfo {
  id: string;
  status: string;
  region: string;
  vcpu: number;
  memoryMb: number;
  diskGb: number;
  terminalUrl?: string;
  createdAt: string;
}

export interface ConwayExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

// ---------------------------------------------------------------------------
// ConwayClient
// ---------------------------------------------------------------------------

export class ConwayClient {
  private readonly http: AxiosInstance;

  constructor(
    private readonly apiKey: string,
    private readonly apiUrl: string = CONWAY_API_URL,
  ) {
    this.http = axios.create({
      baseURL: apiUrl,
      headers: {
        Authorization: apiKey,
        'Content-Type': 'application/json',
      },
      timeout: 15_000,
    });
  }

  // ── Credits ──────────────────────────────────────────────────────────────

  /**
   * Obtener balance de créditos en centavos (100 = $1.00).
   */
  async getCreditsBalance(): Promise<number> {
    const resp = await this.http.get<{ balance_cents?: number; credits_cents?: number }>(
      '/v1/credits/balance',
    );
    return resp.data.balance_cents ?? resp.data.credits_cents ?? 0;
  }

  /**
   * Transferir créditos a otra wallet/agente.
   */
  async transferCredits(
    toAddress: string,
    amountCents: number,
    note?: string,
  ): Promise<ConwayTransferResult> {
    const resp = await this.http.post<{
      transfer_id?: string;
      id?: string;
      status?: string;
      to_address?: string;
      amount_cents?: number;
      balance_after_cents?: number;
    }>('/v1/credits/transfer', {
      to_address: toAddress,
      amount_cents: amountCents,
      note,
    });

    return {
      transferId: resp.data.transfer_id ?? resp.data.id ?? '',
      status: resp.data.status ?? 'submitted',
      toAddress: resp.data.to_address ?? toAddress,
      amountCents: resp.data.amount_cents ?? amountCents,
      balanceAfterCents: resp.data.balance_after_cents,
    };
  }

  // ── Sandboxes ─────────────────────────────────────────────────────────────

  /**
   * Listar sandboxes del agente.
   */
  async listSandboxes(): Promise<ConwaySandboxInfo[]> {
    const resp = await this.http.get<ConwaySandboxInfo[] | { sandboxes: ConwaySandboxInfo[] }>(
      '/v1/sandboxes',
    );
    const data = resp.data;
    const sandboxes = Array.isArray(data) ? data : data.sandboxes ?? [];
    return sandboxes.map((s: any) => ({
      id: s.id ?? s.sandbox_id,
      status: s.status ?? 'unknown',
      region: s.region ?? '',
      vcpu: s.vcpu ?? 0,
      memoryMb: s.memory_mb ?? 0,
      diskGb: s.disk_gb ?? 0,
      terminalUrl: s.terminal_url,
      createdAt: s.created_at ?? '',
    }));
  }

  /**
   * Crear un sandbox nuevo.
   */
  async createSandbox(opts: {
    name?: string;
    vcpu?: number;
    memoryMb?: number;
    diskGb?: number;
  }): Promise<ConwaySandboxInfo> {
    const resp = await this.http.post<any>('/v1/sandboxes', {
      name: opts.name,
      vcpu: opts.vcpu ?? 1,
      memory_mb: opts.memoryMb ?? 512,
      disk_gb: opts.diskGb ?? 5,
    });
    return {
      id: resp.data.id ?? resp.data.sandbox_id,
      status: resp.data.status ?? 'running',
      region: resp.data.region ?? '',
      vcpu: resp.data.vcpu ?? 1,
      memoryMb: resp.data.memory_mb ?? 512,
      diskGb: resp.data.disk_gb ?? 5,
      terminalUrl: resp.data.terminal_url,
      createdAt: resp.data.created_at ?? new Date().toISOString(),
    };
  }

  /**
   * Ejecutar un comando en un sandbox.
   */
  async execInSandbox(sandboxId: string, command: string, timeoutMs = 30_000): Promise<ConwayExecResult> {
    const resp = await this.http.post<any>(
      `/v1/sandboxes/${sandboxId}/exec`,
      { command: `cd /root && ${command}`, timeout: timeoutMs },
      { timeout: timeoutMs + 5_000 },
    );
    return {
      stdout: resp.data.stdout ?? '',
      stderr: resp.data.stderr ?? '',
      exitCode: resp.data.exit_code ?? resp.data.exitCode ?? -1,
    };
  }

  // ── Agents / Registry ─────────────────────────────────────────────────────

  /**
   * Registrar el agente en Conway (solo primera vez).
   */
  async registerAgent(params: {
    agentId: string;
    agentAddress: string;
    creatorAddress: string;
    name: string;
    bio?: string;
  }): Promise<void> {
    try {
      await this.http.post('/v1/automatons/register', {
        automaton_id: params.agentId,
        automaton_address: params.agentAddress,
        creator_address: params.creatorAddress,
        name: params.name,
        bio: params.bio ?? '',
      });
    } catch (err: any) {
      // 409 = ya registrado, está bien
      if (err?.response?.status !== 409) {
        console.warn('[ConwayClient] Agent registration failed (non-fatal):', err?.message);
      }
    }
  }

  /**
   * Descubrir otros agentes en la red Conway.
   */
  async discoverAgents(limit = 10): Promise<Array<{ address: string; name: string; bio?: string }>> {
    try {
      const resp = await this.http.get<any>('/v1/automatons', { params: { limit } });
      const agents = Array.isArray(resp.data) ? resp.data : resp.data?.automatons ?? [];
      return agents.map((a: any) => ({
        address: a.automaton_address ?? a.address,
        name: a.name ?? 'Unknown',
        bio: a.bio,
      }));
    } catch {
      return [];
    }
  }

  /**
   * Obtener el balance de créditos en formato legible.
   */
  async getFormattedBalance(): Promise<string> {
    const cents = await this.getCreditsBalance();
    return `$${(cents / 100).toFixed(2)} Conway Credits`;
  }

  /** Verificar que la API key funciona. */
  async ping(): Promise<boolean> {
    try {
      await this.getCreditsBalance();
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * Crear un ConwayClient desde variables de entorno.
 */
export function createConwayClient(apiKey?: string): ConwayClient | null {
  const key = apiKey ?? process.env['CONWAY_API_KEY'];
  if (!key) return null;
  return new ConwayClient(key);
}
