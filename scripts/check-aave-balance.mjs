// Check Aave balance and wallet status
import { ethers } from 'ethers';

const RPC_URL = process.env.RPC_PROVIDER_URL || 'https://mainnet.base.org';
const WALLET_ADDRESS = '0xae36889c670CaA446bE18ECdC96f7c882e601D81';

// Aave aUSDC on Base
const AUSDC_ADDRESS = '0x4e65fE4DbA92790696d040ac24Aa414708F5c0AB';
const USDC_ADDRESS = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';

const ERC20_ABI = [
  'function balanceOf(address) view returns (uint256)',
  'function decimals() view returns (uint8)',
  'function symbol() view returns (string)'
];

async function main() {
  const provider = new ethers.JsonRpcProvider(RPC_URL);
  
  console.log('=== BALANCE CHECK ===\n');
  console.log(`Wallet: ${WALLET_ADDRESS}\n`);
  
  // Check USDC balance
  const usdc = new ethers.Contract(USDC_ADDRESS, ERC20_ABI, provider);
  const usdcBalance = await usdc.balanceOf(WALLET_ADDRESS);
  console.log(`USDC Balance: $${(Number(usdcBalance) / 1e6).toFixed(2)}`);
  
  // Check aUSDC balance (Aave)
  const aUsdc = new ethers.Contract(AUSDC_ADDRESS, ERC20_ABI, provider);
  const aUsdcBalance = await aUsdc.balanceOf(WALLET_ADDRESS);
  console.log(`aUSDC Balance (Aave): $${(Number(aUsdcBalance) / 1e6).toFixed(2)}`);
  
  // Check ETH balance
  const ethBalance = await provider.getBalance(WALLET_ADDRESS);
  console.log(`ETH Balance: ${ethers.formatEther(ethBalance)} ETH`);
  
  console.log('\n=== STATUS ===');
  if (Number(aUsdcBalance) > 0) {
    console.log('⚠️  HAY FONDOS EN AAVE - Necesitan ser retirados');
  } else {
    console.log('✅ No hay fondos en Aave');
  }
}

main().catch(console.error);
