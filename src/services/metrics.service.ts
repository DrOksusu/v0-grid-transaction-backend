/**
 * Metrics Service
 *
 * 내장 모니터링 시스템 - API 성능, 시스템 리소스, 비즈니스 메트릭 수집
 */

import os from 'os';
import {
  RequestMetric,
  AggregatedMetrics,
  SystemMetrics,
  BusinessMetrics,
  MetricsResponse,
  PoolStats,
} from '../types/metrics.types';
import { socketService } from './socket.service';
import { botEngine } from './bot-engine.service';
import { whaleAlertService } from './whale-alert.service';

class MetricsService {
  // 설정
  private readonly MAX_RAW_METRICS = 10000;
  private readonly AGGREGATION_INTERVAL = 60000; // 1분마다 집계
  private readonly RETENTION_MINUTES = 60; // 1시간 보관
  private readonly SYSTEM_COLLECT_INTERVAL = 10000; // 10초마다 시스템 메트릭

  // 저장소
  private rawMetrics: RequestMetric[] = [];
  private aggregatedHistory: AggregatedMetrics[] = [];
  private lastEventLoopLag: number = 0;
  private serverStartTime: number = Date.now();

  // 외부 참조
  private poolStatsRef: PoolStats | null = null;

  // 타이머
  private aggregationTimer: NodeJS.Timeout | null = null;
  private eventLoopTimer: NodeJS.Timeout | null = null;

  // CPU 측정용
  private lastCpuInfo: { idle: number; total: number } | null = null;

  constructor() {
    this.setupEventLoopMonitor();
  }

  /**
   * 서비스 시작
   */
  start(poolStats?: PoolStats): void {
    if (poolStats) {
      this.poolStatsRef = poolStats;
    }

    // 집계 타이머 시작
    this.aggregationTimer = setInterval(() => {
      this.aggregate();
    }, this.AGGREGATION_INTERVAL);

    console.log('[Metrics] 모니터링 서비스 시작');
  }

  /**
   * 서비스 중지
   */
  stop(): void {
    if (this.aggregationTimer) {
      clearInterval(this.aggregationTimer);
      this.aggregationTimer = null;
    }
    if (this.eventLoopTimer) {
      clearInterval(this.eventLoopTimer);
      this.eventLoopTimer = null;
    }
    console.log('[Metrics] 모니터링 서비스 중지');
  }

  /**
   * 이벤트 루프 지연 모니터링 설정
   */
  private setupEventLoopMonitor(): void {
    let lastCheck = process.hrtime.bigint();

    this.eventLoopTimer = setInterval(() => {
      const now = process.hrtime.bigint();
      const expected = 1000; // 1초 예상
      const actual = Number(now - lastCheck) / 1_000_000; // ns to ms
      this.lastEventLoopLag = Math.max(0, actual - expected);
      lastCheck = now;
    }, 1000);
  }

  /**
   * HTTP 요청 메트릭 기록
   */
  recordRequest(metric: RequestMetric): void {
    this.rawMetrics.push(metric);

    // 오래된 데이터 제거 (1시간 이상)
    const cutoff = Date.now() - this.RETENTION_MINUTES * 60 * 1000;
    this.rawMetrics = this.rawMetrics.filter((m) => m.timestamp > cutoff);

    // 최대 개수 제한
    if (this.rawMetrics.length > this.MAX_RAW_METRICS) {
      this.rawMetrics = this.rawMetrics.slice(-this.MAX_RAW_METRICS);
    }
  }

  /**
   * 분별 집계 수행
   */
  private aggregate(): void {
    const now = Date.now();
    const minuteAgo = now - this.AGGREGATION_INTERVAL;

    // 최근 1분 데이터 필터
    const recentMetrics = this.rawMetrics.filter((m) => m.timestamp > minuteAgo);

    if (recentMetrics.length === 0) {
      // 데이터 없으면 빈 집계 추가
      const emptyAgg: AggregatedMetrics = {
        timestamp: Math.floor(now / 60000) * 60000,
        requests: { total: 0, byStatus: {}, byEndpoint: {} },
        responseTime: { avg: 0, p95: 0, p99: 0, min: 0, max: 0 },
        errors: { count: 0, rate: 0 },
      };
      this.aggregatedHistory.push(emptyAgg);
    } else {
      const aggregated = this.calculateAggregation(recentMetrics, now);
      this.aggregatedHistory.push(aggregated);
    }

    // 1시간 초과 데이터 제거
    const historyCutoff = now - this.RETENTION_MINUTES * 60 * 1000;
    this.aggregatedHistory = this.aggregatedHistory.filter(
      (a) => a.timestamp > historyCutoff
    );
  }

  /**
   * 집계 계산
   */
  private calculateAggregation(
    metrics: RequestMetric[],
    timestamp: number
  ): AggregatedMetrics {
    const responseTimes = metrics.map((m) => m.responseTime).sort((a, b) => a - b);
    const total = metrics.length;

    // 상태 코드별 집계
    const byStatus: Record<number, number> = {};
    metrics.forEach((m) => {
      byStatus[m.statusCode] = (byStatus[m.statusCode] || 0) + 1;
    });

    // 엔드포인트별 집계 (path 정규화)
    const byEndpoint: Record<string, number> = {};
    metrics.forEach((m) => {
      const normalizedPath = this.normalizePath(m.path);
      byEndpoint[normalizedPath] = (byEndpoint[normalizedPath] || 0) + 1;
    });

    // 에러 집계 (4xx, 5xx)
    const errorCount = metrics.filter((m) => m.statusCode >= 400).length;

    // 백분위수 계산
    const p95Index = Math.floor(total * 0.95);
    const p99Index = Math.floor(total * 0.99);

    return {
      timestamp: Math.floor(timestamp / 60000) * 60000,
      requests: {
        total,
        byStatus,
        byEndpoint,
      },
      responseTime: {
        avg: Math.round((responseTimes.reduce((a, b) => a + b, 0) / total) * 100) / 100,
        p95: responseTimes[p95Index] || 0,
        p99: responseTimes[p99Index] || 0,
        min: responseTimes[0] || 0,
        max: responseTimes[total - 1] || 0,
      },
      errors: {
        count: errorCount,
        rate: Math.round((errorCount / total) * 10000) / 100,
      },
    };
  }

  /**
   * 경로 정규화 (동적 파라미터 제거)
   */
  private normalizePath(path: string): string {
    return path
      .replace(/\/\d+/g, '/:id') // /api/bots/123 -> /api/bots/:id
      .replace(/\/[a-f0-9-]{36}/gi, '/:uuid') // UUID 패턴
      .split('?')[0]; // 쿼리스트링 제거
  }

  /**
   * CPU 사용률 계산
   */
  private getCpuUsage(): number {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;

    cpus.forEach((cpu) => {
      for (const type in cpu.times) {
        total += (cpu.times as any)[type];
      }
      idle += cpu.times.idle;
    });

    if (this.lastCpuInfo) {
      const idleDiff = idle - this.lastCpuInfo.idle;
      const totalDiff = total - this.lastCpuInfo.total;
      const usage = totalDiff > 0 ? ((totalDiff - idleDiff) / totalDiff) * 100 : 0;
      this.lastCpuInfo = { idle, total };
      return Math.round(usage * 100) / 100;
    }

    this.lastCpuInfo = { idle, total };
    return 0;
  }

  /**
   * 시스템 메트릭 조회
   */
  getSystemMetrics(): SystemMetrics {
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();

    return {
      timestamp: Date.now(),
      cpu: {
        usage: this.getCpuUsage(),
        loadAvg: os.loadavg(),
      },
      memory: {
        used: totalMem - freeMem,
        total: totalMem,
        heapUsed: memUsage.heapUsed,
        heapTotal: memUsage.heapTotal,
        external: memUsage.external,
        rss: memUsage.rss,
      },
      eventLoop: {
        lag: Math.round(this.lastEventLoopLag * 100) / 100,
      },
    };
  }

  /**
   * 비즈니스 메트릭 조회
   */
  getBusinessMetrics(): BusinessMetrics {
    const botStatus = botEngine.getStatus();
    const whaleStatus = whaleAlertService.getStatus();

    // Socket.IO 연결 정보
    const io = socketService.getIO();
    const totalConnections = io?.sockets?.sockets?.size || 0;

    return {
      timestamp: Date.now(),
      database: {
        totalQueries: this.poolStatsRef?.totalQueries || 0,
        slowQueries: this.poolStatsRef?.slowQueries || 0,
        verySlowQueries: this.poolStatsRef?.verySlowQueries || 0,
        avgQueryTime: this.poolStatsRef?.avgQueryTime || 0,
        recentQueryTimes: this.poolStatsRef?.queryTimes || [],
      },
      websocket: {
        totalConnections,
        priceSubscribers: socketService.getPriceSubscribersCount(),
        botsSubscribers: socketService.getSubscribedUserIds().length,
        whaleSubscribers: socketService.getWhaleSubscribersCount(),
      },
      botEngine: {
        isRunning: botStatus.isRunning,
        activeBots: 0, // 별도 조회 필요 시 추가
        baseInterval: botStatus.baseInterval,
      },
      whaleService: {
        isRunning: whaleStatus.isRunning,
        lastFetchTime: whaleStatus.lastFetchTime,
        lastFetchSuccess: whaleStatus.lastFetchSuccess,
        totalTransactions: whaleStatus.totalTransactions,
      },
    };
  }

  /**
   * 전체 메트릭 조회 (API용)
   */
  getMetrics(): MetricsResponse {
    const now = Date.now();

    // 현재 분 집계 (실시간)
    const minuteAgo = now - 60000;
    const currentMetrics = this.rawMetrics.filter((m) => m.timestamp > minuteAgo);
    const currentAgg =
      currentMetrics.length > 0
        ? this.calculateAggregation(currentMetrics, now)
        : {
            timestamp: Math.floor(now / 60000) * 60000,
            requests: { total: 0, byStatus: {}, byEndpoint: {} },
            responseTime: { avg: 0, p95: 0, p99: 0, min: 0, max: 0 },
            errors: { count: 0, rate: 0 },
          };

    return {
      server: {
        uptime: Math.floor((now - this.serverStartTime) / 1000),
        startTime: this.serverStartTime,
        nodeVersion: process.version,
        environment: process.env.NODE_ENV || 'development',
      },
      api: {
        current: currentAgg,
        history: this.aggregatedHistory,
      },
      system: this.getSystemMetrics(),
      business: this.getBusinessMetrics(),
    };
  }

  /**
   * 상태 조회 (간단한 버전)
   */
  getStatus(): { isRunning: boolean; rawCount: number; historyCount: number } {
    return {
      isRunning: this.aggregationTimer !== null,
      rawCount: this.rawMetrics.length,
      historyCount: this.aggregatedHistory.length,
    };
  }
}

export const metricsService = new MetricsService();
