import axios from 'axios';
import { parse as parseHtml } from 'node-html-parser';
import { Prisma } from '@prisma/client';
import prisma from '../config/database';
import { listingAutoTraderService } from './listing-auto-trader.service';
import { kakaoNotifyService } from './kakao-notify.service';

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

// 텔레그램 noticeId 충돌 방지 오프셋 (Upbit 공지 ID는 수만 단위, TG 메시지 ID도 유사 → 10억 오프셋)
const TG_NOTICE_ID_OFFSET = 1_000_000_000;
// Twitter noticeId 오프셋: TG보다 더 큰 값으로 분리 (tweet ID는 snowflake 19자리 → BigInt 불필요, 해시 방식 사용)
const TWITTER_NOTICE_ID_OFFSET = 2_000_000_000;
// Twitter API 폴링 간격 (5분 — API 쿼터 절약)
const TWITTER_POLL_INTERVAL_MS = 5 * 60 * 1000;

class UpbitListingMonitorService {
  // 알림이 발생한 noticeId 캐시 (중복 방지, 재시작 후엔 DB로 복원)
  private seenNoticeIds: Set<number> = new Set();
  // 업비트 마켓 목록 캐시
  private upbitMarkets: Set<string> = new Set();
  // 스냅샷 스케줄 타이머 (announcementId → timer ids)
  private snapshotTimers: Map<number, ReturnType<typeof setTimeout>[]> = new Map();
  // 텔레그램 채널 메시지 ID 캐시
  private seenTelegramMsgIds: Set<number> = new Set();
  // 트위터 트윗 ID 캐시 (string - snowflake ID는 JS number 정밀도 초과)
  private seenTweetIds: Set<string> = new Set();
  // 트위터 유저 ID 캐시 (handle → id 룩업 1회)
  private twitterUpbitUserId: string | null = null;
  // 트위터 마지막 폴링 시각
  private lastTwitterPollAt: number = 0;

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

    // 텔레그램 채널 현재 메시지 ID를 baseline으로 로드 (재시작 후 과거 메시지 재처리 방지)
    await this.initTelegramBaseline();

    // 트위터 현재 트윗 ID를 baseline으로 로드
    await this.initTwitterBaseline();

    // 진행 중인 공지 (listed 미완료) 스케줄 복원
    await this.restorePendingSchedules();
  }

  // 업비트 공지 폴링 (에이전트 tick에서 호출) — 거래 카테고리 최신 10개
  // CF Worker → FlareSolverr → 직접 요청 → 마켓 목록 감지 순으로 폴백
  async pollAnnouncements(): Promise<void> {
    let notices: UpbitNotice[] = [];
    try {
      notices = await this.fetchNoticesViaCfWorker();
    } catch {
      try {
        notices = await this.fetchNoticesViaFlare();
      } catch {
        // FlareSolverr 미실행 또는 오류 → 직접 요청 폴백
        try {
          notices = await this.fetchNoticesDirect();
        } catch (err: any) {
          if (err?.response?.status) {
            console.warn(`[ListingMonitor] 공지 API ${err.response.status} — 마켓 목록 감지로 폴백`);
          }
          return;
        }
      }
    }

    for (const notice of notices) {
      if (this.seenNoticeIds.has(notice.id)) continue;
      if (!this.isListingNotice(notice.title)) continue;

      // 즉시 seenIds에 추가 → 중복 폴링 방지
      this.seenNoticeIds.add(notice.id);
      await this.handleNewListing(notice);
    }
  }

  // 텔레그램 @upbitkr 채널 폴링 — t.me/s/upbitkr 공개 웹뷰 스크래핑
  async pollTelegramChannel(): Promise<void> {
    let messages: { id: number; text: string }[] = [];
    try {
      messages = await this.fetchTelegramMessages();
    } catch (err: any) {
      console.warn('[ListingMonitor] 텔레그램 채널 조회 실패:', err.message);
      return;
    }

    for (const msg of messages) {
      if (this.seenTelegramMsgIds.has(msg.id)) continue;
      this.seenTelegramMsgIds.add(msg.id);

      if (!this.isListingNotice(msg.text)) continue;
      const ticker = this.parseTicker(msg.text);
      if (!ticker) continue;

      console.log(`[ListingMonitor] 텔레그램 상장 공지 감지: ${ticker} (msgId=${msg.id})`);
      await this.handleTelegramListing(msg.id, msg.text, ticker);
    }
  }

  // 트위터 @UPBITexchange 폴링 (5분 간격 — API 쿼터 절약)
  // 필요 env: TWITTER_BEARER_TOKEN, TWITTER_UPBIT_HANDLE(기본값: UPBITexchange)
  async pollTwitterListings(): Promise<void> {
    if (!process.env.TWITTER_BEARER_TOKEN) return;
    if (Date.now() - this.lastTwitterPollAt < TWITTER_POLL_INTERVAL_MS) return;
    this.lastTwitterPollAt = Date.now();

    let tweets: { id: string; text: string }[] = [];
    try {
      tweets = await this.fetchUpbitTweets();
    } catch (err: any) {
      console.warn('[ListingMonitor] 트위터 조회 실패:', err.message);
      return;
    }

    for (const tweet of tweets) {
      if (this.seenTweetIds.has(tweet.id)) continue;
      this.seenTweetIds.add(tweet.id);

      if (!this.isListingNotice(tweet.text)) continue;
      const ticker = this.parseTicker(tweet.text);
      if (!ticker) continue;

      console.log(`[ListingMonitor] 트위터 상장 공지 감지: ${ticker} (tweetId=${tweet.id})`);
      await this.handleTwitterListing(tweet.id, tweet.text, ticker);
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
    return {
      seenNoticeCount: this.seenNoticeIds.size,
      seenTelegramMsgCount: this.seenTelegramMsgIds.size,
      seenTweetCount: this.seenTweetIds.size,
      twitterEnabled: !!process.env.TWITTER_BEARER_TOKEN,
      pendingAnnouncementCount: this.snapshotTimers.size,
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

  // Cloudflare Workers 릴레이를 통해 공지 API 호출 (1순위 우회)
  // CF Workers는 Cloudflare 자체 IP로 실행 → AWS IP 차단 우회 가능
  // 필요 env: CF_WORKER_URL, CF_WORKER_SECRET(선택)
  private async fetchNoticesViaCfWorker(): Promise<UpbitNotice[]> {
    const workerUrl = process.env.CF_WORKER_URL;
    if (!workerUrl) throw new Error('CF_WORKER_URL not set');

    const headers: Record<string, string> = { accept: 'application/json' };
    if (process.env.CF_WORKER_SECRET) {
      headers['X-Relay-Secret'] = process.env.CF_WORKER_SECRET;
    }

    const res = await axios.get(workerUrl, {
      timeout: 10000,
      headers,
      params: { page: 1, per_page: 10, category: '거래' },
    });

    const raw: any[] = res.data?.data?.notices ?? [];
    return raw.map((n: any) => ({
      id: n.id,
      title: n.title,
      url: `https://www.upbit.com/service_center/notice?id=${n.id}`,
      created_at: n.listed_at,
    }));
  }

  // FlareSolverr를 통해 공지 API 호출 (Cloudflare 우회)
  // grid-bot 컨테이너 기준: 호스트(172.17.0.1)에서 실행 중인 FlareSolverr에 접근
  private async fetchNoticesViaFlare(): Promise<UpbitNotice[]> {
    const FLARESOLVERR = process.env.FLARESOLVERR_URL ?? 'http://172.17.0.1:8191';
    const target = 'https://api-manager.upbit.com/api/v1/announcements?os=web&page=1&per_page=10&category=%EA%B1%B0%EB%9E%98';

    const res = await axios.post(
      `${FLARESOLVERR}/v1`,
      { cmd: 'request.get', url: target, maxTimeout: 60000 },
      { timeout: 70000 },
    );

    if (res.data?.status !== 'ok') {
      throw new Error(`FlareSolverr status: ${res.data?.status ?? 'unknown'}`);
    }

    const body = JSON.parse(res.data.solution.response);
    const raw: any[] = body?.data?.notices ?? [];
    return raw.map((n: any) => ({
      id: n.id,
      title: n.title,
      url: `https://www.upbit.com/service_center/notice?id=${n.id}`,
      created_at: n.listed_at,
    }));
  }

  // 직접 HTTP 요청 (FlareSolverr 없을 때 폴백)
  private async fetchNoticesDirect(): Promise<UpbitNotice[]> {
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
    return raw.map((n: any) => ({
      id: n.id,
      title: n.title,
      url: `https://www.upbit.com/service_center/notice?id=${n.id}`,
      created_at: n.listed_at,
    }));
  }

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

    // 같은 ticker에 대해 이미 처리 중인 공지가 있으면 skip (채널 간 레이스 컨디션 방지)
    if (ticker) {
      const dup = await (prisma as any).upbitListingAnnouncement.findFirst({
        where: { ticker, status: 'announced' },
      });
      if (dup) {
        console.log(`[ListingMonitor] 공지 API 중복 skip: ${ticker} (기존 id=${dup.id})`);
        return;
      }
    }

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
      // 카카오 알림 발송 (비동기, 실패해도 계속)
      const kakaoMsg =
        `[업비트 신규 상장 공지]\n` +
        `티커: ${ticker}\n` +
        `제목: ${notice.title}\n` +
        `공지: ${notice.url}\n` +
        `https://v0-grid-transaction.vercel.app/admin/upbit-listings`;
      kakaoNotifyService.sendToMe(kakaoMsg).catch(e =>
        console.error('[ListingMonitor] 카카오 알림 실패:', e.message)
      );

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
    console.log(`[ListingMonitor] 신규 마켓 감지: KRW-${ticker}`);

    // ticker가 일치하는 announced 상태 공지 찾기
    let announcement = await (prisma as any).upbitListingAnnouncement.findFirst({
      where: { ticker, status: 'announced' },
      orderBy: { announcedAt: 'desc' },
    });

    if (!announcement) {
      // 사전 공지 없이 마켓 목록에 직접 등장 (공지 API 차단 등) → 공지 레코드 생성
      console.log(`[ListingMonitor] 사전 공지 없이 마켓 등장: ${ticker} — 직접 공지 생성`);
      const syntheticNoticeId = 3_000_000_000 + (Date.now() % 1_000_000_000);
      announcement = await (prisma as any).upbitListingAnnouncement.create({
        data: {
          noticeId: syntheticNoticeId,
          title: `[마켓 감지] ${ticker} 신규 거래지원`,
          ticker,
          url: `https://upbit.com/exchange?code=CRIX.UPBIT.KRW-${ticker}`,
          status: 'announced',
        },
      });
      this.seenNoticeIds.add(syntheticNoticeId);

      const kakaoMsg =
        `[업비트 신규 상장 - 마켓 직접 감지]\n` +
        `티커: ${ticker}\n` +
        `(공지 API 차단으로 공지 미감지, 마켓 목록에서 직접 포착)\n` +
        `https://v0-grid-transaction.vercel.app/admin/upbit-listings`;
      kakaoNotifyService.sendToMe(kakaoMsg).catch(e =>
        console.error('[ListingMonitor] 카카오 알림 실패:', e.message)
      );

      await Promise.all([
        listingAutoTraderService.executeBuy(announcement.id, ticker).catch(e =>
          console.error('[ListingMonitor] 마켓 감지 자동매수 오류:', e)
        ),
        this.captureSnapshots(announcement.id, ticker, 'announced'),
      ]);

      this.scheduleFollowUpSnapshots(announcement.id, ticker);
    }

    const listedAt = new Date();
    await (prisma as any).upbitListingAnnouncement.update({
      where: { id: announcement.id },
      data: { listedAt, status: 'listed' },
    });

    // 카카오 알림 — 실제 거래 시작 시점
    const kakaoMsg =
      `[업비트 상장 완료 - 거래 시작]\n` +
      `티커: ${ticker}\n` +
      `https://upbit.com/exchange?code=CRIX.UPBIT.KRW-${ticker}`;
    kakaoNotifyService.sendToMe(kakaoMsg).catch(e =>
      console.error('[ListingMonitor] 카카오 상장완료 알림 실패:', e.message)
    );

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
      this.fetchGateioPrice(ticker),
    ]);

    return results.map((r, i) => {
      const exchanges = ['binance', 'bybit', 'mexc', 'bithumb', 'gateio'];
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

  private async fetchGateioPrice(ticker: string): Promise<ExchangePriceResult> {
    try {
      const res = await axios.get(
        `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${ticker}_USDT`,
        { timeout: 5000 },
      );
      if (!Array.isArray(res.data) || res.data.length === 0) {
        return { exchange: 'gateio', price: null, volume24h: null };
      }
      const item = res.data[0];
      return {
        exchange: 'gateio',
        price: parseFloat(item.last ?? '0') || null,
        volume24h: parseFloat(item.quote_volume ?? '0') || null,
      };
    } catch {
      return { exchange: 'gateio', price: null, volume24h: null };
    }
  }

  // 서버 시작 시 텔레그램 채널의 현재 메시지 ID를 기록 (과거 메시지 재처리 방지)
  private async initTelegramBaseline(): Promise<void> {
    try {
      const messages = await this.fetchTelegramMessages();
      for (const msg of messages) {
        this.seenTelegramMsgIds.add(msg.id);
      }
      console.log(`[ListingMonitor] 텔레그램 baseline: ${this.seenTelegramMsgIds.size}개 메시지 ID 로드`);
    } catch (err: any) {
      console.warn('[ListingMonitor] 텔레그램 baseline 로드 실패 (무시):', err.message);
    }
  }

  // 트위터 baseline: 서버 시작 시 현재 트윗 ID 기록 (과거 트윗 재처리 방지)
  private async initTwitterBaseline(): Promise<void> {
    if (!process.env.TWITTER_BEARER_TOKEN) return;
    try {
      const tweets = await this.fetchUpbitTweets();
      for (const t of tweets) this.seenTweetIds.add(t.id);
      console.log(`[ListingMonitor] 트위터 baseline: ${this.seenTweetIds.size}개 트윗 ID 로드`);
    } catch (err: any) {
      console.warn('[ListingMonitor] 트위터 baseline 로드 실패 (무시):', err.message);
    }
  }

  // Twitter API v2 Recent Search: "신규 거래지원" 포함 트윗 검색
  // 특정 계정 의존 없이 상장 공지 봇(@bwenews, @6551News 등) 전체를 커버
  private async fetchUpbitTweets(): Promise<{ id: string; text: string }[]> {
    const bearer = process.env.TWITTER_BEARER_TOKEN!;
    const query = process.env.TWITTER_SEARCH_QUERY
      ?? '"신규 거래지원" Upbit -is:retweet';

    const res = await axios.get(
      'https://api.twitter.com/2/tweets/search/recent',
      {
        headers: { Authorization: `Bearer ${bearer}` },
        timeout: 10000,
        params: {
          query,
          max_results: 10,
          'tweet.fields': 'id,text,created_at',
        },
      },
    );

    return (res.data?.data ?? []).map((t: any) => ({ id: String(t.id), text: t.text }));
  }

  // 트위터 공지 → UpbitListingAnnouncement 생성 + 자동매수
  private async handleTwitterListing(tweetId: string, text: string, ticker: string): Promise<void> {
    // tweet ID(19자리 snowflake)를 Int에 맞게 해시: 뒤 9자리 + OFFSET
    const syntheticNoticeId = TWITTER_NOTICE_ID_OFFSET + parseInt(tweetId.slice(-9), 10);

    const existing = await (prisma as any).upbitListingAnnouncement.findFirst({
      where: { ticker, status: 'announced' },
      orderBy: { announcedAt: 'desc' },
    });
    if (existing) {
      console.log(`[ListingMonitor] 트위터 공지 중복 skip: ${ticker} (기존 id=${existing.id})`);
      return;
    }

    const handle = process.env.TWITTER_UPBIT_HANDLE ?? 'UPBITexchange';
    const announcement = await (prisma as any).upbitListingAnnouncement.create({
      data: {
        noticeId: syntheticNoticeId,
        title: `[트위터] ${text.slice(0, 200)}`,
        ticker,
        url: `https://twitter.com/${handle}/status/${tweetId}`,
        status: 'announced',
      },
    });

    this.seenNoticeIds.add(syntheticNoticeId);

    // 카카오 알림
    const kakaoMsg =
      `[업비트 신규 상장 공지 - 트위터]\n` +
      `티커: ${ticker}\n` +
      `https://v0-grid-transaction.vercel.app/admin/upbit-listings`;
    kakaoNotifyService.sendToMe(kakaoMsg).catch(e =>
      console.error('[ListingMonitor] 카카오 알림 실패:', e.message)
    );

    await Promise.all([
      listingAutoTraderService.executeBuy(announcement.id, ticker).catch((e: Error) =>
        console.error('[ListingMonitor] 트위터 자동매수 오류:', e)
      ),
      this.captureSnapshots(announcement.id, ticker, 'announced'),
    ]);

    this.scheduleFollowUpSnapshots(announcement.id, ticker);
  }

  // t.me/s/upbitkr 공개 웹뷰에서 메시지 파싱 (인증 불필요)
  private async fetchTelegramMessages(): Promise<{ id: number; text: string }[]> {
    const res = await axios.get('https://t.me/s/upbitkr', {
      timeout: 10000,
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        'Accept-Language': 'ko-KR,ko;q=0.9',
      },
    });

    const root = parseHtml(res.data as string);
    const result: { id: number; text: string }[] = [];

    for (const el of root.querySelectorAll('.tgme_widget_message')) {
      const postAttr = el.getAttribute('data-post') ?? '';
      const idMatch = postAttr.match(/\/(\d+)$/);
      if (!idMatch) continue;
      const id = parseInt(idMatch[1], 10);

      const textEl = el.querySelector('.tgme_widget_message_text');
      const text = (textEl?.innerText ?? '').trim();
      if (text) result.push({ id, text });
    }

    return result;
  }

  // 텔레그램 공지 → UpbitListingAnnouncement 생성 + 자동매수
  private async handleTelegramListing(telegramMsgId: number, text: string, ticker: string): Promise<void> {
    const syntheticNoticeId = TG_NOTICE_ID_OFFSET + telegramMsgId;

    // 이미 DB에 동일 공지가 있으면 skip (공지 API/수동 등록으로 이미 처리된 경우)
    const existing = await (prisma as any).upbitListingAnnouncement.findFirst({
      where: { ticker, status: 'announced' },
      orderBy: { announcedAt: 'desc' },
    });
    if (existing) {
      console.log(`[ListingMonitor] 텔레그램 공지 중복 skip: ${ticker} (기존 id=${existing.id})`);
      return;
    }

    const announcement = await (prisma as any).upbitListingAnnouncement.create({
      data: {
        noticeId: syntheticNoticeId,
        title: `[텔레그램] ${text.slice(0, 200)}`,
        ticker,
        url: `https://t.me/upbitkr/${telegramMsgId}`,
        status: 'announced',
      },
    });

    this.seenNoticeIds.add(syntheticNoticeId);

    // 카카오 알림
    const kakaoMsg =
      `[업비트 신규 상장 공지 - 텔레그램]\n` +
      `티커: ${ticker}\n` +
      `https://v0-grid-transaction.vercel.app/admin/upbit-listings`;
    kakaoNotifyService.sendToMe(kakaoMsg).catch(e =>
      console.error('[ListingMonitor] 카카오 알림 실패:', e.message)
    );

    await Promise.all([
      listingAutoTraderService.executeBuy(announcement.id, ticker).catch((e: Error) =>
        console.error('[ListingMonitor] 텔레그램 자동매수 오류:', e)
      ),
      this.captureSnapshots(announcement.id, ticker, 'announced'),
    ]);

    this.scheduleFollowUpSnapshots(announcement.id, ticker);
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
