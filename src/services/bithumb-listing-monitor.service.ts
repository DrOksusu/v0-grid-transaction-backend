// 빗썸 신규상장 모니터 서비스
// 텔레그램 폴링 + 마켓 diff 두 채널로 감지하고 24h 중복 매수 방지.
import axios from 'axios';
import { parse as parseHtml } from 'node-html-parser';
import prisma from '../config/database';
import { listingAutoTraderService } from './listing-auto-trader.service';
import { kakaoNotifyService } from './kakao-notify.service';
import type { ListingAnnouncementDto } from './upbit-listing-monitor.service';

// ── 파서 (단위 테스트 대상) ─────────────────────────────────────────────

// 한글 종목명 + 영문 티커 + "원화 마켓 추가" 패턴
const BITHUMB_LISTING_PATTERN = /([가-힣\w]+?)\(([A-Z0-9]+)\)\s*원화\s*마켓\s*추가/;
// 텔레그램 메시지 본문이 [마켓 추가]로 시작하는지 (multiline + trim한 후 매칭)
const TELEGRAM_LISTING_PREFIX = /^\[마켓 추가\]/;
// 공지 URL에서 noticeId 추출
const NOTICE_URL_PATTERN = /feed\.bithumb\.com\/notice\/(\d+)/;
// 기축통화/스테이블 재상장 노이즈 필터
const TICKER_EXCLUDES = new Set(['KRW', 'BTC', 'USDT', 'ETH', 'BNB', 'USDC']);

// 합성 noticeId 대역 — upbit 모니터의 SYNTHETIC_BASE_MARKET(=1_500_000_000)과 겹치지만
// upbit_listing_announcements 테이블의 unique key가 (source, noticeId) 복합이므로
// source='BITHUMB'으로 분리되어 충돌하지 않는다.
const SYNTHETIC_BASE_MARKET = 1_500_000_000;
const SYNTHETIC_BAND = 200_000_000;

/**
 * 빗썸 신규상장 공지 제목에서 종목명 + 티커 추출.
 * 기축/스테이블 코인은 노이즈로 간주하여 null 반환.
 */
export function parseBithumbListing(
  title: string,
): { name: string; ticker: string } | null {
  const match = title.match(BITHUMB_LISTING_PATTERN);
  if (!match) return null;
  const [, name, ticker] = match;
  if (TICKER_EXCLUDES.has(ticker)) return null;
  return { name, ticker };
}

/**
 * 빗썸 텔레그램 채널 메시지에서 신규상장 정보 + noticeId 추출.
 * [마켓 추가] 프리픽스가 없거나 공지 URL이 없으면 null.
 */
export function parseTelegramMessage(
  text: string,
): { name: string; ticker: string; noticeId: number } | null {
  const trimmed = text.trim();
  if (!TELEGRAM_LISTING_PREFIX.test(trimmed)) return null;
  const listing = parseBithumbListing(trimmed);
  if (!listing) return null;
  const urlMatch = trimmed.match(NOTICE_URL_PATTERN);
  if (!urlMatch) return null;
  return { ...listing, noticeId: parseInt(urlMatch[1], 10) };
}

/**
 * 문자열을 [0, mod) 범위의 결정적 해시(djb2)로 매핑.
 * 같은 입력은 항상 같은 값 → 합성 noticeId 멱등성 보장.
 * (upbit-listing-monitor.service.ts의 stableHash와 동일 알고리즘)
 */
export function stableHash(input: string, mod: number): number {
  let hash = 5381;
  for (let i = 0; i < input.length; i++) {
    hash = (((hash << 5) + hash) + input.charCodeAt(i)) >>> 0;
  }
  return hash % mod;
}

// ── 모니터 서비스 ───────────────────────────────────────────────────────

class BithumbListingMonitorService {
  // 중복 처리 방지: 이미 본 텔레그램 메시지 ID
  private seenTelegramMsgIds: Set<string> = new Set();
  // 빗썸 KRW 마켓 스냅샷 (마켓 diff용)
  private bithumbMarkets: Set<string> = new Set();
  // 마지막 마켓 새로고침 성공 시각 (epoch ms)
  private lastMarketRefreshOkAt: number = 0;
  // 마켓 새로고침 연속 실패 횟수
  private marketRefreshFailCount: number = 0;

  /**
   * 테스트 전용: 내부 state 초기화.
   * NODE_ENV !== 'test'에서 호출 시 throw — production singleton state 우발 손실 방지.
   */
  _resetForTests(): void {
    if (process.env.NODE_ENV !== 'test') {
      throw new Error(
        '[BithumbListingMonitor] _resetForTests is test-only (NODE_ENV != test)',
      );
    }
    this.seenTelegramMsgIds.clear();
    this.bithumbMarkets.clear();
    this.lastMarketRefreshOkAt = 0;
    this.marketRefreshFailCount = 0;
  }

  /**
   * 서비스 초기 부팅. baseline 마켓 스냅샷 + 텔레그램 메시지 ID 캐시를 잡되 알림은 보내지 않음.
   */
  async initialize(): Promise<void> {
    this.lastMarketRefreshOkAt = Date.now();
    await this.checkNewBithumbMarkets({ silent: true });
    await this.initTelegramBaseline();
  }

  /**
   * 텔레그램 baseline: 서버 시작 시 현재 메시지 ID 모두 캐시 (재시작 후 과거 메시지 재처리 방지).
   * 실패해도 부팅 차단 안 함 (다음 폴링부터 정상 작동).
   */
  private async initTelegramBaseline(): Promise<void> {
    try {
      const res = await axios.get('https://t.me/s/BithumbExchange', {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        },
        timeout: 10_000,
      });
      const root = parseHtml(res.data);
      for (const msg of root.querySelectorAll('div.tgme_widget_message')) {
        const dataPost = msg.getAttribute('data-post');
        if (dataPost) this.seenTelegramMsgIds.add(dataPost);
      }
      console.log(
        `[BithumbListingMonitor] 텔레그램 baseline: ${this.seenTelegramMsgIds.size}개 메시지 ID 로드`,
      );
    } catch (err: any) {
      console.warn(
        '[BithumbListingMonitor] 텔레그램 baseline 로드 실패 (무시):',
        err?.message ?? err,
      );
    }
  }

  /**
   * announcement create 안전 wrapper.
   * P2002(unique 충돌) 시 throw 대신 기존 레코드 조회/반환 → 사이클 중단 방지.
   * created=false면 호출부에서 매수/알림 등 최초 1회 부작용을 건너뛴다.
   */
  private async createAnnouncementSafe(data: {
    noticeId: number;
    title: string;
    ticker: string;
    url: string;
    status: string;
  }): Promise<{ record: any; created: boolean }> {
    try {
      const record = await prisma.upbitListingAnnouncement.create({
        data: { source: 'BITHUMB', ...data },
      });
      return { record, created: true };
    } catch (err: any) {
      if (err?.code === 'P2002') {
        const record = await prisma.upbitListingAnnouncement.findUnique({
          where: {
            source_noticeId: {
              source: 'BITHUMB',
              noticeId: data.noticeId,
            },
          },
        });
        console.warn(
          `[BithumbListingMonitor] noticeId 중복 — 기존 레코드 사용 (ticker=${data.ticker}, noticeId=${data.noticeId})`,
        );
        return { record, created: false };
      }
      throw err;
    }
  }

  /**
   * 빗썸 텔레그램 채널 폴링 → 신규상장 메시지 감지.
   * https://t.me/s/BithumbExchange HTML을 파싱하여 [마켓 추가] 메시지 감지.
   * 각 메시지 처리는 try/catch로 격리 — 한 메시지 실패가 같은 cycle의 다른 메시지를 막지 않음.
   */
  async pollBithumbTelegram(): Promise<void> {
    let messages: any[] = [];
    try {
      const res = await axios.get('https://t.me/s/BithumbExchange', {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept-Language': 'ko-KR,ko;q=0.9,en;q=0.8',
        },
        timeout: 10_000,
      });
      const root = parseHtml(res.data);
      messages = root.querySelectorAll('div.tgme_widget_message');
    } catch (e: any) {
      console.error(
        '[BithumbListingMonitor] 텔레그램 폴링 실패:',
        e?.message ?? e,
      );
      return;
    }

    for (const msg of messages) {
      const dataPost = msg.getAttribute('data-post');
      if (!dataPost || this.seenTelegramMsgIds.has(dataPost)) continue;

      try {
        const textNode = msg.querySelector('div.tgme_widget_message_text');
        const text = (textNode?.innerText ?? '').trim();

        const parsed = parseTelegramMessage(text);
        if (!parsed) {
          // 비-상장 메시지도 캐시 (중복 처리 방지)
          this.seenTelegramMsgIds.add(dataPost);
          continue;
        }

        // 24h 내 같은 ticker로 마켓 diff에 의해 처리된 게 있는지 확인 (중복 매수 방지)
        const recent = await prisma.upbitListingAnnouncement.findFirst({
          where: {
            source: 'BITHUMB',
            ticker: parsed.ticker,
            announcedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
        });
        if (recent) {
          console.log(
            `[BithumbListingMonitor] 24h 내 같은 ticker 처리됨 — 텔레그램 skip: ${parsed.ticker}`,
          );
          this.seenTelegramMsgIds.add(dataPost);
          continue;
        }

        // announcement 생성 (P2002 중복 시 기존 레코드 반환)
        const { record, created } = await this.createAnnouncementSafe({
          noticeId: parsed.noticeId,
          title: text.split('\n')[0],
          ticker: parsed.ticker,
          url: `https://feed.bithumb.com/notice/${parsed.noticeId}`,
          status: 'announced',
        });

        if (!record) {
          console.warn(
            `[BithumbListingMonitor] announcement 생성/조회 실패 — 다음 사이클 재시도: ${parsed.ticker}`,
          );
          continue;
        }

        if (created) {
          // 카카오 알림 + 자동매수 트리거 (fire-and-forget — 폴링 루프 블록 방지)
          kakaoNotifyService
            .sendToMe(
              `🆕 [빗썸] ${parsed.name}(${parsed.ticker}) 신규 상장 감지 (텔레그램)`,
            )
            .catch((err: Error) =>
              console.error(
                '[BithumbListingMonitor] 카카오 알림 실패:',
                err.message,
              ),
            );
          listingAutoTraderService
            .executeBuy(record.id, parsed.ticker, 'BITHUMB')
            .catch((err: Error) =>
              console.error(
                '[BithumbListingMonitor] 자동매수 실패:',
                err.message,
              ),
            );
        }

        this.seenTelegramMsgIds.add(dataPost);
      } catch (err: any) {
        console.error(
          `[BithumbListingMonitor] 텔레그램 메시지 처리 오류 (${dataPost}):`,
          err?.message ?? err,
        );
      }
    }
  }

  /**
   * 빗썸 공식 KRW 마켓 API 새로고침 → diff로 신규 상장 감지.
   * 텔레그램 폴링이 누락한 케이스의 백업 채널.
   * 각 마켓 처리는 try/catch로 격리 — 한 마켓 실패가 같은 cycle의 다른 마켓을 막지 않음.
   *
   * @param opts.silent true면 신규 발견 시 알림/매수 트리거 없이 스냅샷만 갱신 (baseline)
   */
  async checkNewBithumbMarkets(opts: { silent?: boolean } = {}): Promise<void> {
    let krwMarkets: Array<{
      market: string;
      korean_name: string;
      english_name: string;
    }> = [];
    try {
      const res = await axios.get('https://api.bithumb.com/v1/market/all', {
        timeout: 10_000,
      });
      const markets: Array<{
        market: string;
        korean_name: string;
        english_name: string;
      }> = res.data;
      krwMarkets = markets.filter(m => m.market.startsWith('KRW-'));
      this.lastMarketRefreshOkAt = Date.now();
      this.marketRefreshFailCount = 0;
    } catch (e: any) {
      this.marketRefreshFailCount++;
      const elapsedSinceOk = Date.now() - this.lastMarketRefreshOkAt;
      // 10분 연속 실패 시 카카오 알림 (이후 10회마다 재알림)
      if (
        elapsedSinceOk > 10 * 60 * 1000 &&
        this.marketRefreshFailCount % 10 === 1
      ) {
        kakaoNotifyService
          .sendToMe(
            '⚠️ [빗썸] 마켓 목록 조회 10분 연속 실패 — 감지 blind 가능성',
          )
          .catch((notifyErr: Error) =>
            console.error(
              '[BithumbListingMonitor] 카카오 알림 실패:',
              notifyErr.message,
            ),
          );
      }
      console.error(
        '[BithumbListingMonitor] 마켓 diff 실패:',
        e?.message ?? e,
      );
      return;
    }

    if (this.bithumbMarkets.size === 0) {
      // 초기 baseline 설정 (announcement 생성 안 함)
      for (const m of krwMarkets) this.bithumbMarkets.add(m.market);
      return;
    }

    for (const m of krwMarkets) {
      if (this.bithumbMarkets.has(m.market)) continue;

      try {
        const ticker = m.market.replace('KRW-', '');
        if (TICKER_EXCLUDES.has(ticker)) {
          this.bithumbMarkets.add(m.market);
          continue;
        }

        // 24h 내 같은 ticker로 텔레그램 감지된 게 있는지 확인 (중복 매수 방지)
        const recent = await prisma.upbitListingAnnouncement.findFirst({
          where: {
            source: 'BITHUMB',
            ticker,
            announcedAt: { gte: new Date(Date.now() - 24 * 60 * 60 * 1000) },
          },
        });
        if (recent) {
          console.log(
            `[BithumbListingMonitor] 24h 내 같은 ticker 처리됨 — 마켓 diff skip: ${ticker}`,
          );
          // 캐시는 갱신해야 다음 cycle에서 재진입 안 함
          this.bithumbMarkets.add(m.market);
          continue;
        }

        // ticker 기반 결정적 합성 noticeId (멱등성)
        const syntheticNoticeId =
          SYNTHETIC_BASE_MARKET + stableHash(ticker, SYNTHETIC_BAND);

        const { record, created } = await this.createAnnouncementSafe({
          noticeId: syntheticNoticeId,
          title: `[마켓 추가] ${m.korean_name}(${ticker}) 원화 마켓 추가`,
          ticker,
          url: m.market,
          status: 'announced',
        });

        if (!record) {
          console.warn(
            `[BithumbListingMonitor] 마켓 diff announcement 생성/조회 실패 — 다음 사이클 재시도: ${ticker}`,
          );
          continue;
        }

        if (!opts.silent && created) {
          kakaoNotifyService
            .sendToMe(
              `🆕 [빗썸] ${m.korean_name}(${ticker}) 거래 개시 감지 (마켓 diff)`,
            )
            .catch((err: Error) =>
              console.error(
                '[BithumbListingMonitor] 카카오 알림 실패:',
                err.message,
              ),
            );
          listingAutoTraderService
            .executeBuy(record.id, ticker, 'BITHUMB')
            .catch((err: Error) =>
              console.error(
                '[BithumbListingMonitor] 자동매수 실패:',
                err.message,
              ),
            );
        }

        this.bithumbMarkets.add(m.market);
      } catch (err: any) {
        console.error(
          `[BithumbListingMonitor] 마켓 처리 오류 (${m.market}):`,
          err?.message ?? err,
        );
      }
    }
  }

  /**
   * 빗썸 상장 공지 목록 조회 (source=BITHUMB만, 최신순).
   * upbit listAnnouncements와 동일한 ListingAnnouncementDto[] 반환 — 컨트롤러 source 분기 시 동일 인터페이스.
   */
  async listAnnouncements(limit = 50): Promise<ListingAnnouncementDto[]> {
    const rows = await prisma.upbitListingAnnouncement.findMany({
      where: { source: 'BITHUMB' },
      orderBy: { announcedAt: 'desc' },
      take: limit,
      include: { snapshots: { orderBy: { recordedAt: 'asc' } } },
    });
    return rows.map(row => this.toDto(row));
  }

  /**
   * 빗썸 단일 공지 조회 (source=BITHUMB만).
   * id는 PK이지만 source 필터를 추가해 다른 source 공지가 잘못 노출되지 않도록 방어.
   */
  async getAnnouncement(id: number): Promise<ListingAnnouncementDto | null> {
    const row = await prisma.upbitListingAnnouncement.findFirst({
      where: { id, source: 'BITHUMB' },
      include: { snapshots: { orderBy: { recordedAt: 'asc' } } },
    });
    return row ? this.toDto(row) : null;
  }

  /**
   * Prisma row → ListingAnnouncementDto. upbit 모니터의 toDto와 동일 shape (snapshots 포함).
   */
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

  /**
   * 운영 모니터링용 메트릭.
   */
  getStats(): Record<string, any> {
    return {
      seenTelegramMsgIds: this.seenTelegramMsgIds.size,
      bithumbMarkets: this.bithumbMarkets.size,
      lastMarketRefreshOkAt: this.lastMarketRefreshOkAt,
      marketRefreshFailCount: this.marketRefreshFailCount,
    };
  }
}

export const bithumbListingMonitorService = new BithumbListingMonitorService();
