import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import axios from 'axios';
import { v4 as uuidv4 } from 'uuid';

const UPBIT_API_URL = 'https://api.upbit.com/v1';

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

  // 주문 조회
  async getOrder(uuid: string) {
    try {
      const queryString = `uuid=${uuid}`;

      const response = await axios.get(
        `${UPBIT_API_URL}/order?${queryString}`,
        {
          headers: this.getHeaders(queryString),
        }
      );

      return response.data;
    } catch (error: any) {
      throw new Error(`주문 조회 실패: ${error.response?.data?.error?.message || error.message}`);
    }
  }

  // 현재가 조회 (공개 API)
  static async getCurrentPrice(market: string) {
    try {
      const response = await axios.get(
        `${UPBIT_API_URL}/ticker?markets=${market}`
      );
      return response.data[0];
    } catch (error: any) {
      throw new Error(`현재가 조회 실패: ${error.message}`);
    }
  }
}
