import axios from 'axios';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { listingAutoTraderService } from './listing-auto-trader.service';

// 상장 공지 인터페이스
export interface UpbitNotice {
  id: number;
  title: string;
  url: string;
  created_at: string;
}

// 거래소별 가격 스냅샷
export interface ExchangePriceResult {
  exchange: string;
  price: number | null;
  volume24h: number | null;
  error?: string;
}

// 상장 공지 DTO
export interface ListingAnnouncementDto {
  id: number;
  noticeId: number;
  title: string;
  ticker: string | null;
  url: string;
  announcedAt: Date;
  listedAt: Date | null;
  status: string;
  snapshots: ListingSnapshotDto[];
}

export interface ListingSnapshotDto {
  id: number;
  exchange: string;
  price: number;
  volume24h: number | null;
  snapshotType: string;
  recordedAt: Date;
}

// 상장 공지 키워드 (제목에 포함되어야 신규 상장으로 판단)
const LISTING_KEYWORDS = ['신규 거래지원'];
// 티커로 오인할 수 있는 제외 단어
const TICKER_EXCLUDES = new Set(['KRW', 'BTC', 'USDT', 'ETH', 'BNB', 'USDC']);

// 공지 직후(announced), +1h, +2h, +4h, +6h 스냅샷 스케줄 (ms 단위)
const SNAPSHOT_SCHEDULE = [
  { type: '+1h', delayMs: 1 * 60 * 60 * 1000 },
  { type: '+2h', delayMs: 2 * 60 * 60 * 1000 },
  { type: '+4h', delayMs: 4 * 60 * 60 * 1000 },
  { type: '+6h', delayMs: 6 * 60 * 60 * 1000 },
];

class UpbitListingMonitorService {
  // 알림이 발생한 noticeId 캐시 (중복 방지, 재시작 후엔 DB로 복원)
  private seenNoticeIds: Set<number> = new Set();
  // 업비트 마켓 목록 캐시
  private upbitMarkets: Set<string> = new Set();
  // 스냅샷 스케줄 타이머 (announcementId → timer ids)
  private snapshotTimers: Map<number, ReturnType<typeof setTimeout>[]> = new Map();

  // 서비스 초기화 (에이전트 시작 시 호출)
  async initialize(): Promise<void> {
    // 기존 공지 ID를 DB에서 로드
    const existing = await (prisma as any).upbitListingAnnouncement.findMany({
      select: { noticeId: true },
    });
    for (const row of existing) {
      this.seenNoticeIds.add(row.noticeId);
    }

    // 업비트 마켓 baseline: DB에서 로드 (서버 재시작 후에도 이전 상태 유지)
    const knownMarkets = await (prisma as any).upbitKnownMarket.findMany({
      select: { market: true },
    });
    if (knownMarkets.length > 0) {
      this.upbitMarkets = new Set(knownMarkets.map((r: any) => r.market));
      console.log(`[ListingMonitor] DB baseline 로드: ${this.upbitMarkets.size}개 마켓`);
    } else {
      // 최초 실행: live API로 초기화 후 DB에 저장
      await this.refreshUpbitMarkets();
      await this.saveMarketsToDb([...this.upbitMarkets]);
      console.log(`[ListingMonitor] 최초 초기화: ${this.upbitMarkets.size}개 마켓 DB 저장`);
    }

    // 진행 중인 공지 (listed 미완료) 스케줄 복원
    await this.restorePendingSchedules();
  }

  // 업비트 공지 폴링 (에이전트 tick에서 호출) — 거래 카테고리 최신 10개
  async pollAnnouncements(): Promise<void> {
    let notices: UpbitNotice[] = [];
    try {
      // Playwright로 확인한 실제 API: api-manager.upbit.com (category=거래 URL encode)
      const res = await axios.get(
        'https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=10&category=%EA%B1%B0%EB%9E%98',
        {
          timeout: 8000,
          headers: {
            accept: 'application/json, text/plain, */*',
            'accept-language': 'ko-KR,ko;q=0.9,en-US;q=0.8,en;q=0.7',
            referer: 'https://www.upbit.com/',
            'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          },
        },
      );
      const raw: any[] = res.data?.data?.notices ?? [];
      notices = raw.map((n: any) => ({
        id: n.id,
        title: n.title,
        url: `https://www.upbit.com/service_center/notice?id=${n.id}`,
        created_at: n.listed_at,
      }));
    } catch (err: any) {
      if (err?.response?.status) {
        console.warn(`[ListingMonitor] 공지 API ${err.response.status} — 마켓 목록 감지로 폴백`);
      }
      return;
    }

    for (const notice of notices) {
      if (this.seenNoticeIds.has(notice.id)) continue;
      if (!this.isListingNotice(notice.title)) continue;

      // 즉시 seenIds에 추가 → 5초 내 중복 폴링 방지
      this.seenNoticeIds.add(notice.id);
      await this.handleNewListing(notice);
    }
  }

  // 에이전트 onStop 시 예약된 타이머 모두 취소
  cancelPendingSnapshots(): void {
    for (const timers of this.snapshotTimers.values()) {
      timers.forEach(t => clearTimeout(t));
    }
    this.snapshotTimers.clear();
  }

  // 에이전트 getExtraInfo용 통계
  getStats(): Record<string, any> {
    const pendingSymbols: string[] = [];
    return {
      seenNoticeCount: this.seenNoticeIds.size,
      pendingAnnouncementCount: this.snapshotTimers.size,
      pendingSymbols,
    };
  }

  // 업비트 마켓 변경 감지 (에이전트 tick에서 호출)
  async checkNewUpbitMarkets(): Promise<void> {
    const prev = new Set(this.upbitMarkets);
    await this.refreshUpbitMarkets();

    // 새로 추가된 마켓
    const newMarkets: string[] = [];
    for (const market of this.upbitMarkets) {
      if (!prev.has(market)) {
        newMarkets.push(market);
        const ticker = market.replace('KRW-', '');
        await this.handleUpbitListed(ticker);
      }
    }

    // 신규 마켓을 DB에 저장 → 재시작 후에도 baseline 유지
    if (newMarkets.length > 0) {
      await this.saveMarketsToDb(newMarkets);
    }
  }

  // 수동 공지 등록 + 즉시 스냅샷 (테스트/긴급 추적용)
  async createManualEntry(noticeId: number, title: string, ticker: string): Promise<ListingAnnouncementDto> {
    const announcement = await (prisma as any).upbitListingAnnouncement.create({
      data: {
        noticeId,
        title,
        ticker,
        url: `https://upbit.com/service_center/notice`,
        status: 'announced',
      },
    });

    this.seenNoticeIds.add(noticeId);

    // 자동매수 + 즉시 스냅샷 병렬 실행
    await Promise.all([
      listingAutoTraderService.executeBuy(announcement.id, ticker).catch(e =>
        console.error('[ListingMonitor] 수동등록 자동매수 오류:', e)
      ),
      this.captureSnapshots(announcement.id, ticker, 'announced'),
    ]);

    // +2h/+4h 스케줄
    this.scheduleFollowUpSnapshots(announcement.id, ticker);

    const result = await (prisma as any).upbitListingAnnouncement.findUnique({
      where: { id: announcement.id },
      include: { snapshots: { orderBy: { recordedAt: 'asc' } } },
    });
    return this.toDto(result);
  }

  // 모든 상장 공지 조회
  async listAnnouncements(limit = 50): Promise<ListingAnnouncementDto[]> {
    const rows = await (prisma as any).upbitListingAnnouncement.findMany({
      orderBy: { announcedAt: 'desc' },
      take: limit,
      include: { snapshots: { orderBy: { recordedAt: 'asc' } } },
    });
    return rows.map(this.toDto);
  }

  // 개별 공지 조회
  async getAnnouncement(id: number): Promise<ListingAnnouncementDto | null> {
    const row = await (prisma as any).upbitListingAnnouncement.findUnique({
      where: { id },
      include: { snapshots: { orderBy: { recordedAt: 'asc' } } },
    });
    return row ? this.toDto(row) : null;
  }

  // ── Private helpers ──

  private isListingNotice(title: string): boolean {
    return LISTING_KEYWORDS.some(kw => title.includes(kw));
  }

  // 제목에서 티커 파싱: "페페(PEPE)" → "PEPE"
  parseTicker(title: string): string | null {
    const matches = [...title.matchAll(/\(([A-Z0-9]{2,12})\)/g)];
    for (const m of matches) {
      const candidate = m[1];
      if (!TICKER_EXCLUDES.has(candidate)) return candidate;
    }
    return null;
  }

  private async handleNewListing(notice: UpbitNotice): Promise<void> {
    const ticker = this.parseTicker(notice.title);

    // DB에 공지 저장
    const announcement = await (prisma as any).upbitListingAnnouncement.create({
      data: {
        noticeId: notice.id,
        title: notice.title,
        ticker,
        url: notice.url ?? `https://upbit.com/service_center/notice?id=${notice.id}`,
        status: 'announced',
      },
    });

    if (ticker) {
      // 자동매수 + 공지 시점 스냅샷 병렬 실행 (속도 우선)
      await Promise.all([
        listingAutoTraderService.executeBuy(announcement.id, ticker).catch(e =>
          console.error('[ListingMonitor] 자동매수 오류:', e)
        ),
        this.captureSnapshots(announcement.id, ticker, 'announced'),
      ]);

      // +2h, +4h 스케줄 등록
      this.scheduleFollowUpSnapshots(announcement.id, ticker);
    }
  }

  private async handleUpbitListed(ticker: string): Promise<void> {
    // ticker가 일치하는 announced 상태 공지 찾기
    const announcement = await (prisma as any).upbitListingAnnouncement.findFirst({
      where: { ticker, status: 'announced' },
      orderBy: { announcedAt: 'desc' },
    });
    if (!announcement) return;

    const listedAt = new Date();
    await (prisma as any).upbitListingAnnouncement.update({
      where: { id: announcement.id },
      data: { listedAt, status: 'listed' },
    });

    // 상장 시점 스냅샷
    await this.captureSnapshots(announcement.id, ticker, 'listed');
  }

  // 멀티거래소 가격 조회 후 DB 저장
  async captureSnapshots(announcementId: number, ticker: string, snapshotType: string): Promise<void> {
    const results = await this.fetchAllPrices(ticker);

    const data = results
      .filter(r => r.price !== null)
      .map(r => ({
        announcementId,
        exchange: r.exchange,
        price: new Prisma.Decimal(r.price!),
        volume24h: r.volume24h !== null ? new Prisma.Decimal(r.volume24h) : null,
        snapshotType,
      }));

    if (data.length > 0) {
      await (prisma as any).listingPriceSnapshot.createMany({ data });
    }
  }

  private scheduleFollowUpSnapshots(announcementId: number, ticker: string): void {
    const timers: ReturnType<typeof setTimeout>[] = [];

    for (const schedule of SNAPSHOT_SCHEDULE) {
      const timer = setTimeout(async () => {
        await this.captureSnapshots(announcementId, ticker, schedule.type);
        // +6h 완료 시 status → complete
        if (schedule.type === '+6h') {
          await (prisma as any).upbitListingAnnouncement.update({
            where: { id: announcementId },
            data: { status: 'complete' },
          });
        }
      }, schedule.delayMs);
      timers.push(timer);
    }

    this.snapshotTimers.set(announcementId, timers);
  }

  // 서버 재시작 시 진행 중인 스케줄 복원
  private async restorePendingSchedules(): Promise<void> {
    const pending = await (prisma as any).upbitListingAnnouncement.findMany({
      where: { status: { in: ['announced', 'listed'] }, ticker: { not: null } },
    });

    for (const ann of pending) {
      const elapsedMs = Date.now() - new Date(ann.announcedAt).getTime();

      for (const schedule of SNAPSHOT_SCHEDULE) {
        const remaining = schedule.delayMs - elapsedMs;
        if (remaining <= 0) {
          // 이미 지난 스냅샷: 아직 저장 안 됐으면 즉시 실행
          const exists = await (prisma as any).listingPriceSnapshot.findFirst({
            where: { announcementId: ann.id, snapshotType: schedule.type },
          });
          if (!exists) {
            await this.captureSnapshots(ann.id, ann.ticker, schedule.type);
          }
        } else {
          // 남은 시간 후 실행
          setTimeout(() => this.captureSnapshots(ann.id, ann.ticker, schedule.type), remaining);
        }
      }
    }
  }

  // 멀티거래소 가격 병렬 조회
  async fetchAllPrices(ticker: string): Promise<ExchangePriceResult[]> {
    const results = await Promise.allSettled([
      this.fetchBinancePrice(ticker),
      this.fetchBybitPrice(ticker),
      this.fetchMexcPrice(ticker),
      this.fetchBithumbPrice(ticker),
    ]);

    return results.map((r, i) => {
      const exchanges = ['binance', 'bybit', 'mexc', 'bithumb'];
      if (r.status === 'fulfilled') return r.value;
      return { exchange: exchanges[i], price: null, volume24h: null, error: String(r.reason) };
    });
  }

  private async fetchBinancePrice(ticker: string): Promise<ExchangePriceResult> {
    try {
      const res = await axios.get(
        `https://api.binance.com/api/v3/ticker/24hr?symbol=${ticker}USDT`,
        { timeout: 5000 },
      );
      return {
        exchange: 'binance',
        price: parseFloat(res.data.lastPrice),
        volume24h: parseFloat(res.data.quoteVolume),
      };
    } catch {
      return { exchange: 'binance', price: null, volume24h: null };
    }
  }

  private async fetchBybitPrice(ticker: string): Promise<ExchangePriceResult> {
    try {
      const res = await axios.get(
        `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${ticker}USDT`,
        { timeout: 5000 },
      );
      const item = res.data?.result?.list?.[0];
      if (!item) return { exchange: 'bybit', price: null, volume24h: null };
      return {
        exchange: 'bybit',
        price: parseFloat(item.lastPrice),
        volume24h: parseFloat(item.turnover24h),
      };
    } catch {
      return { exchange: 'bybit', price: null, volume24h: null };
    }
  }

  private async fetchMexcPrice(ticker: string): Promise<ExchangePriceResult> {
    try {
      const res = await axios.get(
        `https://api.mexc.com/api/v3/ticker/24hr?symbol=${ticker}USDT`,
        { timeout: 5000 },
      );
      return {
        exchange: 'mexc',
        price: parseFloat(res.data.lastPrice),
        volume24h: parseFloat(res.data.quoteVolume),
      };
    } catch {
      return { exchange: 'mexc', price: null, volume24h: null };
    }
  }

  private async fetchBithumbPrice(ticker: string): Promise<ExchangePriceResult> {
    try {
      const res = await axios.get(
        `https://api.bithumb.com/public/ticker/${ticker}_KRW`,
        { timeout: 5000 },
      );
      if (res.data?.status !== '0000') return { exchange: 'bithumb', price: null, volume24h: null };
      return {
        exchange: 'bithumb',
        price: parseFloat(res.data.data.closing_price),
        volume24h: parseFloat(res.data.data.acc_trade_value_24H),
      };
    } catch {
      return { exchange: 'bithumb', price: null, volume24h: null };
    }
  }

  private async saveMarketsToDb(markets: string[]): Promise<void> {
    if (markets.length === 0) return;
    await (prisma as any).upbitKnownMarket.createMany({
      data: markets.map((market: string) => ({ market })),
      skipDuplicates: true,
    });
  }

  private async refreshUpbitMarkets(): Promise<void> {
    try {
      const res = await axios.get('https://api.upbit.com/v1/market/all', { timeout: 5000 });
      const krwMarkets: string[] = (res.data as any[])
        .filter((m: any) => m.market.startsWith('KRW-'))
        .map((m: any) => m.market);
      this.upbitMarkets = new Set(krwMarkets);
    } catch {
      // 네트워크 오류 시 기존 캐시 유지
    }
  }

  private toDto(row: any): ListingAnnouncementDto {
    return {
      id: row.id,
      noticeId: row.noticeId,
      title: row.title,
      ticker: row.ticker,
      url: row.url,
      announcedAt: row.announcedAt,
      listedAt: row.listedAt,
      status: row.status,
      snapshots: (row.snapshots ?? []).map((s: any) => ({
        id: s.id,
        exchange: s.exchange,
        price: Number(s.price),
        volume24h: s.volume24h !== null ? Number(s.volume24h) : null,
        snapshotType: s.snapshotType,
        recordedAt: s.recordedAt,
      })),
    };
  }
}

export const upbitListingMonitorService = new UpbitListingMonitorService();
