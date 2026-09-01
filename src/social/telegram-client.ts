export class TelegramClient {
    constructor() {}
    public async sendMessage(message: string): Promise<{ mockMode: boolean; messageId?: string }> {
        console.log(`[TELEGRAM MOCK]: ${message}`);
        return { mockMode: true, messageId: 'mock-123' };
    }
    public async sendError(context: string, error: Error | any): Promise<void> {
        console.error(`[TELEGRAM MOCK ERROR - ${context}]:`, error);
    }
}
