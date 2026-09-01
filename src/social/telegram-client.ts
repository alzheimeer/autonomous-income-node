/**
 * TelegramClient
 *
 * Publica mensajes al grupo/canal de Telegram via Bot API.
 * Soporta formato HTML (bold, italic, code) y Markdown.
 *
 * Requirements: 8.1, 8.5
 */

import axios from 'axios';

export interface TelegramResult {
  messageId: number;
  mockMode: boolean;
}

export class TelegramClient {
  private readonly botToken: string;
  private readonly chatId: string;
  private readonly isMock: boolean;

  constructor() {
    this.botToken = process.env['TELEGRAM_BOT_TOKEN'] ?? '';
    this.chatId = process.env['TELEGRAM_CHAT_ID'] ?? '';
    this.isMock = !this.botToken || !this.chatId;
  }

  /**
   * Envía un mensaje al grupo/canal de Telegram.
   * Soporta HTML: <b>bold</b>, <i>italic</i>, <code>code</code>
   */
  async sendMessage(content: string): Promise<TelegramResult> {
    if (this.isMock) {
      console.log(`[TelegramClient] MOCK MODE — would send: "${content.slice(0, 100)}..."`);
      return { messageId: Date.now(), mockMode: true };
    }

    const url = `https://api.telegram.org/bot${this.botToken}/sendMessage`;

    const response = await axios.post<{ ok: boolean; result: { message_id: number } }>(
      url,
      {
        chat_id: this.chatId,
        text: content,
        parse_mode: 'HTML',
        disable_web_page_preview: true,
      },
      { timeout: 15_000 }
    );

    if (!response.data.ok) {
      throw new Error('Telegram API returned ok:false');
    }

    return {
      messageId: response.data.result.message_id,
      mockMode: false,
    };
  }

  /** Verdadero si el cliente está configurado con token y chat ID */
  isConfigured(): boolean {
    return !this.isMock;
  }
}
