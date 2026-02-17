import { BaseAgent } from './base-agent';
import { infiniteBuyScheduler } from '../services/infinite-buy-scheduler.service';

export class InfiniteBuyAgent extends BaseAgent {
  constructor() {
    super({
      id: 'infinite-buy',
      name: 'InfiniteBuyAgent',
      description: '미국 주식 무한매수법 스케줄러 (InfiniteBuySchedulerService 래핑)',
      // 스케줄러 내부 cron 사용 - 외부 사이클 불필요
      cycleIntervalMs: 0,
    });
  }

  protected async onStart(): Promise<void> {
    infiniteBuyScheduler.start();
  }

  protected async onStop(): Promise<void> {
    infiniteBuyScheduler.stop();
  }

  protected async onCycle(): Promise<void> {
    // 스케줄러 내부 cron 사용 - 별도 사이클 불필요
  }

  protected getExtraInfo(): Record<string, any> {
    return {
      schedulerStatus: infiniteBuyScheduler.getStatus(),
    };
  }
}
