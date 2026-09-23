// GateLeg 단위 테스트
// 이식 원본: listing-auto-trader.service.ts buyOnGateio, listing-auto-seller.service.ts sellOnGateio/getGateioCoinBalance/getGateioAmountPrecision
// 값 단위는 USDT (ExchangeLeg의 grossKrw/feeKrw 필드는 레거시 라벨 — USDT 값을 채운다)
import axios from 'axios';
import { GateLeg } from '../../../src/services/exchange/gate-leg';
import { gateioRequest } from '../../../src/services/exchange/exchange-signer';

jest.mock('../../../src/services/exchange/exchange-signer', () => ({
  ...jest.requireActual('../../../src/services/exchange/exchange-signer'),
  gateioRequest: jest.fn(),
}));

// getAmountPrecision(원본 getGateioAmountPrecision)이 공개 엔드포인트를 axios.get으로 직접 호출 — 실네트워크 호출 방지
jest.mock('axios');

const mockedGateioRequest = gateioRequest as jest.Mock;
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('GateLeg', () => {
  const creds = { apiKey: 'test-api-key', secretKey: 'test-secret-key' };
  let leg: GateLeg;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.get.mockResolvedValue({ data: { amount_precision: 8 } });
    leg = new GateLeg(creds);
  });

  describe('buyIoc', () => {
    it('market BUY(amount=USDT) 즉시 응답(fee-in-coin) → filledQty=실수취코인(수수료차감), grossKrw=지출USDT', async () => {
      // usdtAmount = min(500*0.0184=9.199999...(float), budget없음) → floor(*100)/100 = 9.19 (buyOnMexc와 동일 절사 방식)
      mockedGateioRequest.mockResolvedValueOnce({
        id: 'gate-buy-1',
        filled_amount: '500',
        avg_deal_price: '0.0184',
        filled_total: '9.19',
        fee: '0.5',
        fee_currency: 'ALEO',
      });

      const result = await leg.buyIoc('ALEO', 500, 0.0184);

      expect(result).not.toBeNull();
      // 실수취 코인 = filled_amount(500) - fee(0.5, ALEO) = 499.5
      expect(result!.filledQty).toBeCloseTo(499.5);
      expect(result!.grossKrw).toBe(9.19);
      expect(result!.feeKrw).toBeCloseTo(0.5 * 0.0184);

      // Gate market buy 파라미터 확인: amount=USDT 금액 (quote), side=buy, type=market, tif=ioc
      const call = mockedGateioRequest.mock.calls[0];
      expect(call[0]).toBe(creds.apiKey);
      expect(call[1]).toBe(creds.secretKey);
      expect(call[2]).toBe('POST');
      expect(call[3]).toBe('/api/v4/spot/orders');
      const body = JSON.parse(call[5]);
      expect(body).toMatchObject({
        currency_pair: 'ALEO_USDT',
        type: 'market',
        side: 'buy',
        amount: '9.19',
        time_in_force: 'ioc',
      });
    });

    it('fee_currency=USDT면 filledQty는 그대로, feeKrw는 fee값 그대로', async () => {
      mockedGateioRequest.mockResolvedValueOnce({
        id: 'gate-buy-2',
        filled_amount: '500',
        avg_deal_price: '0.0184',
        filled_total: '9.2',
        fee: '0.0092',
        fee_currency: 'USDT',
      });

      const result = await leg.buyIoc('ALEO', 500, 0.0184);

      expect(result).not.toBeNull();
      expect(result!.filledQty).toBe(500); // 코인 차감 없음
      expect(result!.feeKrw).toBeCloseTo(0.0092);
    });

    it('maxQuoteBudget 지정 시 예산 상한 적용(절사, 최소주문 3 USDT 이상인 예산)', async () => {
      mockedGateioRequest.mockResolvedValueOnce({
        id: 'gate-buy-3',
        filled_amount: '217',
        avg_deal_price: '0.0184',
        filled_total: '4.00',
        fee: '0',
        fee_currency: 'USDT',
      });

      // qty*priceHint = 500*0.0184 = 9.2 > budget 4 → budget 4 사용, 절사 4.00
      await leg.buyIoc('ALEO', 500, 0.0184, 4);

      const call = mockedGateioRequest.mock.calls[0];
      const body = JSON.parse(call[5]);
      expect(parseFloat(body.amount)).toBeLessThanOrEqual(4);
      expect(body.amount).toBe('4.00');
    });

    it('Gate 최소주문 3 USDT 미만이면 null 반환(주문 호출 안 함)', async () => {
      // qty*priceHint = 100*0.0184 = 1.84 USDT < 3 최소주문
      const result = await leg.buyIoc('ALEO', 100, 0.0184);

      expect(result).toBeNull();
      expect(mockedGateioRequest).not.toHaveBeenCalled();
    });

    it('즉시 응답에 filled_amount 없으면 폴링으로 체결 확인', async () => {
      mockedGateioRequest
        .mockResolvedValueOnce({ id: 'gate-buy-4', filled_amount: '0', avg_deal_price: '0' }) // 주문
        .mockResolvedValueOnce({ filled_amount: '500', avg_deal_price: '0.0184', filled_total: '9.2', fee: '0', fee_currency: 'USDT' }); // 폴링

      const result = await leg.buyIoc('ALEO', 500, 0.0184);

      expect(result).not.toBeNull();
      expect(result!.filledQty).toBe(500);
      expect(result!.grossKrw).toBe(9.2);
    });

    it('미체결(폴링해도 0)이면 null 반환', async () => {
      mockedGateioRequest
        .mockResolvedValueOnce({ id: 'gate-buy-5', filled_amount: '0', avg_deal_price: '0' })
        .mockResolvedValueOnce({ filled_amount: '0', avg_deal_price: '0', filled_total: '0' })
        .mockResolvedValueOnce({ filled_amount: '0', avg_deal_price: '0', filled_total: '0' })
        .mockResolvedValueOnce({ filled_amount: '0', avg_deal_price: '0', filled_total: '0' })
        .mockResolvedValueOnce({ filled_amount: '0', avg_deal_price: '0', filled_total: '0' });

      const result = await leg.buyIoc('ALEO', 500, 0.0184);
      expect(result).toBeNull();
    });

    it('네트워크 오류 등은 throw 한다', async () => {
      mockedGateioRequest.mockRejectedValueOnce(new Error('Gate.io network error'));

      await expect(leg.buyIoc('ALEO', 500, 0.0184)).rejects.toThrow('Gate.io network error');
    });
  });

  describe('sellIoc', () => {
    it('market SELL(amount=base 코인수량) → filled_amount/filled_total 파싱', async () => {
      mockedGateioRequest
        .mockResolvedValueOnce([{ available: '500' }]) // getGateioCoinBalance
        .mockResolvedValueOnce({
          id: 'gate-sell-1',
          filled_amount: '500',
          avg_deal_price: '0.0182',
          filled_total: '9.1',
          fee: '0.0091',
          fee_currency: 'USDT',
        });
      // amount_precision은 axios.get 경유(beforeEach 기본값 8 사용) — gateioRequest 큐에 포함되지 않음

      const result = await leg.sellIoc('ALEO', 500);

      expect(result).not.toBeNull();
      expect(result!.filledQty).toBe(500);
      expect(result!.grossKrw).toBe(9.1);
      expect(result!.feeKrw).toBeCloseTo(0.0091);

      const call = mockedGateioRequest.mock.calls[1];
      const body = JSON.parse(call[5]);
      expect(body).toMatchObject({
        currency_pair: 'ALEO_USDT',
        type: 'market',
        side: 'sell',
        time_in_force: 'ioc',
      });
      expect(body.amount).toBe('500');
    });

    it('실잔고가 요청 수량보다 적으면 실잔고로 보정 후 주문', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { amount_precision: 2 } });
      mockedGateioRequest
        .mockResolvedValueOnce([{ available: '499.5' }]) // 실잔고 499.5
        .mockResolvedValueOnce({
          id: 'gate-sell-2',
          filled_amount: '499.5',
          avg_deal_price: '0.0182',
          filled_total: '9.09',
          fee: '0',
          fee_currency: 'USDT',
        });

      await leg.sellIoc('ALEO', 500);

      const call = mockedGateioRequest.mock.calls[1];
      const body = JSON.parse(call[5]);
      expect(parseFloat(body.amount)).toBeLessThanOrEqual(499.5);
    });

    it('amount_precision 절사 적용(소수점 자리수 초과 시 내림, ALEO 정수 정밀도 0 케이스 포함)', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { amount_precision: 1 } }); // 소수 1자리까지만
      mockedGateioRequest
        .mockResolvedValueOnce([{ available: '500.789' }])
        .mockResolvedValueOnce({
          id: 'gate-sell-3',
          filled_amount: '500.7',
          avg_deal_price: '0.0182',
          filled_total: '9.1',
          fee: '0',
          fee_currency: 'USDT',
        });

      await leg.sellIoc('ALEO', 500.789);

      const call = mockedGateioRequest.mock.calls[1];
      const body = JSON.parse(call[5]);
      expect(body.amount).toBe('500.7');
    });

    it('amount_precision=0(ALEO 실제 정수 정밀도)이면 소수점 전부 절사', async () => {
      mockedAxios.get.mockResolvedValueOnce({ data: { amount_precision: 0 } });
      mockedGateioRequest
        .mockResolvedValueOnce([{ available: '500.789' }])
        .mockResolvedValueOnce({
          id: 'gate-sell-3b',
          filled_amount: '500',
          avg_deal_price: '0.0182',
          filled_total: '9.1',
          fee: '0',
          fee_currency: 'USDT',
        });

      await leg.sellIoc('ALEO', 500.789);

      const call = mockedGateioRequest.mock.calls[1];
      const body = JSON.parse(call[5]);
      expect(body.amount).toBe('500');
    });

    it('미체결(filled_amount=0, left=amount)이면 null 반환', async () => {
      mockedGateioRequest
        .mockResolvedValueOnce([{ available: '500' }])
        .mockResolvedValueOnce({
          id: 'gate-sell-4',
          filled_amount: '0',
          avg_deal_price: '0',
          filled_total: '0',
          amount: '500',
          left: '500',
        });

      const result = await leg.sellIoc('ALEO', 500);
      expect(result).toBeNull();
    });

    it('잔고 0이면 매도 시도 없이 null 반환', async () => {
      mockedGateioRequest.mockResolvedValueOnce([{ available: '0' }]);

      const result = await leg.sellIoc('ALEO', 500);
      expect(result).toBeNull();
    });

    it('잔고조회 실패(네트워크 블립)는 흡수하고 요청 수량 그대로 매도 시도한다', async () => {
      mockedGateioRequest
        .mockRejectedValueOnce(new Error('accounts lookup timeout')) // getGateioCoinBalance 내부에서 catch됨
        .mockResolvedValueOnce({
          id: 'gate-sell-5',
          filled_amount: '500',
          avg_deal_price: '0.0182',
          filled_total: '9.1',
          fee: '0',
          fee_currency: 'USDT',
        });

      const result = await leg.sellIoc('ALEO', 500);

      expect(result).not.toBeNull();
      expect(result!.filledQty).toBe(500);
      const call = mockedGateioRequest.mock.calls[1];
      const body = JSON.parse(call[5]);
      expect(body.amount).toBe('500');
    });

    it('네트워크 오류(주문 자체 실패)는 throw 한다', async () => {
      mockedGateioRequest
        .mockResolvedValueOnce([{ available: '500' }])
        .mockRejectedValueOnce(new Error('Gate.io order network error'));

      await expect(leg.sellIoc('ALEO', 500)).rejects.toThrow('Gate.io order network error');
    });
  });

  describe('getBalance', () => {
    it('/api/v4/spot/accounts 에서 available 잔고를 반환한다', async () => {
      mockedGateioRequest.mockResolvedValueOnce([{ currency: 'USDT', available: '123.45' }]);

      const balance = await leg.getBalance('USDT');
      expect(balance).toBeCloseTo(123.45);
    });

    it('자산이 없으면 0을 반환한다', async () => {
      mockedGateioRequest.mockResolvedValueOnce([]);
      const balance = await leg.getBalance('ALEO');
      expect(balance).toBe(0);
    });

    it('조회 실패 시 throw 한다 (getBalance는 흡수하지 않음)', async () => {
      mockedGateioRequest.mockRejectedValueOnce(new Error('accounts network error'));
      await expect(leg.getBalance('USDT')).rejects.toThrow('accounts network error');
    });
  });

  describe('미사용 메서드 — throw', () => {
    it('buyGtc는 throw', async () => {
      await expect(leg.buyGtc('ALEO', 1, 1)).rejects.toThrow();
    });
    it('placeMakerBid는 throw', async () => {
      await expect(leg.placeMakerBid('ALEO', 1, 1)).rejects.toThrow();
    });
    it('placeMakerAsk는 throw', async () => {
      await expect(leg.placeMakerAsk('ALEO', 1, 1)).rejects.toThrow();
    });
    it('pollOrder는 throw', async () => {
      await expect(leg.pollOrder('order-1')).rejects.toThrow();
    });
    it('cancelOrder는 throw', async () => {
      await expect(leg.cancelOrder('order-1')).rejects.toThrow();
    });
  });
});
