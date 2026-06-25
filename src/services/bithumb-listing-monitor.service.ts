// 빗썸 신규상장 모니터 서비스
// Task 4: 골격 + 파서 구현 (TDD GREEN)
// 실제 텔레그램 폴링 / 마켓 diff 로직은 Task 5에서 구현됨
import axios from 'axios';
import { parse as parseHtml } from 'node-html-parser';
import prisma from '../config/database';
import { listingAutoTraderService } from './listing-auto-trader.service';
import { kakaoNotifyService } from './kakao-notify.service';

// ── 파서 (단위 테스트 대상) ─────────────────────────────────────────────

// 한글 종목명 + 영문 티커 + "원화 마켓 추가" 패턴
const BITHUMB_LISTING_PATTERN = /([가-힣\w\d]+?)\(([A-Z0-9]+)\)\s*원화\s*마켓\s*추가/;
// 텔레그램 메시지 본문이 [마켓 추가]로 시작하는지
const TELEGRAM_LISTING_PREFIX = /^\[마켓 추가\]/;
// 공지 URL에서 noticeId 추출
const NOTICE_URL_PATTERN = /feed\.bithumb\.com\/notice\/(\d+)/;
// 기축통화/스테이블 재상장 노이즈 필터
const TICKER_EXCLUDES = new Set(['KRW', 'BTC', 'USDT', 'ETH', 'BNB', 'USDC']);

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
  if (!TELEGRAM_LISTING_PREFIX.test(text)) return null;
  const listing = parseBithumbListing(text);
  if (!listing) return null;
  const urlMatch = text.match(NOTICE_URL_PATTERN);
  if (!urlMatch) return null;
  return { ...listing, noticeId: parseInt(urlMatch[1], 10) };
}

// ── 모니터 서비스 (Task 5에서 본격 구현) ───────────────────────────────

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
   * production 코드에서는 호출 금지 (singleton의 누적 state가 필요한 곳에서 손실 위험).
   */
  _resetForTests(): void {
    this.seenTelegramMsgIds.clear();
    this.bithumbMarkets.clear();
    this.lastMarketRefreshOkAt = 0;
    this.marketRefreshFailCount = 0;
  }

  /**
   * 서비스 초기 부팅. baseline 마켓 스냅샷을 잡되 알림은 보내지 않음 (silent).
   */
  async initialize(): Promise<void> {
    this.lastMarketRefreshOkAt = Date.now();
    await this.checkNewBithumbMarkets({ silent: true });
  }

  /**
   * 빗썸 텔레그램 채널 폴링 → 신규상장 메시지 감지.
   * https://t.me/s/BithumbExchange HTML을 파싱하여 [마켓 추가] 메시지 감지.
   */
  async pollBithumbTelegram(): Promise<void> {
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
      const messages = root.querySelectorAll('div.tgme_widget_message');

      for (const msg of messages) {
        const dataPost = msg.getAttribute('data-post');
        if (!dataPost || this.seenTelegramMsgIds.has(dataPost)) continue;

        const textNode = msg.querySelector('div.tgme_widget_message_text');
        const text = textNode?.text ?? '';

        const parsed = parseTelegramMessage(text);
        if (!parsed) {
          // 비-상장 메시지도 캐시 (중복 처리 방지)
          this.seenTelegramMsgIds.add(dataPost);
          continue;
        }

        // 중복 announcement 방지 (composite unique: source + noticeId)
        const existing = await prisma.upbitListingAnnouncement.findUnique({
          where: {
            source_noticeId: { source: 'BITHUMB', noticeId: parsed.noticeId },
          },
        });
        if (existing) {
          this.seenTelegramMsgIds.add(dataPost);
          continue;
        }

        // 새 상장 감지 — 테이블은 upbit_listing_announcements를 공유하되 source='BITHUMB'로 분리
        const announcement = await prisma.upbitListingAnnouncement.create({
          data: {
            source: 'BITHUMB',
            noticeId: parsed.noticeId,
            title: text.split('\n')[0],
            ticker: parsed.ticker,
            url: `https://feed.bithumb.com/notice/${parsed.noticeId}`,
            announcedAt: new Date(),
            status: 'announced',
          },
        });

        // 카카오 알림 + 자동매수 트리거 (fire-and-forget — 폴링 루프 블록 방지)
        kakaoNotifyService
          .sendToMe(
            `🆕 [빗썸] ${parsed.name}(${parsed.ticker}) 신규 상장 감지 (텔레그램)`,
          )
          .catch((e: Error) =>
            console.error('[BithumbListingMonitor] 카카오 알림 실패:', e.message),
          );
        listingAutoTraderService
          .executeBuy(announcement.id, parsed.ticker)
          .catch((e: Error) =>
            console.error('[BithumbListingMonitor] 자동매수 실패:', e.message),
          );

        this.seenTelegramMsgIds.add(dataPost);
      }
    } catch (e: any) {
      console.error('[BithumbListingMonitor] 텔레그램 폴링 실패:', e.message);
    }
  }

  /**
   * 빗썸 공식 KRW 마켓 API 새로고침 → diff로 신규 상장 감지.
   * 텔레그램 폴링이 누락한 케이스의 백업 채널.
   *
   * @param opts.silent true면 신규 발견 시 알림/매수 트리거 없이 스냅샷만 갱신 (baseline)
   */
  async checkNewBithumbMarkets(opts: { silent?: boolean } = {}): Promise<void> {
    try {
      const res = await axios.get('https://api.bithumb.com/v1/market/all', {
        timeout: 10_000,
      });
      const markets: Array<{
        market: string;
        korean_name: string;
        english_name: string;
      }> = res.data;
      const krwMarkets = markets.filter(m => m.market.startsWith('KRW-'));

      if (this.bithumbMarkets.size === 0) {
        // 초기 baseline 설정 (announcement 생성 안 함)
        for (const m of krwMarkets) this.bithumbMarkets.add(m.market);
        this.lastMarketRefreshOkAt = Date.now();
        this.marketRefreshFailCount = 0;
        return;
      }

      for (const m of krwMarkets) {
        if (this.bithumbMarkets.has(m.market)) continue;

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

        // 합성 noticeId — UPBIT 대역과 동일 범위지만 source가 다르므로 unique 키 충돌 없음
        const SYNTHETIC_BASE_MARKET = 1_500_000_000;
        const syntheticNoticeId =
          SYNTHETIC_BASE_MARKET + (Date.now() % 200_000_000);

        const announcement = await prisma.upbitListingAnnouncement.create({
          data: {
            source: 'BITHUMB',
            noticeId: syntheticNoticeId,
            title: `[마켓 추가] ${m.korean_name}(${ticker}) 원화 마켓 추가`,
            ticker,
            url: m.market,
            announcedAt: new Date(),
            status: 'announced',
          },
        });

        if (!opts.silent && !recent) {
          kakaoNotifyService
            .sendToMe(
              `🆕 [빗썸] ${m.korean_name}(${ticker}) 거래 개시 감지 (마켓 diff)`,
            )
            .catch((e: Error) =>
              console.error(
                '[BithumbListingMonitor] 카카오 알림 실패:',
                e.message,
              ),
            );
          listingAutoTraderService
            .executeBuy(announcement.id, ticker)
            .catch((e: Error) =>
              console.error(
                '[BithumbListingMonitor] 자동매수 실패:',
                e.message,
              ),
            );
        }

        this.bithumbMarkets.add(m.market);
      }

      this.lastMarketRefreshOkAt = Date.now();
      this.marketRefreshFailCount = 0;
    } catch (e: any) {
      this.marketRefreshFailCount++;
      const elapsedSinceOk = Date.now() - this.lastMarketRefreshOkAt;
      // 10분 연속 실패 시 카카오 1회 알림 (이후 10회마다 재알림)
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
      console.error('[BithumbListingMonitor] 마켓 diff 실패:', e.message);
    }
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
