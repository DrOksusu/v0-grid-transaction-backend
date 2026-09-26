// USDT권 leg(Gate/MEXC/Binance) 지정가 IOC(가격 보호) — 주문 요청 형식·정밀도 절사·체결 파싱 검증
// (2026-09-25 ALEO 슬리피지 손실 재발 방지: 시장가 → 지정가 IOC 전환의 leg 레이어)
import axios from 'axios';
import { gateioRequest, mexcPost, signedPost, signedGet } from '../../../src/services/exchange/exchange-signer';
import { GateLeg } from '../../../src/services/exchange/gate-leg';
import { MexcLeg } from '../../../src/services/exchange/mexc-leg';
import { BinanceLeg } from '../../../src/services/exchange/binance-leg';

jest.mock('axios', () => ({ get: jest.fn(), delete: jest.fn() }));
jest.mock('../../../src/services/exchange/exchange-signer', () => ({
  BINANCE: { baseUrl: 'https://api.binance.com', apiKeyHeader: 'X-MBX-APIKEY', paramsInBody: true },
  MEXC: { baseUrl: 'https://api.mexc.com', apiKeyHeader: 'X-MEXC-APIKEY', paramsInBody: false },
  hmacSign: jest.fn().mockReturnValue('sig'),
  signedGet: jest.fn(),
  signedPost: jest.fn(),
  gateioRequest: jest.fn(),
  mexcPost: jest.fn(),
}));

const CREDS = { apiKey: 'k', secretKey: 's' };

beforeEach(() => jest.clearAllMocks());

describe('GateLeg limit IOC', () => {
  it('buyLimitIoc: type=limit + time_in_force=ioc + 가격/수량 정밀도 절사(내림)', async () => {
    // currency_pairs 정밀도: 수량 0자리(정수), 가격 5자리
    (axios.get as jest.Mock).mockResolvedValue({ data: { amount_precision: 0, precision: 5 } });
    (gateioRequest as jest.Mock).mockResolvedValue({
      id: '1', filled_amount: '350', avg_deal_price: '0.0286', filled_total: '10.01', fee: '0', fee_currency: '',
    });
    const leg = new GateLeg(CREDS);
    const r = await leg.buyLimitIoc('ALEO', 350.9, 0.02858551);
    expect(r).not.toBeNull();
    const body = JSON.parse((gateioRequest as jest.Mock).mock.calls[0][5]);
    expect(body).toEqual({
      currency_pair: 'ALEO_USDT',
      type: 'limit',
      side: 'buy',
      amount: '350',        // 350.9 → 정수 절사
      price: '0.02858',     // 5자리 내림 절사 (보호 강화 방향)
      time_in_force: 'ioc',
    });
    expect(r!.filledQty).toBe(350);
    expect(r!.grossKrw).toBeCloseTo(10.01, 6);
  });

  it('buyLimitIoc: fee-in-coin이면 실수취량 차감 + feeUsdt 환산 (buyIoc와 동일 규칙)', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { amount_precision: 0, precision: 5 } });
    (gateioRequest as jest.Mock).mockResolvedValue({
      id: '1', filled_amount: '350', avg_deal_price: '0.0286', filled_total: '10.01', fee: '0.35', fee_currency: 'ALEO',
    });
    const leg = new GateLeg(CREDS);
    const r = await leg.buyLimitIoc('ALEO', 350, 0.0286);
    expect(r!.filledQty).toBeCloseTo(349.65, 6);
    expect(r!.feeKrw).toBeCloseTo(0.35 * 0.0286, 8);
  });

  it('sellLimitIoc: 실잔고 min 보정 + limit/ioc 주문 + 미체결이면 null', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { amount_precision: 0, precision: 5 } });
    const leg = new GateLeg(CREDS);
    (gateioRequest as jest.Mock).mockImplementation(async (_k, _s, method, path) => {
      if (method === 'GET' && path === '/api/v4/spot/accounts') return [{ available: '300' }]; // 잔고 300 < 요청 350
      if (method === 'POST') return { id: '2', amount: '300', left: '300', filled_amount: '0', avg_deal_price: '0', filled_total: '0' };
      if (method === 'GET') return { filled_amount: '0', avg_deal_price: '0', filled_total: '0' }; // 폴링도 미체결
      return {};
    });
    const r = await leg.sellLimitIoc('ALEO', 350, 0.0291234);
    expect(r).toBeNull(); // 가격 이탈 미체결 → 무손실 스킵
    const postCall = (gateioRequest as jest.Mock).mock.calls.find((c) => c[2] === 'POST');
    const body = JSON.parse(postCall[5]);
    expect(body.side).toBe('sell');
    expect(body.type).toBe('limit');
    expect(body.time_in_force).toBe('ioc');
    expect(body.amount).toBe('300');   // 실잔고로 캡
    expect(body.price).toBe('0.02912'); // 5자리 절사
  }, 15000);
});

describe('MexcLeg limit IOC', () => {
  it('buyLimitIoc: type=IMMEDIATE_OR_CANCEL + quantity/price 전달, quotePrecision 절사', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { symbols: [{ quotePrecision: 4 }] } });
    (mexcPost as jest.Mock).mockResolvedValue({
      orderId: '10', executedQty: '350', cummulativeQuoteQty: '10.02',
      fills: [{ commission: '0', commissionAsset: 'USDT' }],
    });
    const leg = new MexcLeg(CREDS);
    const r = await leg.buyLimitIoc('ALEO', 350, 0.028585);
    expect(r).not.toBeNull();
    const params = (mexcPost as jest.Mock).mock.calls[0][3];
    expect(params).toEqual({
      symbol: 'ALEOUSDT',
      side: 'BUY',
      type: 'IMMEDIATE_OR_CANCEL',
      quantity: '350',
      price: '0.0285', // 4자리 내림 절사
    });
    expect(r!.filledQty).toBe(350);
  });

  it('sellLimitIoc: 실잔고 min 보정 + IMMEDIATE_OR_CANCEL SELL', async () => {
    (axios.get as jest.Mock).mockResolvedValue({ data: { symbols: [{ quotePrecision: 4 }] } });
    (signedGet as jest.Mock).mockResolvedValue({ balances: [{ asset: 'ALEO', free: '340' }] });
    (mexcPost as jest.Mock).mockResolvedValue({
      orderId: '11', executedQty: '340', cummulativeQuoteQty: '9.8',
      fills: [{ commission: '0.0098', commissionAsset: 'USDT' }],
    });
    const leg = new MexcLeg(CREDS);
    const r = await leg.sellLimitIoc('ALEO', 350, 0.0289);
    expect(r).not.toBeNull();
    const params = (mexcPost as jest.Mock).mock.calls[0][3];
    expect(params.side).toBe('SELL');
    expect(params.type).toBe('IMMEDIATE_OR_CANCEL');
    expect(params.quantity).toBe('340'); // 실잔고 캡
    expect(params.price).toBe('0.0289');
    expect(r!.feeKrw).toBeCloseTo(0.0098, 8);
  });
});

describe('BinanceLeg limit IOC', () => {
  const EXCHANGE_INFO = {
    data: {
      symbols: [{
        filters: [
          { filterType: 'LOT_SIZE', stepSize: '0.001' },
          { filterType: 'PRICE_FILTER', tickSize: '0.001' },
        ],
      }],
    },
  };

  it('buyLimitIoc: type=LIMIT + timeInForce=IOC + step/tick 절사', async () => {
    (axios.get as jest.Mock).mockResolvedValue(EXCHANGE_INFO);
    (signedPost as jest.Mock).mockResolvedValue({
      orderId: '20', executedQty: '13', cummulativeQuoteQty: '58.2',
      fills: [{ commission: '0', commissionAsset: 'USDT' }],
    });
    const leg = new BinanceLeg(CREDS);
    const r = await leg.buyLimitIoc('EGLD', 13.0004, 4.4894567);
    expect(r).not.toBeNull();
    const params = (signedPost as jest.Mock).mock.calls[0][5];
    expect(params).toEqual({
      symbol: 'EGLDUSDT',
      side: 'BUY',
      type: 'LIMIT',
      timeInForce: 'IOC',
      quantity: '13.000', // stepSize 0.001 절사
      price: '4.489',     // tickSize 0.001 절사
    });
  });

  it('sellLimitIoc: 실잔고 min 보정 + LIMIT/IOC SELL, 미체결이면 null', async () => {
    (axios.get as jest.Mock).mockResolvedValue(EXCHANGE_INFO);
    (signedGet as jest.Mock).mockImplementation(async (_b, _h, _k, _s, path) => {
      if (path === '/api/v3/account') return { balances: [{ asset: 'EGLD', free: '12.5' }] };
      return { executedQty: '0', cummulativeQuoteQty: '0', status: 'EXPIRED' }; // 폴링 — IOC 만료
    });
    (signedPost as jest.Mock).mockResolvedValue({ orderId: '21', executedQty: '0', cummulativeQuoteQty: '0' });
    const leg = new BinanceLeg(CREDS);
    const r = await leg.sellLimitIoc('EGLD', 13, 4.6001234);
    expect(r).toBeNull();
    const params = (signedPost as jest.Mock).mock.calls[0][5];
    expect(params.side).toBe('SELL');
    expect(params.type).toBe('LIMIT');
    expect(params.timeInForce).toBe('IOC');
    expect(params.quantity).toBe('12.500'); // 실잔고 캡 + step 절사
    expect(params.price).toBe('4.600');
  });
});
