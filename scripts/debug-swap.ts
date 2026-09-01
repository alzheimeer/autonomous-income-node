/**
 * Debug script: Simulates an exactInputSingle swap via eth_call to get the revert reason.
 * Run with: npx tsx scripts/debug-swap.ts
 */
import { JsonRpcProvider, Interface, Contract, Wallet } from 'ethers';
import 'dotenv/config';

const RPC_URL = process.env['RPC_PROVIDER_URL']!;
const WALLET_ADDRESS = '0xae36889c670CaA446bE18ECdC96f7c882e601D81';
const SWAP_ROUTER = '0x2626664c2603336E57B271c5C0b26F421741e481';
const USDC = '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913';
const WETH = '0x4200000000000000000000000000000000000006';

const SWAP_ROUTER_ABI = [
  'function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external payable returns (uint256 amountOut)',
];

const ERC20_ABI = [
  'function allowance(address owner, address spender) view returns (uint256)',
  'function balanceOf(address account) view returns (uint256)',
  'function approve(address spender, uint256 amount) returns (bool)',
];

async function main() {
  const provider = new JsonRpcProvider(RPC_URL);
  
  console.log('=== SWAP DEBUG ===');
  console.log(`RPC: ${RPC_URL.slice(0, 50)}...`);
  console.log(`Wallet: ${WALLET_ADDRESS}`);
  console.log(`Router: ${SWAP_ROUTER}`);
  console.log('');

  // 1. Check USDC balance
  const usdc = new Contract(USDC, ERC20_ABI, provider);
  const balance = await usdc.balanceOf(WALLET_ADDRESS);
  console.log(`USDC Balance: ${balance} (${Number(balance) / 1e6} USDC)`);

  // 2. Check allowance to SwapRouter02
  const allowance = await usdc.allowance(WALLET_ADDRESS, SWAP_ROUTER);
  console.log(`USDC Allowance to Router: ${allowance} (${Number(allowance) / 1e6} USDC)`);

  // 3. Check ETH balance
  const ethBalance = await provider.getBalance(WALLET_ADDRESS);
  console.log(`ETH Balance: ${ethBalance} (${Number(ethBalance) / 1e18} ETH)`);
  console.log('');

  // 4. Simulate the swap with eth_call
  const swapInterface = new Interface(SWAP_ROUTER_ABI);
  const block = await provider.getBlock('latest');
  const deadline = block!.timestamp + 300;
  const amountIn = 10_000000n; // $10 USDC
  const fee = 3000; // 0.3%

  const calldata = swapInterface.encodeFunctionData('exactInputSingle', [[
    USDC,
    WETH,
    fee,
    WALLET_ADDRESS,
    amountIn,
    0n, // no minimum
    0n, // no price limit
  ]]);

  console.log(`Calldata length: ${calldata.length} chars`);
  console.log(`Function selector: ${calldata.slice(0, 10)}`);
  console.log(`Expected selector for exactInputSingle: 0x414bf389`);
  console.log(`Match: ${calldata.slice(0, 10) === '0x414bf389' ? '✅ YES' : '❌ NO'}`);
  console.log('');

  // 5. eth_call simulation
  console.log('=== SIMULATING SWAP (eth_call) ===');
  try {
    const result = await provider.call({
      from: WALLET_ADDRESS,
      to: SWAP_ROUTER,
      data: calldata,
    });
    console.log(`✅ Simulation SUCCEEDED! Result: ${result}`);
    const decoded = swapInterface.decodeFunctionResult('exactInputSingle', result);
    console.log(`Amount out: ${decoded[0]} (${Number(decoded[0]) / 1e18} WETH)`);
  } catch (err: any) {
    console.log(`❌ Simulation FAILED!`);
    console.log(`Error: ${err.message}`);
    
    // Try to extract revert reason
    if (err.data) {
      console.log(`Revert data: ${err.data}`);
      try {
        // Try decoding as Error(string)
        const errorInterface = new Interface(['function Error(string)']);
        const decoded = errorInterface.decodeFunctionData('Error', err.data);
        console.log(`Revert reason: ${decoded[0]}`);
      } catch {
        // Try as raw bytes
        if (err.data.length > 10) {
          const selector = err.data.slice(0, 10);
          console.log(`Error selector: ${selector}`);
          // Common Uniswap errors:
          // 0x08c379a0 = Error(string)
          // STF = SafeTransferFrom failed
          // T = expired deadline
          if (selector === '0x08c379a0') {
            // Decode Error(string)
            const reason = Buffer.from(err.data.slice(138), 'hex').toString('utf8').replace(/\0/g, '');
            console.log(`Decoded reason: "${reason}"`);
          }
        }
      }
    }
    
    // Also try with info
    if (err.info?.error?.data) {
      console.log(`RPC error data: ${err.info.error.data}`);
    }
    if (err.info?.error?.message) {
      console.log(`RPC error message: ${err.info.error.message}`);
    }
  }

  // 6. Check if the issue is allowance
  console.log('\n=== DIAGNOSIS ===');
  if (balance < amountIn) {
    console.log('❌ INSUFFICIENT USDC BALANCE');
  } else {
    console.log('✅ USDC balance sufficient');
  }

  if (allowance < amountIn) {
    console.log(`❌ INSUFFICIENT ALLOWANCE: ${allowance} < ${amountIn}`);
    console.log('   FIX: Need to approve USDC to SwapRouter02');
    
    // If we have the private key, do the approve
    const walletPassword = process.env['WALLET_PASSWORD'];
    if (walletPassword) {
      console.log('\n   Attempting to check wallet key availability...');
    }
  } else {
    console.log('✅ USDC allowance sufficient');
  }

  // 7. Check if pool exists
  console.log('\n=== POOL CHECK ===');
  const factoryABI = ['function getPool(address, address, uint24) view returns (address)'];
  const factory = new Contract('0x33128a8fC17869897dcE68Ed026d694621f6FDfD', factoryABI, provider);
  
  for (const feeTier of [500, 3000, 10000]) {
    try {
      const poolAddr = await factory.getPool(USDC, WETH, feeTier);
      const exists = poolAddr !== '0x0000000000000000000000000000000000000000';
      console.log(`Fee ${feeTier}: ${exists ? '✅ Pool exists at ' + poolAddr : '❌ No pool'}`);
      
      if (exists) {
        const poolABI = ['function liquidity() view returns (uint128)'];
        const pool = new Contract(poolAddr, poolABI, provider);
        const liq = await pool.liquidity();
        console.log(`   Liquidity: ${liq}`);
      }
    } catch (e: any) {
      console.log(`Fee ${feeTier}: ❌ Error: ${e.message}`);
    }
  }
}

main().catch(console.error);
