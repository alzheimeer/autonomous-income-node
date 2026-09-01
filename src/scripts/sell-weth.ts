/**
 * One-time WETH → USDC sell script via Uniswap V3 SwapRouter02 on Base.
 *
 * Sells the entire WETH balance for USDC using the 0.3% fee tier pool.
 * Uses the SwapRouter02 struct with 7 fields (NO deadline field on Base).
 *
 * Usage:
 *   node dist/scripts/sell-weth.js
 *
 * Env vars:
 *   WALLET_PASSWORD  — password to decrypt the keystore
 *   RPC_PROVIDER_URL — Base RPC endpoint
 */

import { JsonRpcProvider, Wallet, Contract, Interface } from 'ethers';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { scryptSync, createDecipheriv } from 'node:crypto';

// ── Constants ─────────────────────────────────────────────────────────────
const WETH = '0x4200000000000000000000000000000000000006';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const SWAP_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const WALLET_ADDRESS = '0xae36889c670CaA446bE18ECdC96f7c882e601D81';
const FEE_TIER = 3000; // 0.3% — most liquid WETH/USDC pool on Base

// Minimum USDC out: $26 (allows ~13% slippage on a ~$30 position)
// USDC has 6 decimals
const MIN_USDC_OUT = 26_000000n;

// ── ABIs ──────────────────────────────────────────────────────────────────
const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

const SWAP_ROUTER_ABI = [
  'function exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) external payable returns (uint256)',
];

// ── Helpers ───────────────────────────────────────────────────────────────

function loadKeystorePath(): string {
  // Try relative path first (from CWD), then absolute Docker path
  const paths = [
    resolve(process.cwd(), 'keys', 'keystore.json'),
    '/app/keys/keystore.json',
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      console.log(`[sell-weth] Loading keystore from: ${p}`);
      return p;
    }
  }

  throw new Error(
    `Keystore not found. Tried:\n  ${paths.join('\n  ')}`,
  );
}

/**
 * Decrypt keystore using AES-256-GCM (same method as ConfigStore).
 * Layout: [ salt (32) | iv (12) | authTag (16) | ciphertext ]
 */
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

async function main(): Promise<void> {
  console.log('═══════════════════════════════════════════════════════');
  console.log('  WETH → USDC Sell Script (Base / Uniswap V3)');
  console.log('═══════════════════════════════════════════════════════\n');

  // ── Load env ──────────────────────────────────────────────────────────
  const password = process.env.WALLET_PASSWORD;
  if (!password) throw new Error('WALLET_PASSWORD env var is required');

  const rpcUrl = process.env.RPC_PROVIDER_URL;
  if (!rpcUrl) throw new Error('RPC_PROVIDER_URL env var is required');

  // ── Connect wallet ────────────────────────────────────────────────────
  console.log('[sell-weth] Decrypting keystore...');
  const keystorePath = loadKeystorePath();
  const keystoreEncrypted = readFileSync(keystorePath, 'utf-8');
  const plaintext = decryptKeystore(keystoreEncrypted, password);
  const envelope = JSON.parse(plaintext) as { address: string; privateKeyHex: string };
  const wallet = new Wallet('0x' + envelope.privateKeyHex);
  console.log(`[sell-weth] Wallet loaded: ${wallet.address}`);

  if (wallet.address.toLowerCase() !== WALLET_ADDRESS.toLowerCase()) {
    console.warn(
      `[sell-weth] WARNING: Wallet address mismatch!\n` +
      `  Expected: ${WALLET_ADDRESS}\n` +
      `  Got:      ${wallet.address}`,
    );
  }

  const provider = new JsonRpcProvider(rpcUrl);
  const signer = wallet.connect(provider);

  // ── Check WETH balance ────────────────────────────────────────────────
  const weth = new Contract(WETH, ERC20_ABI, signer);
  const balance: bigint = await weth.balanceOf(WALLET_ADDRESS);

  console.log(`[sell-weth] WETH balance: ${balance.toString()} (${Number(balance) / 1e18} WETH)`);

  if (balance === 0n) {
    console.log('[sell-weth] No WETH to sell. Exiting.');
    return;
  }

  // ── Check ETH for gas ─────────────────────────────────────────────────
  const ethBalance = await provider.getBalance(WALLET_ADDRESS);
  console.log(`[sell-weth] ETH balance for gas: ${Number(ethBalance) / 1e18} ETH`);

  if (ethBalance < 500_000_000_000_000n) { // 0.0005 ETH minimum
    throw new Error(
      `Insufficient ETH for gas. Have ${ethBalance.toString()}, need at least 0.0005 ETH`,
    );
  }

  // ── Approve SwapRouter02 ──────────────────────────────────────────────
  const allowance: bigint = await weth.allowance(WALLET_ADDRESS, SWAP_ROUTER);

  if (allowance < balance) {
    console.log(`[sell-weth] Approving SwapRouter02 to spend ${balance.toString()} WETH...`);
    const approveTx = await weth.approve(SWAP_ROUTER, balance);
    console.log(`[sell-weth] Approve tx: ${approveTx.hash}`);
    const approveReceipt = await approveTx.wait(1);
    console.log(`[sell-weth] Approve confirmed in block ${approveReceipt.blockNumber}`);
  } else {
    console.log('[sell-weth] Already approved, skipping approve step.');
  }

  // ── Execute Swap ──────────────────────────────────────────────────────
  const swapInterface = new Interface(SWAP_ROUTER_ABI);

  // SwapRouter02 on Base: struct has 7 fields, NO deadline
  // (tokenIn, tokenOut, fee, recipient, amountIn, amountOutMinimum, sqrtPriceLimitX96)
  const calldata = swapInterface.encodeFunctionData('exactInputSingle', [[
    WETH,                // tokenIn
    USDC,                // tokenOut
    FEE_TIER,            // fee (3000 = 0.3%)
    WALLET_ADDRESS,      // recipient
    balance,             // amountIn (full balance)
    MIN_USDC_OUT,        // amountOutMinimum ($26 — allows ~13% slippage)
    0n,                  // sqrtPriceLimitX96 (0 = no limit)
  ]]);

  console.log(`\n[sell-weth] Executing swap:`);
  console.log(`  In:  ${Number(balance) / 1e18} WETH`);
  console.log(`  Out: minimum ${Number(MIN_USDC_OUT) / 1e6} USDC`);
  console.log(`  Fee: ${FEE_TIER / 10000}% tier`);
  console.log(`  Router: ${SWAP_ROUTER}`);

  const tx = await signer.sendTransaction({
    to: SWAP_ROUTER,
    data: calldata,
    gasLimit: 300_000n,
  });

  console.log(`\n[sell-weth] Swap tx submitted: ${tx.hash}`);
  console.log('[sell-weth] Waiting for confirmation...');

  const receipt = await tx.wait(1);

  if (!receipt) {
    throw new Error('Transaction receipt is null — tx may have been dropped');
  }

  if (receipt.status === 1) {
    console.log(`\n✅ [sell-weth] Swap SUCCESS!`);
    console.log(`  Block: ${receipt.blockNumber}`);
    console.log(`  Gas used: ${receipt.gasUsed.toString()}`);
    console.log(`  Tx: https://basescan.org/tx/${tx.hash}`);
  } else {
    console.error(`\n❌ [sell-weth] Swap REVERTED in block ${receipt.blockNumber}`);
    console.error(`  Tx: https://basescan.org/tx/${tx.hash}`);
    process.exit(1);
  }

  // ── Verify final balance ──────────────────────────────────────────────
  const usdcContract = new Contract(USDC, ERC20_ABI, provider);
  const usdcBalance: bigint = await usdcContract.balanceOf(WALLET_ADDRESS);
  const wethAfter: bigint = await weth.balanceOf(WALLET_ADDRESS);

  console.log(`\n[sell-weth] Final balances:`);
  console.log(`  WETH: ${Number(wethAfter) / 1e18}`);
  console.log(`  USDC: ${Number(usdcBalance) / 1e6}`);
  console.log('\nDone.');
}

// ── Entry point ─────────────────────────────────────────────────────────
main().catch((err: unknown) => {
  console.error('\n❌ [sell-weth] FATAL ERROR:');
  if (err instanceof Error) {
    console.error(`  ${err.message}`);
    if (err.message.includes('insufficient funds')) {
      console.error('  → Not enough ETH to cover gas fees');
    }
    if (err.message.includes('STF')) {
      console.error('  → Swap failed (STF = SafeTransferFrom failed). Check token approval.');
    }
    if (err.message.includes('TF')) {
      console.error('  → Transfer failed. The pool may lack liquidity.');
    }
    if (err.message.includes('Too little received')) {
      console.error('  → amountOutMinimum not met. Price moved too much.');
    }
  } else {
    console.error(err);
  }
  process.exit(1);
});
