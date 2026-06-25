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
   * 서비스 초기 부팅. baseline 마켓 스냅샷을 잡되 알림은 보내지 않음 (silent).
   */
  async initialize(): Promise<void> {
    this.lastMarketRefreshOkAt = Date.now();
    await this.checkNewBithumbMarkets({ silent: true });
  }

  /**
   * 빗썸 텔레그램 채널 폴링 → 신규상장 메시지 감지.
   * Task 5에서 구현.
   */
  async pollBithumbTelegram(): Promise<void> {
    // Task 5에서 구현
  }

  /**
   * 빗썸 공식 KRW 마켓 API 새로고침 → diff로 신규 상장 감지.
   * Task 5에서 구현.
   *
   * @param opts.silent true면 신규 발견 시 알림/매수 트리거 없이 스냅샷만 갱신 (baseline)
   */
  async checkNewBithumbMarkets(opts: { silent?: boolean } = {}): Promise<void> {
    // Task 5에서 구현
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
