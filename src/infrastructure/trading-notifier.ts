export class TradingNotifier {
  private webhookUrl: string;

  constructor() {
    // Si no hay webhook, fallará silenciosamente sin quebrar el programa.
    this.webhookUrl = process.env.DISCORD_WEBHOOK_URL || '';
  }

  /**
   * Enviar un mensaje general de alerta
   */
  public async alert(title: string, message: string, type: 'info' | 'success' | 'warning' | 'error' = 'info'): Promise<void> {
    if (!this.webhookUrl) return;

    let color = 3447003; // blue (info)
    if (type === 'success') color = 3066993; // green
    if (type === 'warning') color = 16776960; // yellow
    if (type === 'error') color = 15158332; // red

    try {
      await fetch(this.webhookUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          embeds: [
            {
              title,
              description: message,
              color,
              timestamp: new Date().toISOString(),
            },
          ],
        }),
      });
    } catch (err) {
      console.warn('[TradingNotifier] Error al enviar alerta a Discord:', (err as Error).message);
    }
  }

  /**
   * Enviar alerta específica de trading (compra/venta)
   */
  public async notifyTrade(action: 'BUY' | 'SELL', token: string, amount: string, price: string, pnl?: string): Promise<void> {
    const title = action === 'BUY' ? `🟢 NUEVA COMPRA: ${token}` : `🔴 NUEVA VENTA: ${token}`;
    let msg = `Monto: ${amount}\nPrecio: ${price}`;
    if (pnl) {
      msg += `\nPnL Estimado: ${pnl}`;
    }
    await this.alert(title, msg, action === 'BUY' ? 'info' : 'success');
  }

  /**
   * Enviar alerta específica de Rug Pull evitado
   */
  public async notifyRugShield(token: string, reason: string): Promise<void> {
    const title = `🛡️ RUG SHIELD ACTIVADO: ${token}`;
    const msg = `Se detectó actividad sospechosa.\nRazón: ${reason}\nCapital protegido exitosamente.`;
    await this.alert(title, msg, 'warning');
  }
}
