/**
 * Signer — message signing utilities for the Autonomous Income Node.
 *
 * Provides stateless helpers that operate on a WalletManager instance to
 * sign arbitrary messages and verify signatures, supporting authentication
 * in external protocols (e.g. x402 payment proofs, ERC-8004 challenges).
 *
 * The private key is accessed exclusively via the WalletManager abstraction
 * and is NEVER passed into or returned from any function in this module.
 *
 * Requirements: 3.7, 14.1
 */

import { verifyMessage } from 'ethers';
import type { WalletManager } from './wallet-manager.js';

// ---------------------------------------------------------------------------
// Signer interface
// ---------------------------------------------------------------------------

export interface Signer {
  /**
   * Sign an arbitrary UTF-8 message using EIP-191 personal_sign.
   *
   * @param message  Plain UTF-8 string to sign.
   * @returns        65-byte signature as a `0x`-prefixed hex string.
   */
  sign(message: string): Promise<string>;

  /**
   * Verify that a signature was produced by the node's own wallet.
   *
   * @param message    The original message that was signed.
   * @param signature  65-byte hex signature to verify.
   * @returns          `true` if the signature was produced by this node's address.
   */
  verifyOwn(message: string, signature: string): boolean;

  /**
   * Recover the Ethereum address that produced `signature` over `message`.
   *
   * @param message    The original signed message.
   * @param signature  65-byte hex signature.
   * @returns          Checksummed Ethereum address of the signer.
   */
  recoverAddress(message: string, signature: string): string;
}

// ---------------------------------------------------------------------------
// SignerImpl
// ---------------------------------------------------------------------------

export class SignerImpl implements Signer {
  constructor(private readonly walletManager: WalletManager) {}

  async sign(message: string): Promise<string> {
    return this.walletManager.signMessage(message);
  }

  verifyOwn(message: string, signature: string): boolean {
    const recovered = this.recoverAddress(message, signature);
    return recovered.toLowerCase() === this.walletManager.getAddress().toLowerCase();
  }

  recoverAddress(message: string, signature: string): string {
    // ethers v6: verifyMessage returns the checksummed address of the signer.
    return verifyMessage(message, signature);
  }
}
