import { BaseAgent } from './base-agent';
import { koreanStockBotEngine } from '../services/korean-stock-bot-engine.service';

export class KoreanStockGridAgent extends BaseAgent {
  constructor() {
    super({
      id: 'korean-stock-grid',
      name: 'KoreanStockGridAgent',
      description: '한국주식 그리드 매매 봇 (5초 cycle, 장 시간만)',
      cycleIntervalMs: 5_000,
    });
  }

  protected async onStart(): Promise<void> {
    console.log('[KoreanStockGridAgent] 시작 — 5초 cycle');
  }

  protected async onCycle(): Promise<void> {
    await koreanStockBotEngine.runCycle();
  }

  protected async onStop(): Promise<void> {
    console.log('[KoreanStockGridAgent] 종료');
  }
}

export const koreanStockGridAgent = new KoreanStockGridAgent();
