/**
 * One-time script to withdraw ALL USDC from Aave V3 on Base.
 *
 * Usage:
 *   npx tsx src/scripts/withdraw-aave.ts
 *
 * Env vars:
 *   WALLET_PASSWORD  — password to decrypt the keystore
 *   RPC_PROVIDER_URL — Base RPC endpoint
 */

import { JsonRpcProvider, Wallet, Contract } from 'ethers';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { scryptSync, createDecipheriv } from 'node:crypto';
import { config } from 'dotenv';

config(); // Load .env

// ── Constants ─────────────────────────────────────────────────────────────
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const aUSDC = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';
const AAVE_V3_POOL = '0xA238Dd80C259a72e81d7e4664a9801593F98d1c5';
const WALLET_ADDRESS = '0xae36889c670CaA446bE18ECdC96f7c882e601D81';

// ── ABIs ──────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
];

const AAVE_POOL_ABI = [
  'function withdraw(address asset, uint256 amount, address to) returns (uint256)',
];

// ── Helpers ───────────────────────────────────────────────────────────────

function loadKeystorePath(): string {
  const paths = [
    resolve(process.cwd(), 'keys', 'keystore.json'),
    '/app/keys/keystore.json',
  ];
  for (const p of paths) {
    if (existsSync(p)) return p;
  }
  throw new Error(`Keystore not found. Tried:\n  ${paths.join('\n  ')}`);
}

function decryptKeystore(encrypted: string, password: string): string {
  const blob = Buffer.from(encrypted, 'base64');
  const SALT_LEN = 32;
  const IV_LEN = 12;
  const TAG_LEN = 16;

  let offset = 0;
  const salt = blob.subarray(offset, (offset += SALT_LEN));
  const iv = blob.subarray(offset, (offset += IV_LEN));
  const authTag = blob.subarray(offset, (offset += TAG_LEN));
  const ciphertext = blob.subarray(offset);

  const key = scryptSync(password, salt, 32, { N: 16384, r: 8, p: 1 });
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(salt);
  decipher.setAuthTag(authTag);

  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return plaintext.toString('utf8');
}

// ── Main ──────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  AAVE V3 WITHDRAW — Retirar todo USDC de Aave');
  console.log('═══════════════════════════════════════════════════════\n');

  const password = process.env['WALLET_PASSWORD'];
  if (!password) throw new Error('WALLET_PASSWORD env var required');

  const rpcUrl = process.env['RPC_PROVIDER_URL'];
  if (!rpcUrl) throw new Error('RPC_PROVIDER_URL env var required');

  // Connect wallet
  console.log('[withdraw-aave] Decrypting keystore...');
  const keystorePath = loadKeystorePath();
  const keystoreEncrypted = readFileSync(keystorePath, 'utf-8');
  const plaintext = decryptKeystore(keystoreEncrypted, password);
  const envelope = JSON.parse(plaintext) as { address: string; privateKeyHex: string };
  const wallet = new Wallet('0x' + envelope.privateKeyHex);
  console.log(`[withdraw-aave] Wallet: ${wallet.address}`);

  const provider = new JsonRpcProvider(rpcUrl);
  const signer = wallet.connect(provider);

  // Check aUSDC balance
  const aToken = new Contract(aUSDC, ERC20_ABI, provider);
  const aBalance: bigint = await aToken.balanceOf(WALLET_ADDRESS);
  console.log(`[withdraw-aave] aUSDC balance: ${aBalance} (${(Number(aBalance) / 1_000_000).toFixed(2)} USDC)`);

  if (aBalance === 0n) {
    console.log('[withdraw-aave] Nothing to withdraw. Done.');
    return;
  }

  // Check USDC balance before
  const usdc = new Contract(USDC, ERC20_ABI, provider);
  const usdcBefore: bigint = await usdc.balanceOf(WALLET_ADDRESS);
  console.log(`[withdraw-aave] USDC before: ${(Number(usdcBefore) / 1_000_000).toFixed(2)}`);

  // Withdraw ALL (use type(uint256).max = withdraw everything)
  const MAX_UINT256 = 2n ** 256n - 1n;
  const pool = new Contract(AAVE_V3_POOL, AAVE_POOL_ABI, signer);

  console.log(`[withdraw-aave] Withdrawing ALL aUSDC from Aave V3...`);
  const tx = await pool.withdraw(USDC, MAX_UINT256, WALLET_ADDRESS);
  console.log(`[withdraw-aave] Tx sent: ${tx.hash}`);
  console.log(`[withdraw-aave] Waiting for confirmation...`);

  const receipt = await tx.wait(1);
  console.log(`[withdraw-aave] ✅ Confirmed in block ${receipt.blockNumber}`);

  // Check balances after
  const usdcAfter: bigint = await usdc.balanceOf(WALLET_ADDRESS);
  const aBalanceAfter: bigint = await aToken.balanceOf(WALLET_ADDRESS);
  const withdrawn = usdcAfter - usdcBefore;

  console.log(`\n═══════════════════════════════════════════════════════`);
  console.log(`  RESULTADO:`);
  console.log(`  USDC retirado: $${(Number(withdrawn) / 1_000_000).toFixed(4)}`);
  console.log(`  USDC wallet ahora: $${(Number(usdcAfter) / 1_000_000).toFixed(2)}`);
  console.log(`  aUSDC restante: $${(Number(aBalanceAfter) / 1_000_000).toFixed(6)}`);
  console.log(`═══════════════════════════════════════════════════════`);
}

main().catch((err) => {
  console.error('[withdraw-aave] ERROR:', err);
  process.exit(1);
});
