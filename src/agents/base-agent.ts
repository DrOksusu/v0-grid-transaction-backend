import { AgentStatus, AgentConfig, AgentMetrics, AgentInfo } from './types';

export abstract class BaseAgent {
  readonly id: string;
  readonly name: string;
  readonly description: string;

  protected status: AgentStatus = 'idle';
  protected metrics: AgentMetrics = {
    startedAt: null,
    stoppedAt: null,
    cycles: 0,
    errors: 0,
    lastError: null,
    lastCycleAt: null,
  };

  private cycleIntervalMs: number;
  private cycleTimer: NodeJS.Timeout | null = null;

  constructor(config: AgentConfig) {
    this.id = config.id;
    this.name = config.name;
    this.description = config.description || '';
    this.cycleIntervalMs = config.cycleIntervalMs || 0;
  }

  /** 서브클래스에서 시작 로직 구현 */
  protected abstract onStart(): Promise<void>;
  /** 서브클래스에서 종료 로직 구현 */
  protected abstract onStop(): Promise<void>;
  /** 주기적 실행 로직 (cycleIntervalMs > 0일 때만 자동 호출) */
  protected abstract onCycle(): Promise<void>;

  async start(): Promise<void> {
    if (this.status === 'running') {
      console.log(`[${this.name}] Already running`);
      return;
    }

    try {
      this.status = 'running';
      this.metrics.startedAt = new Date();
      this.metrics.stoppedAt = null;

      await this.onStart();

      // cycleIntervalMs > 0이면 자동 사이클 루프 시작
      if (this.cycleIntervalMs > 0) {
        this.startCycleLoop();
      }

      console.log(`[${this.name}] Started`);
    } catch (error: any) {
      this.status = 'error';
      this.metrics.errors++;
      this.metrics.lastError = error.message;
      console.error(`[${this.name}] Failed to start:`, error.message);
      throw error;
    }
  }

  async stop(): Promise<void> {
    if (this.status !== 'running' && this.status !== 'error') {
      console.log(`[${this.name}] Not running (status: ${this.status})`);
      return;
    }

    try {
      this.stopCycleLoop();
      await this.onStop();

      this.status = 'stopped';
      this.metrics.stoppedAt = new Date();
      console.log(`[${this.name}] Stopped`);
    } catch (error: any) {
      this.status = 'error';
      this.metrics.errors++;
      this.metrics.lastError = error.message;
      console.error(`[${this.name}] Failed to stop:`, error.message);
      throw error;
    }
  }

  getStatus(): AgentInfo {
    return {
      id: this.id,
      name: this.name,
      status: this.status,
      metrics: { ...this.metrics },
      extra: this.getExtraInfo(),
    };
  }

  /** 서브클래스에서 추가 메트릭스를 노출할 때 오버라이드 */
  protected getExtraInfo(): Record<string, any> | undefined {
    return undefined;
  }

  private startCycleLoop(): void {
    // setInterval 대신 순차 setTimeout 루프 — 이전 사이클이 끝난 후 다음 스케줄
    // setInterval은 사이클이 intervalMs보다 오래 걸릴 때 중복 실행 누적 문제 발생
    const loop = async () => {
      if (this.status !== 'running') return;
      try {
        await this.onCycle();
        this.metrics.cycles++;
        this.metrics.lastCycleAt = new Date();
      } catch (error: any) {
        this.metrics.errors++;
        this.metrics.lastError = error.message;
        console.error(`[${this.name}] Cycle error:`, error.message);
      }
      if (this.status === 'running') {
        this.cycleTimer = setTimeout(loop, this.cycleIntervalMs);
      }
    };
    this.cycleTimer = setTimeout(loop, this.cycleIntervalMs);
  }

  private stopCycleLoop(): void {
    if (this.cycleTimer) {
      clearTimeout(this.cycleTimer);
      this.cycleTimer = null;
    }
  }
}
