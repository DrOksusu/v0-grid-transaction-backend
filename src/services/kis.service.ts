import axios from 'axios';
import {
  getCachedPrice,
  setCachedPrice,
  executeWithRateLimit,
  isRateLimitError,
} from '../utils/rate-limiter';

// 한국투자증권 API URL
const KIS_REAL_URL = 'https://openapi.koreainvestment.com:9443';  // 실전투자
const KIS_PAPER_URL = 'https://openapivts.koreainvestment.com:29443';  // 모의투자

interface KisCredentials {
  appKey: string;
  appSecret: string;
  accountNo: string;  // 계좌번호 (예: 12345678-01)
  isPaper: boolean;   // 모의투자 여부
}

interface KisTokenInfo {
  accessToken: string;
  tokenExpireAt: Date;
}

export class KisService {
  private appKey: string;
  private appSecret: string;
  private accountNo: string;
  private accountNoPrefix: string;  // 계좌번호 앞 8자리
  private accountNoSuffix: string;  // 계좌번호 뒤 2자리
  private isPaper: boolean;
  private baseUrl: string;
  private accessToken: string | null = null;
  private tokenExpireAt: Date | null = null;

  constructor(credentials: KisCredentials) {
    this.appKey = credentials.appKey;
    this.appSecret = credentials.appSecret;
    this.accountNo = credentials.accountNo;
    this.isPaper = credentials.isPaper;
    this.baseUrl = credentials.isPaper ? KIS_PAPER_URL : KIS_REAL_URL;

    // 계좌번호 파싱 (12345678-01 형식)
    const [prefix, suffix] = credentials.accountNo.split('-');
    this.accountNoPrefix = prefix || '';
    this.accountNoSuffix = suffix || '01';
  }

  // Access Token 설정 (DB에서 가져온 토큰 설정)
  setAccessToken(token: string, expireAt: Date) {
    this.accessToken = token;
    this.tokenExpireAt = expireAt;
  }

  // 토큰이 유효한지 확인
  isTokenValid(): boolean {
    if (!this.accessToken || !this.tokenExpireAt) {
      return false;
    }
    // 만료 10분 전부터 무효로 처리
    const now = new Date();
    const bufferTime = 10 * 60 * 1000; // 10분
    return this.tokenExpireAt.getTime() - bufferTime > now.getTime();
  }

  // OAuth Access Token 발급
  async getAccessToken(): Promise<KisTokenInfo> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/oauth2/tokenP`,
        {
          grant_type: 'client_credentials',
          appkey: this.appKey,
          appsecret: this.appSecret,
        },
        {
          headers: {
            'Content-Type': 'application/json',
          },
        }
      );

      const { access_token, access_token_token_expired } = response.data;

      // 토큰 만료 시간 파싱 (형식: 2024-03-20 12:00:00)
      const expireAt = new Date(access_token_token_expired);

      this.accessToken = access_token;
      this.tokenExpireAt = expireAt;

      return {
        accessToken: access_token,
        tokenExpireAt: expireAt,
      };
    } catch (error: any) {
      const errorMsg = error.response?.data?.msg1 || error.response?.data?.message || error.message;
      throw new Error(`한투 Access Token 발급 실패: ${errorMsg}`);
    }
  }

  // API 요청 헤더 생성
  private getHeaders(trId: string): Record<string, string> {
    if (!this.accessToken) {
      throw new Error('Access Token이 없습니다. 먼저 토큰을 발급받으세요.');
    }

    return {
      'Content-Type': 'application/json; charset=utf-8',
      authorization: `Bearer ${this.accessToken}`,
      appkey: this.appKey,
      appsecret: this.appSecret,
      tr_id: trId,
    };
  }

  // hashkey 생성 (POST 요청에 필요)
  private async getHashKey(body: object): Promise<string> {
    try {
      const response = await axios.post(
        `${this.baseUrl}/uapi/hashkey`,
        body,
        {
          headers: {
            'Content-Type': 'application/json',
            appkey: this.appKey,
            appsecret: this.appSecret,
          },
        }
      );
      return response.data.HASH;
    } catch (error: any) {
      throw new Error(`HashKey 생성 실패: ${error.message}`);
    }
  }

  // 토큰 만료 에러인지 확인
  private isTokenExpiredError(error: any): boolean {
    const msg = error.response?.data?.msg1 || error.response?.data?.message || error.message || '';
    return msg.includes('기간이 만료된 token') ||
           msg.includes('token') && msg.includes('만료') ||
           msg.includes('EGW00123') ||  // 토큰 만료 에러 코드
           error.response?.status === 401;
  }

  // 토큰 재발급 후 콜백 재실행 (자동 재시도)
  private async withTokenRefresh<T>(apiCall: () => Promise<T>): Promise<T> {
    try {
      return await apiCall();
    } catch (error: any) {
      // 토큰 만료 에러면 재발급 후 재시도
      if (this.isTokenExpiredError(error)) {
        console.log('[KIS] 토큰 만료 감지, 재발급 시도...');
        await this.getAccessToken();
        console.log('[KIS] 토큰 재발급 완료, API 재시도');
        return await apiCall();
      }
      throw error;
    }
  }

  // 토큰 재발급 콜백 설정 (외부에서 DB 업데이트용)
  private onTokenRefresh: ((token: string, expireAt: Date) => Promise<void>) | null = null;

  setTokenRefreshCallback(callback: (token: string, expireAt: Date) => Promise<void>) {
    this.onTokenRefresh = callback;
  }

  // OAuth Access Token 발급 (콜백 호출 포함)
  async refreshToken(): Promise<KisTokenInfo> {
    const tokenInfo = await this.getAccessToken();

    // 콜백이 설정되어 있으면 호출 (DB 저장용)
    if (this.onTokenRefresh) {
      await this.onTokenRefresh(tokenInfo.accessToken, tokenInfo.tokenExpireAt);
    }

    return tokenInfo;
  }

  // ============ 해외주식 현재가 조회 ============

  /**
   * 해외주식 현재가 조회 (캐싱 + Rate Limiting 적용)
   * @param ticker 종목코드 (예: AAPL, MSFT)
   * @param exchange 거래소 코드 (NYS: 뉴욕, NAS: 나스닥, AMS: 아멕스)
   */
  async getUSStockPrice(ticker: string, exchange: string = 'NAS') {
    // 1. 캐시 확인 (5초 이내 조회된 데이터 재사용)
    const cached = getCachedPrice<any>(ticker, exchange);
    if (cached) {
      return cached;
    }

    // 2. Rate limiting 적용된 API 호출
    return executeWithRateLimit(this.appKey, async () => {
      return this.withTokenRefresh(async () => {
        // 토큰 유효성 확인
        if (!this.isTokenValid()) {
          await this.getAccessToken();
        }

        // tr_id: 모의투자/실전투자 구분
        // 해외주식 현재가: HHDFS00000300
        const trId = 'HHDFS00000300';

        const response = await axios.get(
          `${this.baseUrl}/uapi/overseas-price/v1/quotations/price`,
          {
            headers: this.getHeaders(trId),
            params: {
              AUTH: '',
              EXCD: exchange,  // 거래소 코드
              SYMB: ticker,    // 종목 코드
            },
          }
        );

        const data = response.data;

        if (data.rt_cd !== '0') {
          throw new Error(data.msg1 || '현재가 조회 실패');
        }

        const output = data.output;

        const result = {
          ticker: ticker,
          name: output.rsym,           // 실시간 종목코드
          currentPrice: parseFloat(output.last) || 0,  // 현재가
          change: parseFloat(output.diff) || 0,        // 전일 대비
          changePercent: parseFloat(output.rate) || 0, // 등락률
          open: parseFloat(output.open) || 0,          // 시가
          high: parseFloat(output.high) || 0,          // 고가
          low: parseFloat(output.low) || 0,            // 저가
          prevClose: parseFloat(output.base) || 0,     // 전일 종가
          volume: parseInt(output.tvol) || 0,          // 거래량
          exchange: exchange,
        };

        // 3. 캐시에 저장
        setCachedPrice(ticker, exchange, result);

        return result;
      });
    });
  }

  /**
   * 해외주식 종목 검색 (간단 버전 - 현재가 조회로 유효성 확인)
   * @param ticker 종목코드
   */
  async searchUSStock(ticker: string) {
    // 나스닥, 뉴욕, 아멕스 순으로 검색
    const exchanges = ['NAS', 'NYS', 'AMS'];

    for (const exchange of exchanges) {
      try {
        const result = await this.getUSStockPrice(ticker, exchange);
        if (result.currentPrice > 0) {
          return result;
        }
      } catch {
        // 해당 거래소에 없으면 다음 거래소 검색
        continue;
      }
    }

    throw new Error(`종목을 찾을 수 없습니다: ${ticker}`);
  }

  // ============ 해외주식 잔고 조회 ============

  /**
   * 해외주식 잔고 조회 (Rate Limiting 적용)
   */
  async getUSStockBalance() {
    return executeWithRateLimit(this.appKey, async () => {
      return this.withTokenRefresh(async () => {
        if (!this.isTokenValid()) {
          await this.getAccessToken();
        }

        // tr_id: 모의투자 VTTS3012R, 실전투자 TTTS3012R
        const trId = this.isPaper ? 'VTTS3012R' : 'TTTS3012R';

        const response = await axios.get(
          `${this.baseUrl}/uapi/overseas-stock/v1/trading/inquire-balance`,
          {
            headers: this.getHeaders(trId),
            params: {
              CANO: this.accountNoPrefix,           // 계좌번호 앞 8자리
              ACNT_PRDT_CD: this.accountNoSuffix,   // 계좌번호 뒤 2자리
              OVRS_EXCG_CD: 'NASD',                 // 해외거래소코드 (NASD: 나스닥)
              TR_CRCY_CD: 'USD',                    // 거래통화코드
              CTX_AREA_FK200: '',
              CTX_AREA_NK200: '',
            },
          }
        );

        const data = response.data;

        if (data.rt_cd !== '0') {
          throw new Error(data.msg1 || '잔고 조회 실패');
        }

        // 보유 종목 목록
        const holdings = data.output1?.map((item: any) => ({
          ticker: item.ovrs_pdno,                          // 종목코드
          name: item.ovrs_item_name,                       // 종목명
          quantity: parseInt(item.ovrs_cblc_qty) || 0,     // 보유수량
          avgPrice: parseFloat(item.pchs_avg_pric) || 0,   // 평균매수가
          currentPrice: parseFloat(item.now_pric2) || 0,   // 현재가
          evalAmount: parseFloat(item.ovrs_stck_evlu_amt) || 0,  // 평가금액
          profitLoss: parseFloat(item.frcr_evlu_pfls_amt) || 0,  // 평가손익
          profitLossRate: parseFloat(item.evlu_pfls_rt) || 0,    // 수익률
        })) || [];

        // 계좌 요약
        const summary = data.output2 ? {
          totalEvalAmount: parseFloat(data.output2.tot_evlu_pfls_amt) || 0,  // 총 평가손익
          totalPurchaseAmount: parseFloat(data.output2.frcr_pchs_amt1) || 0, // 총 매수금액
        } : null;

        return {
          holdings,
          summary,
        };
      });
    });
  }

  // ============ 해외주식 주문 ============

  /**
   * 해외주식 지정가 매수 (Rate Limiting 적용)
   * @param ticker 종목코드
   * @param quantity 수량
   * @param price 가격 (USD)
   * @param exchange 거래소 코드
   */
  async buyUSStock(ticker: string, quantity: number, price: number, exchange: string = 'NASD') {
    // 미국 주식은 정수 수량만 주문 가능
    const intQuantity = Math.floor(quantity);
    if (intQuantity < 1) {
      throw new Error('주문 수량이 1주 미만입니다');
    }

    return executeWithRateLimit(this.appKey, async () => {
      return this.withTokenRefresh(async () => {
        if (!this.isTokenValid()) {
          await this.getAccessToken();
        }

        // tr_id: 모의투자 VTTT1002U, 실전투자 TTTT1002U
        const trId = this.isPaper ? 'VTTT1002U' : 'TTTT1002U';

        const body = {
          CANO: this.accountNoPrefix,
          ACNT_PRDT_CD: this.accountNoSuffix,
          OVRS_EXCG_CD: exchange,          // 거래소 코드
          PDNO: ticker,                     // 종목코드
          ORD_QTY: intQuantity.toString(),  // 주문수량 (정수)
          OVRS_ORD_UNPR: price.toFixed(2),  // 주문단가
          ORD_SVR_DVSN_CD: '0',             // 주문서버구분코드
          ORD_DVSN: '00',                   // 주문구분 (00: 지정가)
        };

        const hashKey = await this.getHashKey(body);

        const response = await axios.post(
          `${this.baseUrl}/uapi/overseas-stock/v1/trading/order`,
          body,
          {
            headers: {
              ...this.getHeaders(trId),
              hashkey: hashKey,
            },
          }
        );

        const data = response.data;

        if (data.rt_cd !== '0') {
          throw new Error(data.msg1 || '매수 주문 실패');
        }

        return {
          orderId: data.output?.ODNO,        // 주문번호
          orderDate: data.output?.ORD_TMD,   // 주문시간
          message: data.msg1,
        };
      });
    });
  }

  /**
   * 해외주식 지정가 매도 (Rate Limiting 적용)
   * @param ticker 종목코드
   * @param quantity 수량
   * @param price 가격 (USD)
   * @param exchange 거래소 코드
   */
  async sellUSStock(ticker: string, quantity: number, price: number, exchange: string = 'NASD') {
    return executeWithRateLimit(this.appKey, async () => {
      return this.withTokenRefresh(async () => {
        if (!this.isTokenValid()) {
          await this.getAccessToken();
        }

        // tr_id: 모의투자 VTTT1001U, 실전투자 TTTT1001U (매도)
        const trId = this.isPaper ? 'VTTT1001U' : 'TTTT1001U';

        const body = {
          CANO: this.accountNoPrefix,
          ACNT_PRDT_CD: this.accountNoSuffix,
          OVRS_EXCG_CD: exchange,
          PDNO: ticker,
          ORD_QTY: quantity.toString(),
          OVRS_ORD_UNPR: price.toFixed(2),
          ORD_SVR_DVSN_CD: '0',
          ORD_DVSN: '00',
        };

        const hashKey = await this.getHashKey(body);

        const response = await axios.post(
          `${this.baseUrl}/uapi/overseas-stock/v1/trading/order`,
          body,
          {
            headers: {
              ...this.getHeaders(trId),
              hashkey: hashKey,
            },
          }
        );

        const data = response.data;

        if (data.rt_cd !== '0') {
          throw new Error(data.msg1 || '매도 주문 실패');
        }

        return {
          orderId: data.output?.ODNO,
          orderDate: data.output?.ORD_TMD,
          message: data.msg1,
        };
      });
    });
  }

  // ============ 해외주식 주문 내역 조회 ============

  /**
   * 해외주식 체결 내역 조회 (Rate Limiting 적용)
   */
  async getUSStockOrders() {
    return executeWithRateLimit(this.appKey, async () => {
      return this.withTokenRefresh(async () => {
        if (!this.isTokenValid()) {
          await this.getAccessToken();
        }

        // tr_id: 모의투자 VTTS3035R, 실전투자 TTTS3035R
        const trId = this.isPaper ? 'VTTS3035R' : 'TTTS3035R';

        const today = new Date();
        const formatDate = (d: Date) => d.toISOString().slice(0, 10).replace(/-/g, '');

        // 최근 3일간의 주문 조회 (체결 확인 용도로 충분)
        const allOrders: any[] = [];
        const daysToCheck = 3;

        for (let i = 0; i < daysToCheck; i++) {
          const checkDate = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
          const ordDt = formatDate(checkDate);

          try {
            const response = await axios.get(
              `${this.baseUrl}/uapi/overseas-stock/v1/trading/inquire-ccnl`,
              {
                headers: this.getHeaders(trId),
                params: {
                  CANO: this.accountNoPrefix,
                  ACNT_PRDT_CD: this.accountNoSuffix,
                  PDNO: '%',                              // 전 종목
                  ORD_DT: ordDt,                           // 조회일자 (필수)
                  ORD_GNO_BRNO: '',                        // 주문채번지점번호
                  ODNO: '',                               // 주문번호
                  SLL_BUY_DVSN_CD: '00',                   // 00: 전체
                  CCLD_NCCS_DVSN: '00',                    // 00: 전체
                  OVRS_EXCG_CD: 'NASD',
                  SORT_SQN: 'DS',                          // DS: 내림차순
                  CTX_AREA_FK200: '',
                  CTX_AREA_NK200: '',
                },
              }
            );

            const data = response.data;

            if (data.rt_cd === '0' && data.output) {
              const orders = data.output.map((item: any) => ({
                orderId: item.odno,                         // 주문번호
                ticker: item.pdno,                          // 종목코드
                orderType: item.sll_buy_dvsn_cd === '01' ? 'sell' : 'buy',  // 매수/매도
                orderQty: parseInt(item.ft_ord_qty) || 0,   // 주문수량
                filledQty: parseInt(item.ft_ccld_qty) || 0, // 체결수량
                orderPrice: parseFloat(item.ft_ord_unpr3) || 0,  // 주문가격
                filledPrice: parseFloat(item.ft_ccld_unpr3) || 0, // 체결가격
                orderDate: item.ord_dt,                     // 주문일자
                orderTime: item.ord_tmd,                    // 주문시간
                status: parseInt(item.ft_ccld_qty) > 0 ? 'filled' : 'pending',
              }));
              allOrders.push(...orders);
            }
          } catch (error: any) {
            // 특정 날짜 조회 실패 시 무시하고 계속
            console.warn(`[KIS] ${ordDt} 체결내역 조회 실패:`, error.message);
          }
        }

        return allOrders;
      });
    });
  }

  // ============ 환율 조회 ============

  /**
   * 해외주식 LOC(Limit on Close) 매수 주문 (Rate Limiting 적용)
   * LOC: 장 마감 시점에 지정가 이하로 체결되는 주문
   * @param ticker 종목코드
   * @param quantity 수량
   * @param price LOC 지정가 (USD)
   * @param exchange 거래소 코드
   */
  async buyUSStockLOC(ticker: string, quantity: number, price: number, exchange: string = 'NASD') {
    const intQuantity = Math.floor(quantity);
    if (intQuantity < 1) {
      throw new Error('주문 수량이 1주 미만입니다');
    }

    return executeWithRateLimit(this.appKey, async () => {
      return this.withTokenRefresh(async () => {
        if (!this.isTokenValid()) {
          await this.getAccessToken();
        }

        // tr_id: 모의투자 VTTT1002U, 실전투자 TTTT1002U
        const trId = this.isPaper ? 'VTTT1002U' : 'TTTT1002U';

        const body = {
          CANO: this.accountNoPrefix,
          ACNT_PRDT_CD: this.accountNoSuffix,
          OVRS_EXCG_CD: exchange,
          PDNO: ticker,
          ORD_QTY: intQuantity.toString(),
          OVRS_ORD_UNPR: price.toFixed(2),
          ORD_SVR_DVSN_CD: '0',
          ORD_DVSN: '34',  // 34: LOC (Limit on Close) 지정가
        };

        const hashKey = await this.getHashKey(body);

        const response = await axios.post(
          `${this.baseUrl}/uapi/overseas-stock/v1/trading/order`,
          body,
          {
            headers: {
              ...this.getHeaders(trId),
              hashkey: hashKey,
            },
          }
        );

        const data = response.data;

        if (data.rt_cd !== '0') {
          throw new Error(data.msg1 || 'LOC 매수 주문 실패');
        }

        return {
          orderId: data.output?.ODNO,
          orderDate: data.output?.ORD_TMD,
          message: data.msg1,
          orderType: 'LOC',
        };
      });
    });
  }

  /**
   * 해외주식 LOC(Limit on Close) 매도 주문 (Rate Limiting 적용)
   * LOC: 장 마감 시점에 지정가 이상으로 체결되는 주문
   * @param ticker 종목코드
   * @param quantity 수량
   * @param price LOC 지정가 (USD)
   * @param exchange 거래소 코드
   */
  async sellUSStockLOC(ticker: string, quantity: number, price: number, exchange: string = 'NASD') {
    return executeWithRateLimit(this.appKey, async () => {
      return this.withTokenRefresh(async () => {
        if (!this.isTokenValid()) {
          await this.getAccessToken();
        }

        // tr_id: 모의투자 VTTT1001U, 실전투자 TTTT1001U (매도)
        const trId = this.isPaper ? 'VTTT1001U' : 'TTTT1001U';

        const body = {
          CANO: this.accountNoPrefix,
          ACNT_PRDT_CD: this.accountNoSuffix,
          OVRS_EXCG_CD: exchange,
          PDNO: ticker,
          ORD_QTY: quantity.toString(),
          OVRS_ORD_UNPR: price.toFixed(2),
          ORD_SVR_DVSN_CD: '0',
          ORD_DVSN: '34',  // 34: LOC (Limit on Close) 지정가
        };

        const hashKey = await this.getHashKey(body);

        const response = await axios.post(
          `${this.baseUrl}/uapi/overseas-stock/v1/trading/order`,
          body,
          {
            headers: {
              ...this.getHeaders(trId),
              hashkey: hashKey,
            },
          }
        );

        const data = response.data;

        if (data.rt_cd !== '0') {
          throw new Error(data.msg1 || 'LOC 매도 주문 실패');
        }

        return {
          orderId: data.output?.ODNO,
          orderDate: data.output?.ORD_TMD,
          message: data.msg1,
          orderType: 'LOC',
        };
      });
    });
  }

  /**
   * 환율 조회 (USD/KRW) (Rate Limiting 적용)
   */
  async getExchangeRate() {
    try {
      return await executeWithRateLimit(this.appKey, async () => {
        return await this.withTokenRefresh(async () => {
          if (!this.isTokenValid()) {
            await this.getAccessToken();
          }

          const trId = 'CTRP6504R';

          const response = await axios.get(
            `${this.baseUrl}/uapi/overseas-stock/v1/trading/inquire-present-balance`,
            {
              headers: this.getHeaders(trId),
              params: {
                CANO: this.accountNoPrefix,
                ACNT_PRDT_CD: this.accountNoSuffix,
                WCRC_FRCR_DVSN_CD: '02',  // 02: 외화
                NATN_CD: '840',           // 840: 미국
                TR_MKET_CD: '00',
                INQR_DVSN_CD: '00',
              },
            }
          );

          const data = response.data;

          // 환율 정보 추출 (여러 방법으로 시도)
          const exchangeRate = parseFloat(data.output2?.[0]?.frst_bltn_exrt) ||
                              parseFloat(data.output3?.exrt) ||
                              1350;  // 기본값

          return {
            currency: 'USD/KRW',
            rate: exchangeRate,
          };
        });
      });
    } catch (error: any) {
      // 환율 조회 실패 시 기본값 반환
      console.error('환율 조회 실패:', error.message);
      return {
        currency: 'USD/KRW',
        rate: 1350,  // 기본 환율
      };
    }
  }
}
