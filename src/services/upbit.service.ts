import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const UPBIT_API_URL = 'https://api.upbit.com/v1';
// API 요청 쓰로틀링을 위한 설정 (429 에러 방지)
const ORDER_API_MIN_INTERVAL = 500; // 주문 API 최소 간격 (ms) - 초당 2건으로 안전하게 설정
const PUBLIC_API_MIN_INTERVAL = 200; // 공개 API 최소 간격 (ms) - 초당 5건
const MAX_RETRIES = 3; // 429 에러 시 최대 재시도 횟수
let lastOrderApiCall = 0;
let lastPublicApiCall = 0;

/**
 * 주문 API 호출 전 딜레이 (429 에러 방지)
 */
async function throttleOrderApi(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastOrderApiCall;

  if (elapsed < ORDER_API_MIN_INTERVAL) {
    const delay = ORDER_API_MIN_INTERVAL - elapsed;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  lastOrderApiCall = Date.now();
}

/**
 * 공개 API (현재가 등) 호출 전 딜레이 (429 에러 방지)
 */
async function throttlePublicApi(): Promise<void> {
  const now = Date.now();
  const elapsed = now - lastPublicApiCall;

  if (elapsed < PUBLIC_API_MIN_INTERVAL) {
    const delay = PUBLIC_API_MIN_INTERVAL - elapsed;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  lastPublicApiCall = Date.now();
}

/**
 * 429 에러 발생 시 지수 백오프로 재시도
 */
async function executeWithRetry<T>(
  fn: () => Promise<T>,
  context: string = 'API'
): Promise<T> {
  let lastError: any;

  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      // 429 에러인 경우 지수 백오프로 재시도
      if (error.response?.status === 429) {
        const backoffMs = Math.min(1000 * Math.pow(2, attempt), 5000); // 최대 5초
        console.log(`[Upbit] ${context} 429 에러, ${backoffMs}ms 후 재시도 (${attempt + 1}/${MAX_RETRIES})`);
        await new Promise(resolve => setTimeout(resolve, backoffMs));
        continue;
      }

      // 429가 아닌 에러는 즉시 throw
      throw error;
    }
  }

  // 모든 재시도 실패
  throw lastError;
}


/**
 * Upbit KRW 마켓 주문가격 단위 (호가 단위)
 * 가격대별 틱 사이즈에 맞게 가격을 반올림
 * https://docs.upbit.com/kr/docs/krw-market-info
 */
function roundToTickSize(price: number): number {
  let tickSize: number;

  if (price >= 2000000) {
    tickSize = 1000;      // 2,000,000원 이상
  } else if (price >= 1000000) {
    tickSize = 1000;      // 1,000,000 ~ 2,000,000원
  } else if (price >= 500000) {
    tickSize = 500;       // 500,000 ~ 1,000,000원
  } else if (price >= 100000) {
    tickSize = 100;       // 100,000 ~ 500,000원
  } else if (price >= 50000) {
    tickSize = 50;        // 50,000 ~ 100,000원
  } else if (price >= 10000) {
    tickSize = 10;        // 10,000 ~ 50,000원
  } else if (price >= 5000) {
    tickSize = 5;         // 5,000 ~ 10,000원
  } else if (price >= 1000) {
    tickSize = 1;         // 1,000 ~ 5,000원
  } else if (price >= 100) {
    tickSize = 1;         // 100 ~ 1,000원
  } else if (price >= 10) {
    tickSize = 0.1;       // 10 ~ 100원
  } else if (price >= 1) {
    tickSize = 0.01;      // 1 ~ 10원
  } else if (price >= 0.1) {
    tickSize = 0.001;     // 0.1 ~ 1원
  } else if (price >= 0.01) {
    tickSize = 0.0001;    // 0.01 ~ 0.1원
  } else {
    tickSize = 0.00001;   // 0.01원 미만
  }

  // 부동소수점 오차 방지를 위해 정수 연산 후 다시 나누기
  const multiplier = 1 / tickSize;
  return Math.round(price * multiplier) / multiplier;
}

interface UpbitCredentials {
  accessKey: string;
  secretKey: string;
}

interface OrderParams {
  market: string;
  side: 'bid' | 'ask'; // bid: 매수, ask: 매도
  ord_type: 'limit' | 'price' | 'market';
  price?: string;
  volume?: string;
}

export class UpbitService {
  private accessKey: string;
  private secretKey: string;

  constructor(credentials: UpbitCredentials) {
    this.accessKey = credentials.accessKey;
    this.secretKey = credentials.secretKey;
  }

  // JWT 토큰 생성
  private generateToken(queryString?: string): string {
    const payload = {
      access_key: this.accessKey,
      nonce: uuidv4(),
    };

    if (queryString) {
      const hash = crypto
        .createHash('sha512')
        .update(queryString, 'utf-8')
        .digest('hex');

      Object.assign(payload, {
        query_hash: hash,
        query_hash_alg: 'SHA512',
      });
    }

    return jwt.sign(payload, this.secretKey);
  }

  // API 요청 헤더 생성
  private getHeaders(queryString?: string): Record<string, string> {
    const token = this.generateToken(queryString);
    return {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    };
  }

  // 계좌 조회
  async getAccounts() {
    try {
      const response = await axios.get(`${UPBIT_API_URL}/accounts`, {
        headers: this.getHeaders(),
      });
      return response.data;
    } catch (error: any) {
      throw new Error(`업비트 계좌 조회 실패: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  // 주문 가능 정보 조회
  async getOrdersChance(market: string) {
    try {
      const queryString = `market=${market}`;
      const response = await axios.get(
        `${UPBIT_API_URL}/orders/chance?${queryString}`,
        {
          headers: this.getHeaders(queryString),
        }
      );
      return response.data;
    } catch (error: any) {
      throw new Error(`주문 가능 정보 조회 실패: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  // 지정가 매수 주문
  async buyLimit(market: string, price: number, volume: number) {
    try {
      await throttleOrderApi();  // ← 여기 추가
      const roundedPrice = roundToTickSize(price);
      const params: OrderParams = {
        market,
        side: 'bid',
        ord_type: 'limit',
        price: roundedPrice.toString(),
        volume: volume.toString(),
      };

      const queryString = new URLSearchParams(params as any).toString();

      const response = await axios.post(
        `${UPBIT_API_URL}/orders`,
        params,
        {
          headers: this.getHeaders(queryString),
        }
      );

      return response.data;
    } catch (error: any) {
      throw new Error(`매수 주문 실패: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  // 시장가 매수 주문 (추격매수용)
  // price: 매수에 사용할 총 금액 (KRW)
  async buyMarket(market: string, totalPrice: number) {
    try {
      await throttleOrderApi();  // ← 여기 추가
      const params: OrderParams = {
        market,
        side: 'bid',
        ord_type: 'price',  // 시장가 매수는 'price' 타입
        price: totalPrice.toString(),  // 매수에 사용할 총 금액
      };

      const queryString = new URLSearchParams(params as any).toString();

      const response = await axios.post(
        `${UPBIT_API_URL}/orders`,
        params,
        {
          headers: this.getHeaders(queryString),
        }
      );

      return response.data;
    } catch (error: any) {
      throw new Error(`시장가 매수 주문 실패: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  // 지정가 매도 주문
  async sellLimit(market: string, price: number, volume: number) {
    try {
      await throttleOrderApi();  // ← 여기 추가
      const roundedPrice = roundToTickSize(price);
      const params: OrderParams = {
        market,
        side: 'ask',
        ord_type: 'limit',
        price: roundedPrice.toString(),
        volume: volume.toString(),
      };

      const queryString = new URLSearchParams(params as any).toString();

      const response = await axios.post(
        `${UPBIT_API_URL}/orders`,
        params,
        {
          headers: this.getHeaders(queryString),
        }
      );

      return response.data;
    } catch (error: any) {
      throw new Error(`매도 주문 실패: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  // 주문 취소
  async cancelOrder(uuid: string) {
    try {
      await throttleOrderApi();  // ← 여기 추가
      const queryString = `uuid=${uuid}`;

      const response = await axios.delete(
        `${UPBIT_API_URL}/order?${queryString}`,
        {
          headers: this.getHeaders(queryString),
        }
      );

      return response.data;
    } catch (error: any) {
      throw new Error(`주문 취소 실패: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  // 주문 조회 (단건) - 429 에러 시 자동 재시도
  async getOrder(uuid: string) {
    return executeWithRetry(async () => {
      await throttleOrderApi();
      const queryString = `uuid=${uuid}`;

      const response = await axios.get(
        `${UPBIT_API_URL}/order?${queryString}`,
        {
          headers: this.getHeaders(queryString),
        }
      );

      return response.data;
    }, `getOrder(${uuid.slice(0, 8)}...)`);
  }

  // 주문 목록 조회 (배치) - 429 에러 자동 재시도 + 청크 처리
  // uuids: 조회할 주문 UUID 배열 (자동으로 청크 분할)
  async getOrdersByUuids(uuids: string[]): Promise<any[]> {
    if (uuids.length === 0) return [];

    // UUID는 36자, uuids[]=는 8자 → 항목당 약 45자
    // 업비트 API URL 길이 제한 고려하여 5개씩 처리 (안전하게)
    const CHUNK_SIZE = 5;
    const results: any[] = [];
    const totalChunks = Math.ceil(uuids.length / CHUNK_SIZE);

    // 청크 개수가 많으면 로그 출력
    if (totalChunks > 10) {
      console.log(`[Upbit] 대량 주문 조회: ${uuids.length}건, ${totalChunks}청크로 분할`);
    }

    // 청크로 분할하여 순차 처리
    for (let i = 0; i < uuids.length; i += CHUNK_SIZE) {
      const chunk = uuids.slice(i, i + CHUNK_SIZE);

      const chunkResult = await executeWithRetry(async () => {
        await throttleOrderApi();

        // Upbit API는 uuids[] 파라미터로 여러 주문을 한번에 조회 가능
        // URLSearchParams는 []를 %5B%5D로 인코딩하므로 수동으로 query string 생성
        const queryString = chunk.map(uuid => `uuids[]=${uuid}`).join('&');

        const response = await axios.get(
          `${UPBIT_API_URL}/orders/uuids?${queryString}`,
          {
            headers: this.getHeaders(queryString),
          }
        );

        return response.data;
      }, `getOrdersByUuids(청크 ${Math.floor(i / CHUNK_SIZE) + 1}/${Math.ceil(uuids.length / CHUNK_SIZE)}, ${chunk.length}건)`);

      results.push(...chunkResult);

      // 다음 청크 전 딜레이 (마지막 청크가 아닌 경우)
      if (i + CHUNK_SIZE < uuids.length) {
        await new Promise(resolve => setTimeout(resolve, 300));
      }
    }

    return results;
  }

  // 마켓별 주문 조회 (state: wait, done, cancel)
  // URL 길이 제한 없이 해당 마켓의 모든 주문을 조회
  async getOrdersByMarket(market: string, state: string = 'wait'): Promise<any[]> {
    return executeWithRetry(async () => {
      await throttleOrderApi();

      const queryString = `market=${market}&state=${state}&order_by=desc`;

      const response = await axios.get(
        `${UPBIT_API_URL}/orders?${queryString}`,
        {
          headers: this.getHeaders(queryString),
        }
      );

      return response.data;
    }, `getOrdersByMarket(${market}, ${state})`);
  }

  /**
   * 최근 체결 완료된 주문 조회 (state=done)
   * - 마켓 전체 또는 특정 마켓의 최근 체결 주문을 조회
   * - UUID 배치 조회보다 훨씬 효율적 (API 1회 호출로 최대 100건)
   * @param market 특정 마켓만 조회 (예: 'KRW-BTC'), undefined면 전체
   * @param limit 조회 개수 (기본 100, 최대 100)
   */
  async getFilledOrders(market?: string, limit: number = 100): Promise<any[]> {
    return executeWithRetry(async () => {
      await throttleOrderApi();

      const params: Record<string, string> = {
        state: 'done',
        limit: Math.min(limit, 100).toString(),
        order_by: 'desc',  // 최신순
      };

      if (market) {
        params.market = market;
      }

      const queryString = new URLSearchParams(params).toString();

      const response = await axios.get(
        `${UPBIT_API_URL}/orders?${queryString}`,
        {
          headers: this.getHeaders(queryString),
        }
      );

      return response.data;
    }, `getFilledOrders(${market || 'all'})`);
  }

  // 여러 마켓의 미체결 주문 일괄 조회
  async getWaitingOrdersByMarkets(markets: string[]): Promise<Map<string, any[]>> {
    const result = new Map<string, any[]>();

    for (const market of markets) {
      try {
        const orders = await this.getOrdersByMarket(market, 'wait');
        result.set(market, orders);

        // 다음 마켓 조회 전 딜레이
        if (markets.indexOf(market) < markets.length - 1) {
          await new Promise(resolve => setTimeout(resolve, 200));
        }
      } catch (error: any) {
        console.error(`[Upbit] ${market} 주문 조회 실패:`, error.message);
        result.set(market, []);
      }
    }

    return result;
  }

  // 입금 리스트 조회 (currency: KRW, USDT 등)
  async getDeposits(currency?: string, state?: 'submitting' | 'submitted' | 'almost_accepted' | 'rejected' | 'accepted' | 'processing', limit: number = 100) {
    return executeWithRetry(async () => {
      await throttleOrderApi();

      const params: Record<string, string> = {};
      if (currency) params.currency = currency;
      if (state) params.state = state;
      params.limit = limit.toString();

      const queryString = new URLSearchParams(params).toString();

      const response = await axios.get(
        `${UPBIT_API_URL}/deposits?${queryString}`,
        {
          headers: this.getHeaders(queryString),
        }
      );

      return response.data;
    }, `getDeposits(${currency || 'all'})`);
  }

  // 개별 입금 조회 (uuid 또는 txid)
  async getDeposit(params: { uuid?: string; txid?: string; currency?: string }) {
    return executeWithRetry(async () => {
      await throttleOrderApi();

      const queryParams: Record<string, string> = {};
      if (params.uuid) queryParams.uuid = params.uuid;
      if (params.txid) queryParams.txid = params.txid;
      if (params.currency) queryParams.currency = params.currency;

      const queryString = new URLSearchParams(queryParams).toString();

      const response = await axios.get(
        `${UPBIT_API_URL}/deposit?${queryString}`,
        {
          headers: this.getHeaders(queryString),
        }
      );

      return response.data;
    }, `getDeposit`);
  }

  // 입금 주소 조회 (특정 화폐의 입금 주소)
  async getDepositAddress(currency: string, netType?: string) {
    return executeWithRetry(async () => {
      await throttleOrderApi();

      const params: Record<string, string> = { currency };
      if (netType) params.net_type = netType;

      const queryString = new URLSearchParams(params).toString();

      const response = await axios.get(
        `${UPBIT_API_URL}/deposits/coin_address?${queryString}`,
        {
          headers: this.getHeaders(queryString),
        }
      );

      return response.data;
    }, `getDepositAddress(${currency})`);
  }

  // 현재가 조회 (공개 API)
  static async getCurrentPrice(market: string, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        await throttlePublicApi();
        const response = await axios.get(
          `${UPBIT_API_URL}/ticker?markets=${market}`
        );
        return response.data[0];
      } catch (error: any) {
        // 429 에러면 대기 후 재시도
        if (error.response?.status === 429 && i < retries - 1) {
          console.log(`[Upbit] 429 에러, ${(i + 1) * 500}ms 후 재시도...`);
          await new Promise(resolve => setTimeout(resolve, (i + 1) * 500));
          continue;
        }
        throw new Error(`현재가 조회 실패: ${error.message}`);
      }
    }
  }

  // 여러 종목 현재가 일괄 조회 (공개 API)
  static async getMultiplePrices(markets: string[], retries = 3): Promise<Map<string, number>> {
    const priceMap = new Map<string, number>();

    if (markets.length === 0) {
      return priceMap;
    }

    // 중복 제거
    const uniqueMarkets = [...new Set(markets)];

    for (let i = 0; i < retries; i++) {
      try {
        await throttlePublicApi();
        const response = await axios.get(
          `${UPBIT_API_URL}/ticker?markets=${uniqueMarkets.join(',')}`
        );

        for (const ticker of response.data) {
          priceMap.set(ticker.market, ticker.trade_price);
        }

        return priceMap;
      } catch (error: any) {
        // 429 에러면 대기 후 재시도
        if (error.response?.status === 429 && i < retries - 1) {
          console.log(`[Upbit] 429 에러, ${(i + 1) * 500}ms 후 재시도...`);
          await new Promise(resolve => setTimeout(resolve, (i + 1) * 500));
          continue;
        }
        console.error(`[Upbit] 일괄 현재가 조회 실패:`, error.message);
        return priceMap; // 실패 시 빈 맵 반환 (에러 무시)
      }
    }

    return priceMap;
  }
}
