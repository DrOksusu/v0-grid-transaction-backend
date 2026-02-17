export type AgentStatus = 'idle' | 'running' | 'stopped' | 'error';

export interface AgentConfig {
  id: string;
  name: string;
  description?: string;
  /** 자동 사이클 실행 간격 (ms). 0이면 내부 루프 사용 */
  cycleIntervalMs?: number;
}

export interface AgentMetrics {
  startedAt: Date | null;
  stoppedAt: Date | null;
  cycles: number;
  errors: number;
  lastError: string | null;
  lastCycleAt: Date | null;
}

export interface AgentInfo {
  id: string;
  name: string;
  status: AgentStatus;
  metrics: AgentMetrics;
  extra?: Record<string, any>;
}
