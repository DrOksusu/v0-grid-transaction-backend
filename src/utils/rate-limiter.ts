/**
 * KIS API Rate Limiter & Cache
 *
 * KIS API 제한:
 * - 초당 약 20건 요청 제한 (appKey별)
 * - 동일 요청 반복 시 제한 강화
 *
 * 해결 방법:
 * 1. 현재가 캐싱 (5초)
 * 2. 요청 큐 + 스로틀링
 * 3. 지수 백오프 재시도
 */

interface CacheEntry<T> {
  data: T;
  expireAt: number;
}

interface QueuedRequest<T> {
  execute: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (error: any) => void;
  retryCount: number;
  appKey: string;
}

// 전역 캐시 (종목별 현재가)
const priceCache = new Map<string, CacheEntry<any>>();
const PRICE_CACHE_TTL = 5000; // 5초

// 전역 요청 큐 (appKey별로 분리)
const requestQueues = new Map<string, QueuedRequest<any>[]>();
const processingFlags = new Map<string, boolean>();

// Rate limit 설정
const REQUEST_INTERVAL = 100; // 100ms (초당 10건으로 안전하게)
const MAX_RETRIES = 3;
const BASE_BACKOFF_MS = 1000; // 1초

/**
 * 현재가 캐시 키 생성
 */
export function getPriceCacheKey(ticker: string, exchange: string): string {
  return `${ticker}:${exchange}`;
}

/**
 * 캐시된 현재가 조회
 */
export function getCachedPrice<T>(ticker: string, exchange: string): T | null {
  const key = getPriceCacheKey(ticker, exchange);
  const entry = priceCache.get(key);

  if (!entry) return null;

  if (Date.now() > entry.expireAt) {
    priceCache.delete(key);
    return null;
  }

  return entry.data as T;
}

/**
 * 현재가 캐시 저장
 */
export function setCachedPrice<T>(ticker: string, exchange: string, data: T): void {
  const key = getPriceCacheKey(ticker, exchange);
  priceCache.set(key, {
    data,
    expireAt: Date.now() + PRICE_CACHE_TTL,
  });
}

/**
 * Rate limit 에러인지 확인
 */
export function isRateLimitError(error: any): boolean {
  const msg = error.response?.data?.msg1 || error.response?.data?.message || error.message || '';
  const status = error.response?.status;

  return status === 429 ||
         msg.includes('초과') ||
         msg.includes('제한') ||
         msg.includes('too many') ||
         msg.includes('rate limit') ||
         msg.includes('EGW00201') ||  // 초당 거래건수 초과
         msg.includes('EGW00202');    // 1분당 거래건수 초과
}

/**
 * 지수 백오프 대기 시간 계산
 */
function getBackoffDelay(retryCount: number): number {
  // 1초, 2초, 4초...
  return BASE_BACKOFF_MS * Math.pow(2, retryCount);
}

/**
 * 지정된 시간만큼 대기
 */
function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * 요청 큐 처리 (appKey별)
 */
async function processQueue(appKey: string): Promise<void> {
  if (processingFlags.get(appKey)) return;

  const queue = requestQueues.get(appKey);
  if (!queue || queue.length === 0) return;

  processingFlags.set(appKey, true);

  while (queue.length > 0) {
    const request = queue.shift()!;

    try {
      const result = await request.execute();
      request.resolve(result);
    } catch (error: any) {
      if (isRateLimitError(error) && request.retryCount < MAX_RETRIES) {
        // Rate limit: 재시도
        const backoffDelay = getBackoffDelay(request.retryCount);
        console.log(`[RateLimiter] Rate limit hit for ${appKey}, retry ${request.retryCount + 1}/${MAX_RETRIES} after ${backoffDelay}ms`);

        await delay(backoffDelay);

        // 재시도 횟수 증가 후 큐 앞에 다시 추가
        request.retryCount++;
        queue.unshift(request);
      } else {
        request.reject(error);
      }
    }

    // 다음 요청 전 대기
    if (queue.length > 0) {
      await delay(REQUEST_INTERVAL);
    }
  }

  processingFlags.set(appKey, false);
}

/**
 * Rate-limited API 요청 실행
 * @param appKey API 키 (사용자별 큐 분리용)
 * @param execute 실제 API 호출 함수
 */
export function executeWithRateLimit<T>(
  appKey: string,
  execute: () => Promise<T>
): Promise<T> {
  return new Promise((resolve, reject) => {
    // 해당 appKey의 큐 가져오기 (없으면 생성)
    if (!requestQueues.has(appKey)) {
      requestQueues.set(appKey, []);
    }

    const queue = requestQueues.get(appKey)!;

    // 요청을 큐에 추가
    queue.push({
      execute,
      resolve,
      reject,
      retryCount: 0,
      appKey,
    });

    // 큐 처리 시작
    processQueue(appKey);
  });
}

/**
 * 캐시 통계 조회 (디버깅용)
 */
export function getCacheStats() {
  const now = Date.now();
  let validEntries = 0;
  let expiredEntries = 0;

  priceCache.forEach((entry) => {
    if (now > entry.expireAt) {
      expiredEntries++;
    } else {
      validEntries++;
    }
  });

  return {
    totalEntries: priceCache.size,
    validEntries,
    expiredEntries,
    queueSizes: Object.fromEntries(
      Array.from(requestQueues.entries()).map(([key, queue]) => [key.slice(0, 8) + '...', queue.length])
    ),
  };
}

/**
 * 캐시 정리 (만료된 항목 제거)
 */
export function cleanupCache(): void {
  const now = Date.now();
  const keysToDelete: string[] = [];

  priceCache.forEach((entry, key) => {
    if (now > entry.expireAt) {
      keysToDelete.push(key);
    }
  });

  keysToDelete.forEach(key => priceCache.delete(key));

  if (keysToDelete.length > 0) {
    console.log(`[RateLimiter] Cleaned up ${keysToDelete.length} expired cache entries`);
  }
}

// 주기적 캐시 정리 (1분마다)
setInterval(cleanupCache, 60000);
