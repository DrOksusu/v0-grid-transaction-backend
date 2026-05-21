/**
 * Metrics Service
 *
 * 내장 모니터링 시스템 - API 성능, 시스템 리소스, 비즈니스 메트릭 수집
 */

import os from 'os';
import fs from 'fs';
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
import { kakaoNotifyService } from './kakao-notify.service';

// 과부하 알림 임계치
const ALERT_THRESHOLDS = {
  cpuDanger: 90,       // CPU % 이상
  memoryDanger: 95,    // 서버 메모리 % 이상
  containerDanger: 90, // 컨테이너 메모리 % 이상
  eventLoopDanger: 100, // 이벤트 루프 지연 ms 이상
  errorRateDanger: 5,  // API 에러율 % 이상
};
const ALERT_COOLDOWN_MS = 60 * 60 * 1000; // 1시간 — 같은 항목 중복 알림 방지

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

  // 과부하 알림 쿨다운 (alertType → 마지막 발송 시각)
  private lastAlertAt: Map<string, number> = new Map();

  // 일일 리포트 마지막 발송 날짜 (YYYY-MM-DD KST)
  private lastDailyReportDate: string = '';

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

    // 과부하 알림 체크
    this.checkOverload();

    // 일일 리포트 체크 (오전 9시 KST)
    this.checkDailyReport();
  }

  /** 매일 오전 9시 KST 서버 상태 리포트 발송 */
  private checkDailyReport(): void {
    // KST = UTC+9
    const nowKst = new Date(Date.now() + 9 * 60 * 60 * 1000);
    const hourKst = nowKst.getUTCHours();
    const dateKst = nowKst.toISOString().slice(0, 10); // YYYY-MM-DD

    // 오전 9시 (09:00~09:59) + 오늘 아직 발송 안 됨
    if (hourKst !== 9) return;
    if (this.lastDailyReportDate === dateKst) return;
    this.lastDailyReportDate = dateKst;

    const sys = this.getSystemMetrics();
    const biz = this.getBusinessMetrics();

    const uptimeSec = Math.floor((Date.now() - this.serverStartTime) / 1000);
    const days = Math.floor(uptimeSec / 86400);
    const hours = Math.floor((uptimeSec % 86400) / 3600);
    const mins = Math.floor((uptimeSec % 3600) / 60);
    const uptimeStr = days > 0 ? `${days}일 ${hours}시간` : hours > 0 ? `${hours}시간 ${mins}분` : `${mins}분`;

    const memPercent = ((sys.memory.used / sys.memory.total) * 100).toFixed(1);
    const heapMb = (sys.memory.heapUsed / 1024 / 1024).toFixed(0);

    const statusLine = (
      sys.cpu.usage < 70 &&
      parseFloat(memPercent) < 85 &&
      sys.eventLoop.lag < 50
    ) ? '✅ 정상' : '⚠️ 주의 필요';

    const msg =
      `[서버 일일 리포트 - ${dateKst}]\n` +
      `상태: ${statusLine}\n` +
      `업타임: ${uptimeStr}\n` +
      `CPU: ${sys.cpu.usage.toFixed(1)}%\n` +
      `메모리: ${memPercent}%\n` +
      `Heap: ${heapMb}MB\n` +
      `이벤트 루프: ${sys.eventLoop.lag.toFixed(1)}ms\n` +
      `WS 연결: ${biz.websocket.totalConnections}명\n` +
      `DB 쿼리(평균): ${biz.database.avgQueryTime}ms\n` +
      `https://v0-grid-transaction.vercel.app/admin`;

    kakaoNotifyService.sendToMe(msg).catch((e: any) =>
      console.error('[Metrics] 일일 리포트 카카오 알림 실패:', e.message)
    );
    console.log(`[Metrics] 일일 리포트 발송: ${dateKst}`);
  }

  /** 임계치 초과 시 카카오 알림 (1시간 쿨다운) */
  private checkOverload(): void {
    const sys = this.getSystemMetrics();
    const memPercent = (sys.memory.used / sys.memory.total) * 100;
    const containerPercent = sys.memory.container?.available
      ? (sys.memory.container.used / sys.memory.container.limit) * 100
      : 0;

    const recentMetrics = this.rawMetrics.filter((m) => m.timestamp > Date.now() - 60000);
    const errorRate = recentMetrics.length > 0
      ? (recentMetrics.filter((m) => m.statusCode >= 400).length / recentMetrics.length) * 100
      : 0;

    const checks: Array<{ key: string; triggered: boolean; label: string; value: string }> = [
      {
        key: 'cpu',
        triggered: sys.cpu.usage >= ALERT_THRESHOLDS.cpuDanger,
        label: 'CPU 과부하',
        value: `${sys.cpu.usage.toFixed(1)}% (임계치: ${ALERT_THRESHOLDS.cpuDanger}%)`,
      },
      {
        key: 'memory',
        triggered: memPercent >= ALERT_THRESHOLDS.memoryDanger,
        label: '서버 메모리 부족',
        value: `${memPercent.toFixed(1)}% (임계치: ${ALERT_THRESHOLDS.memoryDanger}%)`,
      },
      {
        key: 'container',
        triggered: containerPercent >= ALERT_THRESHOLDS.containerDanger,
        label: '컨테이너 메모리 부족',
        value: `${containerPercent.toFixed(1)}% (임계치: ${ALERT_THRESHOLDS.containerDanger}%)`,
      },
      {
        key: 'eventloop',
        triggered: sys.eventLoop.lag >= ALERT_THRESHOLDS.eventLoopDanger,
        label: '이벤트 루프 지연',
        value: `${sys.eventLoop.lag.toFixed(1)}ms (임계치: ${ALERT_THRESHOLDS.eventLoopDanger}ms)`,
      },
      {
        key: 'errorrate',
        triggered: errorRate >= ALERT_THRESHOLDS.errorRateDanger,
        label: 'API 에러율 급증',
        value: `${errorRate.toFixed(1)}% (임계치: ${ALERT_THRESHOLDS.errorRateDanger}%)`,
      },
    ];

    for (const check of checks) {
      if (!check.triggered) continue;
      const lastSent = this.lastAlertAt.get(check.key) ?? 0;
      if (Date.now() - lastSent < ALERT_COOLDOWN_MS) continue;

      this.lastAlertAt.set(check.key, Date.now());
      const msg =
        `[서버 과부하 경고]\n` +
        `항목: ${check.label}\n` +
        `현재값: ${check.value}\n` +
        `https://v0-grid-transaction.vercel.app/admin`;
      kakaoNotifyService.sendToMe(msg).catch((e: any) =>
        console.error(`[Metrics] 과부하 카카오 알림 실패(${check.key}):`, e.message)
      );
      console.warn(`[Metrics] 과부하 알림 발송: ${check.label} — ${check.value}`);
    }
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
   * Docker 컨테이너 메모리 조회 (cgroup v1/v2)
   */
  private getContainerMemory(): { used: number; limit: number; available: boolean } {
    try {
      // cgroup v2 경로 (최신 Docker/Linux)
      const cgroupV2Usage = '/sys/fs/cgroup/memory.current';
      const cgroupV2Limit = '/sys/fs/cgroup/memory.max';

      // cgroup v1 경로 (구버전)
      const cgroupV1Usage = '/sys/fs/cgroup/memory/memory.usage_in_bytes';
      const cgroupV1Limit = '/sys/fs/cgroup/memory/memory.limit_in_bytes';

      let used = 0;
      let limit = 0;

      // cgroup v2 먼저 시도
      if (fs.existsSync(cgroupV2Usage)) {
        used = parseInt(fs.readFileSync(cgroupV2Usage, 'utf8').trim(), 10);
        const limitStr = fs.readFileSync(cgroupV2Limit, 'utf8').trim();
        // 'max'는 제한 없음을 의미
        limit = limitStr === 'max' ? os.totalmem() : parseInt(limitStr, 10);
      }
      // cgroup v1 시도
      else if (fs.existsSync(cgroupV1Usage)) {
        used = parseInt(fs.readFileSync(cgroupV1Usage, 'utf8').trim(), 10);
        limit = parseInt(fs.readFileSync(cgroupV1Limit, 'utf8').trim(), 10);
        // 매우 큰 값은 제한 없음을 의미 (보통 호스트 메모리보다 큼)
        if (limit > os.totalmem() * 2) {
          limit = os.totalmem();
        }
      } else {
        // cgroup 파일이 없음 (컨테이너가 아님)
        return { used: 0, limit: 0, available: false };
      }

      return { used, limit, available: true };
    } catch {
      // 읽기 실패
      return { used: 0, limit: 0, available: false };
    }
  }

  /**
   * 시스템 메트릭 조회
   */
  getSystemMetrics(): SystemMetrics {
    const memUsage = process.memoryUsage();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const containerMem = this.getContainerMemory();

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
        container: containerMem,
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
