/**
 * 모니터링 메트릭 타입 정의
 */

// HTTP 요청 메트릭 (원시 데이터)
export interface RequestMetric {
  timestamp: number;
  method: string;
  path: string;
  statusCode: number;
  responseTime: number; // ms
  userId?: number;
}

// 시간별 집계 데이터
export interface AggregatedMetrics {
  timestamp: number; // 분 단위 bucket
  requests: {
    total: number;
    byStatus: Record<number, number>; // 200: 50, 400: 5, 500: 2
    byEndpoint: Record<string, number>; // '/api/bots': 30
  };
  responseTime: {
    avg: number;
    p95: number;
    p99: number;
    min: number;
    max: number;
  };
  errors: {
    count: number;
    rate: number; // percentage
  };
}

// 시스템 리소스 메트릭
export interface SystemMetrics {
  timestamp: number;
  cpu: {
    usage: number; // percentage
    loadAvg: number[]; // 1, 5, 15분
  };
  memory: {
    used: number;
    total: number;
    heapUsed: number;
    heapTotal: number;
    external: number;
    rss: number;
    // Docker 컨테이너 메모리 (cgroup)
    container?: {
      used: number;
      limit: number;
      available: boolean; // cgroup 읽기 가능 여부
    };
  };
  eventLoop: {
    lag: number; // ms
  };
}

// 비즈니스 메트릭
export interface BusinessMetrics {
  timestamp: number;
  database: {
    totalQueries: number;
    slowQueries: number;
    verySlowQueries: number;
    avgQueryTime: number;
    recentQueryTimes: number[];
  };
  websocket: {
    totalConnections: number;
    priceSubscribers: number;
    botsSubscribers: number;
    whaleSubscribers: number;
  };
  botEngine: {
    isRunning: boolean;
    activeBots: number;
    baseInterval: number;
  };
  whaleService: {
    isRunning: boolean;
    lastFetchTime: number;
    lastFetchSuccess: boolean;
    totalTransactions: number;
  };
}

// 전체 메트릭 응답
export interface MetricsResponse {
  server: {
    uptime: number;
    startTime: number;
    nodeVersion: string;
    environment: string;
  };
  api: {
    current: AggregatedMetrics;
    history: AggregatedMetrics[]; // 최근 1시간 (분별)
  };
  system: SystemMetrics;
  business: BusinessMetrics;
}

// Pool Stats 인터페이스 (database.ts에서 사용)
export interface PoolStats {
  totalQueries: number;
  slowQueries: number;
  verySlowQueries: number;
  lastQueryTime: number;
  avgQueryTime: number;
  queryTimes: number[];
}
