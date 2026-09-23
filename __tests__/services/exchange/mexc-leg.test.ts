// MexcLeg 단위 테스트
// 이식 원본: listing-auto-trader.service.ts buyOnMexc, listing-auto-seller.service.ts sellOnMexc/getMexcCoinBalance
// 값 단위는 USDT (ExchangeLeg의 grossKrw/feeKrw 필드는 레거시 라벨 — USDT 값을 채운다)
import axios from 'axios';
import { MexcLeg } from '../../../src/services/exchange/mexc-leg';
import { mexcPost, signedGet } from '../../../src/services/exchange/exchange-signer';

jest.mock('../../../src/services/exchange/exchange-signer', () => ({
  ...jest.requireActual('../../../src/services/exchange/exchange-signer'),
  mexcPost: jest.fn(),
  signedGet: jest.fn(),
}));

// cancelOrderQuiet(미체결 주문 취소)가 axios.delete를 직접 호출 — 실네트워크 호출 방지
jest.mock('axios');

const mockedMexcPost = mexcPost as jest.Mock;
const mockedSignedGet = signedGet as jest.Mock;
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('MexcLeg', () => {
  const creds = { apiKey: 'test-api-key', secretKey: 'test-secret-key' };
  let leg: MexcLeg;

  beforeEach(() => {
    jest.clearAllMocks();
    mockedAxios.delete.mockResolvedValue({ data: {} });
    leg = new MexcLeg(creds);
  });

  describe('sellIoc', () => {
    it('MARKET SELL 즉시 응답(fills 포함) → filledQty/grossKrw(USDT)/feeKrw(USDT) 반환', async () => {
      // 실잔고 조회(getBalance 내부 signedGet) → 500 이상 보유
      mockedSignedGet.mockResolvedValueOnce({
        balances: [{ asset: 'ALEO', free: '500' }],
      });
      // 매도 주문 응답 — 즉시 fills 포함
      mockedMexcPost.mockResolvedValueOnce({
        orderId: 'mexc-order-1',
        executedQty: '500',
        cummulativeQuoteQty: '9.2',
        fills: [{ commission: '0.0092', commissionAsset: 'USDT' }],
      });

      const result = await leg.sellIoc('ALEO', 500);

      expect(result).not.toBeNull();
      expect(result!.filledQty).toBe(500);
      expect(result!.grossKrw).toBe(9.2);
      expect(result!.feeKrw).toBeCloseTo(0.0092);

      // MARKET SELL 파라미터 확인 (side/type/symbol/quantity)
      expect(mockedMexcPost).toHaveBeenCalledWith(
        creds.apiKey,
        creds.secretKey,
        '/api/v3/order',
        expect.objectContaining({
          symbol: 'ALEOUSDT',
          side: 'SELL',
          type: 'MARKET',
          quantity: '500',
        }),
      );
    });

    it('실잔고가 요청 수량보다 적으면 실잔고로 보정 후 주문', async () => {
      mockedSignedGet.mockResolvedValueOnce({
        balances: [{ asset: 'ALEO', free: '499.99999999' }],
      });
      mockedMexcPost.mockResolvedValueOnce({
        orderId: 'mexc-order-2',
        executedQty: '499.99999999',
        cummulativeQuoteQty: '9.19',
        fills: [{ commission: '0.00919', commissionAsset: 'USDT' }],
      });

      await leg.sellIoc('ALEO', 500);

      const callParams = mockedMexcPost.mock.calls[0][3];
      // 8자리 반올림된 실잔고 수량으로 주문했는지 (500이 아니라 보정된 값)
      expect(parseFloat(callParams.quantity)).toBeLessThanOrEqual(499.99999999);
    });

    it('fills 없이 폴링 경로로 체결 확인 시 — cummulativeQuoteQty 사용, feeKrw=0', async () => {
      mockedSignedGet
        .mockResolvedValueOnce({ balances: [{ asset: 'ALEO', free: '500' }] }) // getBalance
        .mockResolvedValueOnce({ status: 'FILLED', executedQty: '500', cummulativeQuoteQty: '9.2' }); // poll

      mockedMexcPost.mockResolvedValueOnce({
        orderId: 'mexc-order-3',
        executedQty: '0', // 즉시 응답에 체결 정보 없음
        cummulativeQuoteQty: '0',
      });

      const result = await leg.sellIoc('ALEO', 500);

      expect(result).not.toBeNull();
      expect(result!.filledQty).toBe(500);
      expect(result!.grossKrw).toBe(9.2);
      expect(result!.feeKrw).toBe(0); // fills 정보 없음 — commission 확인 불가
    });

    it('미체결(executedQty=0, 폴링해도 0)이면 null 반환', async () => {
      mockedSignedGet
        .mockResolvedValueOnce({ balances: [{ asset: 'ALEO', free: '500' }] }) // getBalance
        .mockResolvedValueOnce({ status: 'CANCELED', executedQty: '0', cummulativeQuoteQty: '0' }); // poll

      mockedMexcPost.mockResolvedValueOnce({
        orderId: 'mexc-order-4',
        executedQty: '0',
        cummulativeQuoteQty: '0',
      });

      const result = await leg.sellIoc('ALEO', 500);
      expect(result).toBeNull();
    });

    it('실잔고 0이면 매도 시도 없이 null 반환', async () => {
      mockedSignedGet.mockResolvedValueOnce({ balances: [{ asset: 'ALEO', free: '0' }] });

      const result = await leg.sellIoc('ALEO', 500);
      expect(result).toBeNull();
      expect(mockedMexcPost).not.toHaveBeenCalled();
    });

    it('잔고조회 실패(네트워크 블립)는 흡수하고 요청 수량 그대로 매도 시도한다 (getMexcCoinBalance 원본 catch→null 동작)', async () => {
      mockedSignedGet.mockRejectedValueOnce(new Error('account lookup timeout'));
      mockedMexcPost.mockResolvedValueOnce({
        orderId: 'mexc-order-5',
        executedQty: '500',
        cummulativeQuoteQty: '9.2',
        fills: [{ commission: '0.0092', commissionAsset: 'USDT' }],
      });

      const result = await leg.sellIoc('ALEO', 500);

      expect(result).not.toBeNull();
      expect(result!.filledQty).toBe(500);
      const callParams = mockedMexcPost.mock.calls[0][3];
      expect(callParams.quantity).toBe('500'); // 잔고 보정 없이 요청 수량 그대로
    });

    it('네트워크 오류 등은 throw 한다 (미체결과 구분)', async () => {
      mockedSignedGet.mockResolvedValueOnce({ balances: [{ asset: 'ALEO', free: '500' }] });
      mockedMexcPost.mockRejectedValueOnce(new Error('MEXC timeout'));

      await expect(leg.sellIoc('ALEO', 500)).rejects.toThrow('MEXC timeout');
    });
  });

  describe('buyIoc', () => {
    it('MARKET BUY(quoteOrderQty) 즉시 응답(fills, 코인차감 수수료) → filledQty=수취코인(수수료차감), grossKrw=지출USDT', async () => {
      mockedMexcPost.mockResolvedValueOnce({
        orderId: 'mexc-buy-1',
        executedQty: '500',
        cummulativeQuoteQty: '9.2',
        fills: [{ commission: '0.5', commissionAsset: 'ALEO' }], // 매수 수수료 코인 차감
      });

      const result = await leg.buyIoc('ALEO', 500, 0.0184);

      expect(result).not.toBeNull();
      // 실수취 코인 = executedQty(500) - commission(0.5, ALEO) = 499.5
      expect(result!.filledQty).toBeCloseTo(499.5);
      expect(result!.grossKrw).toBe(9.2);
      // commissionAsset=코인 → feeKrw는 체결단가 환산 (avgPrice = 9.2/500 = 0.0184) × 0.5
      expect(result!.feeKrw).toBeCloseTo(0.5 * (9.2 / 500));

      expect(mockedMexcPost).toHaveBeenCalledWith(
        creds.apiKey,
        creds.secretKey,
        '/api/v3/order',
        expect.objectContaining({
          symbol: 'ALEOUSDT',
          side: 'BUY',
          type: 'MARKET',
          quoteOrderQty: expect.any(String),
        }),
      );
    });

    it('commissionAsset=USDT면 feeKrw는 그대로(USDT 환산 불필요), filledQty=executedQty 그대로', async () => {
      mockedMexcPost.mockResolvedValueOnce({
        orderId: 'mexc-buy-2',
        executedQty: '500',
        cummulativeQuoteQty: '9.2',
        fills: [{ commission: '0.0092', commissionAsset: 'USDT' }],
      });

      const result = await leg.buyIoc('ALEO', 500, 0.0184);

      expect(result).not.toBeNull();
      expect(result!.filledQty).toBe(500); // 코인 차감 없음
      expect(result!.feeKrw).toBeCloseTo(0.0092);
    });

    it('quoteOrderQty 매수 직후 executedQty=0(즉시 응답) → 폴링으로 체결 확인, fills 없으므로 feeKrw=0', async () => {
      mockedMexcPost.mockResolvedValueOnce({
        orderId: 'mexc-buy-3',
        executedQty: '0',
        cummulativeQuoteQty: '0',
      });
      mockedSignedGet.mockResolvedValueOnce({
        status: 'FILLED',
        executedQty: '500',
        cummulativeQuoteQty: '9.2',
      });

      const result = await leg.buyIoc('ALEO', 500, 0.0184);

      expect(result).not.toBeNull();
      expect(result!.filledQty).toBe(500);
      expect(result!.grossKrw).toBe(9.2);
      expect(result!.feeKrw).toBe(0);
    });

    it('maxQuoteBudget 지정 시 예산 상한 적용', async () => {
      mockedMexcPost.mockResolvedValueOnce({
        orderId: 'mexc-buy-4',
        executedQty: '100',
        cummulativeQuoteQty: '1.84',
        fills: [{ commission: '0.00184', commissionAsset: 'USDT' }],
      });

      await leg.buyIoc('ALEO', 500, 0.0184, 2); // qty*priceHint=9.2 > budget 2 → budget 2 사용

      const callParams = mockedMexcPost.mock.calls[0][3];
      expect(parseFloat(callParams.quoteOrderQty)).toBeLessThanOrEqual(2);
    });

    it('미체결(폴링해도 executedQty=0)이면 null 반환', async () => {
      mockedMexcPost.mockResolvedValueOnce({
        orderId: 'mexc-buy-5',
        executedQty: '0',
        cummulativeQuoteQty: '0',
      });
      mockedSignedGet.mockResolvedValueOnce({
        status: 'CANCELED',
        executedQty: '0',
        cummulativeQuoteQty: '0',
      });

      const result = await leg.buyIoc('ALEO', 500, 0.0184);
      expect(result).toBeNull();
    });

    it('네트워크 오류 등은 throw 한다', async () => {
      mockedMexcPost.mockRejectedValueOnce(new Error('MEXC network error'));

      await expect(leg.buyIoc('ALEO', 500, 0.0184)).rejects.toThrow('MEXC network error');
    });
  });

  describe('getBalance', () => {
    it('/api/v3/account 에서 free 잔고를 반환한다', async () => {
      mockedSignedGet.mockResolvedValueOnce({
        balances: [
          { asset: 'ALEO', free: '123.45' },
          { asset: 'USDT', free: '67.89' },
        ],
      });

      const balance = await leg.getBalance('USDT');
      expect(balance).toBeCloseTo(67.89);
    });

    it('자산이 없으면 0을 반환한다', async () => {
      mockedSignedGet.mockResolvedValueOnce({ balances: [] });
      const balance = await leg.getBalance('ALEO');
      expect(balance).toBe(0);
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
