// 텔레그램 봇 알림 서비스 (BTC RSI 다이버전스 알림)
import axios from 'axios';
import { config } from '../config/env';

class TelegramNotifyService {
  private get apiBase() {
    return `https://api.telegram.org/bot${config.telegram.botToken}`;
  }

  async sendMessage(text: string): Promise<void> {
    if (!config.telegram.botToken || !config.telegram.chatId) {
      console.warn('[Telegram] 봇 토큰 또는 chat_id 미설정 — 스킵');
      return;
    }
    await axios.post(
      `${this.apiBase}/sendMessage`,
      {
        chat_id: config.telegram.chatId,
        text,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      },
      { timeout: 10000 },
    );
    console.log('[Telegram] 메시지 발송 완료');
  }
}

export const telegramNotifyService = new TelegramNotifyService();
