/**
 * Maintenance Command Handler
 *
 * Standalone command handler for the /maintenance on|off Telegram command.
 * Can be wired into the Telegram bot handler to toggle SmartAutoLender
 * maintenance mode with operator authentication.
 *
 * Requirements: 3.1, 3.2, 3.5
 */

import type { ISmartAutoLender } from './smart-auto-lender.js';
import type { IOperatorAuthenticator, OperatorAuth } from '../../trading-validation/operator-authenticator.js';

export interface MaintenanceCommandResult {
  success: boolean;
  message: string;
  action?: 'deposit' | 'withdraw' | 'none';
  amount?: bigint;
}

/**
 * Handle a /maintenance on|off command from the Telegram bot.
 *
 * @param subCommand - 'on' or 'off'
 * @param walletBalance - Current wallet USDC balance (6 decimals BigInt)
 * @param smartAutoLender - The SmartAutoLender instance
 * @param auth - The operator authentication result from verifyTelegram
 * @param authenticator - The OperatorAuthenticator instance for command authorization
 * @returns Result indicating success/failure and any action taken
 */
export async function handleMaintenanceCommand(
  subCommand: string,
  walletBalance: bigint,
  smartAutoLender: ISmartAutoLender,
  auth: OperatorAuth,
  authenticator: IOperatorAuthenticator,
): Promise<MaintenanceCommandResult> {
  // Verify privileged command
  if (!auth.verified || !authenticator.authorizeCommand('maintenance', auth)) {
    return { success: false, message: 'Unauthorized: valid operator credentials required.' };
  }

  if (subCommand === 'on') {
    const result = await smartAutoLender.setMaintenance(true, walletBalance);
    return {
      success: true,
      message: `Maintenance ON. ${result.action === 'deposit' ? `Deposited ${result.amount} USDC to Aave. TX: ${result.txHash}` : 'No deposit (insufficient balance).'}`,
      action: result.action === 'deposit' ? 'deposit' : 'none',
      amount: result.amount,
    };
  } else if (subCommand === 'off') {
    const result = await smartAutoLender.setMaintenance(false);
    return {
      success: true,
      message: `Maintenance OFF. ${result.action === 'withdraw' ? `Withdrew ${result.amount} USDC from Aave. TX: ${result.txHash}` : 'No position to withdraw.'}`,
      action: result.action === 'withdraw' ? 'withdraw' : 'none',
      amount: result.amount,
    };
  }

  return { success: false, message: 'Usage: /maintenance on|off' };
}
