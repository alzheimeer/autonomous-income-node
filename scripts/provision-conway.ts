/**
 * Script de provisioning de Conway — versión sin viem
 * Usa ethers.js que ya está en node_modules del proyecto
 */

import { provisionConwayApiKey, verifyConwayApiKey, CONWAY_API_URL } from '../src/conway/provision.js';
import { ConfigStore } from '../src/config/config-store.js';
import { existsSync } from 'fs';
import { resolve } from 'path';
import * as dotenv from 'dotenv';

dotenv.config();

async function main() {
  console.log('=== Conway SIWE Provisioning ===');
  console.log(`API URL: ${CONWAY_API_URL}`);
  console.log('');

  const existingKey = process.env['CONWAY_API_KEY'];
  if (existingKey && existingKey.trim()) {
    console.log('Verificando API key existente...');
    const valid = await verifyConwayApiKey(existingKey);
    if (valid) {
      console.log('✅ API key existente es válida.');
      console.log(`Key: ${existingKey.slice(0, 12)}...`);
      process.exit(0);
    }
    console.log('❌ API key existente inválida. Re-provisionando...');
  }

  const keystorePath = resolve(
    process.env['KEYSTORE_PATH'] ?? './keys/keystore.json'
  );

  if (!existsSync(keystorePath)) {
    console.error(`❌ Keystore no encontrado: ${keystorePath}`);
    process.exit(1);
  }

  const password = process.env['WALLET_PASSWORD'];
  if (!password) {
    console.error('❌ WALLET_PASSWORD no configurado en .env');
    process.exit(1);
  }

  console.log('Leyendo wallet...');
  let privateKeyHex: string;
  let address: string;

  try {
    const configStore = new ConfigStore();
    const envelopeJson = configStore.readKeystore(keystorePath, password);
    const envelope = JSON.parse(envelopeJson) as { privateKeyHex: string; address: string };
    privateKeyHex = envelope.privateKeyHex;
    address = envelope.address;
    console.log(`Wallet: ${address}`);
  } catch (err: any) {
    console.error('❌ Error leyendo keystore:', err?.message ?? err);
    process.exit(1);
  }

  // Importar ethers dinámicamente (está en node_modules del proyecto)
  console.log('Cargando ethers...');
  const { ethers } = await import('ethers');
  const wallet = new ethers.Wallet(`0x${privateKeyHex}`);

  // Adapter para provisionConwayApiKey
  const account = {
    address: wallet.address,
    signMessage: async (args: { message: string }) => {
      return wallet.signMessage(args.message);
    },
  };

  console.log('');
  console.log('Conectando con Conway API via SIWE...');

  try {
    const result = await provisionConwayApiKey(account);
    console.log('');
    console.log('✅ Conway API key obtenida!');
    console.log(`Wallet: ${result.walletAddress}`);
    console.log(`Key prefix: ${result.keyPrefix}`);
    console.log('');
    console.log('Agrega esto a tu .env:');
    console.log('');
    console.log(`CONWAY_API_KEY="${result.apiKey}"`);
    console.log('');
  } catch (err: any) {
    console.error('❌ Error:', err?.message ?? err);
    if (err?.response?.data) {
      console.error('API response:', JSON.stringify(err.response.data, null, 2));
    }
    process.exit(1);
  }
}

main().catch(console.error);
