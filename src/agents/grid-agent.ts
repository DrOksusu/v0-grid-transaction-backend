import { BaseAgent } from './base-agent';
import { botEngine } from '../services/bot-engine.service';
import prisma from '../config/database';

export class GridAgent extends BaseAgent {
  constructor() {
    super({
      id: 'grid',
      name: 'GridAgent',
      description: 'Upbit 그리드 매매 봇 엔진 (BotEngine 래핑)',
      // BotEngine 내부에 자체 interval 루프가 있으므로 외부 사이클 불필요
      cycleIntervalMs: 0,
    });
  }

  protected async onStart(): Promise<void> {
    await botEngine.start();
  }

  protected async onStop(): Promise<void> {
    botEngine.stop();
  }

  protected async onCycle(): Promise<void> {
    // BotEngine 내부 루프 사용 - 별도 사이클 불필요
  }

  protected getExtraInfo(): Record<string, any> {
    const engineStatus = botEngine.getStatus();
    return {
      engineStatus,
      priceManager: botEngine.getPriceManagerStatus(),
    };
  }
}
