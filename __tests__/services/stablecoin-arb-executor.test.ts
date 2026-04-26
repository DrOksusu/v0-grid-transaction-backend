import {
  executeArbitrage,
  type IocClient,
  type UpbitOrderResp,
} from '../../src/services/stablecoin-arb-executor';
import type { ArbOpportunity } from '../../src/services/stablecoin-arb-detector';
import type { OrderbookTop } from '../../src/services/upbit-price-manager';

const baseBot = { id: 1, tradeSizeKrw: 10000 };

const baseOpp: ArbOpportunity = {
  soldCoin: 'USDT',
  boughtCoin: 'USDC',
  bidSoldKrw: 1486,
  askBoughtKrw: 1485,
  bidSoldSize: 100,
  askBoughtSize: 100,
  spreadBps: 6,
  detectedAt: Date.now(),
};

const baseBalance: Record<string, number> = { USDT: 100, USDC: 50, USD1: 30 };

const baseBooks = new Map<string, OrderbookTop>([
  ['KRW-USDT', { market: 'KRW-USDT', bid: { price: 1486, size: 100 }, ask: { price: 1487, size: 100 }, timestamp: 0 }],
  ['KRW-USDC', { market: 'KRW-USDC', bid: { price: 1485, size: 100 }, ask: { price: 1486, size: 100 }, timestamp: 0 }],
]);

interface MockIocClient extends IocClient {
  placeBestIoc: jest.Mock<Promise<UpbitOrderResp>, [string, 'bid' | 'ask', { price?: string; volume?: string }]>;
}

const makeUpbit = (): MockIocClient =>
  ({ placeBestIoc: jest.fn() } as unknown as MockIocClient);

describe('executeArbitrage', () => {
  it('정상 흐름: leg-1 + leg-2 모두 체결 → ok', async () => {
    const upbit = makeUpbit();
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l1', state: 'done', executed_volume: '6.73',
      trades: [{ funds: '10000' }], paid_fee: '5',
    });
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l2', state: 'cancel', executed_volume: '6.7300',
      trades: [{ funds: '9995' }], paid_fee: '5',
    });

    const result = await executeArbitrage(baseOpp, baseBot, baseBalance, baseBooks, upbit);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.legA.uuid).toBe('l1');
      expect(result.legB.uuid).toBe('l2');
      expect(result.totalFeeKrw).toBe(10);
      expect(typeof result.markToMarketNet).toBe('number');
      expect(typeof result.krwFlowNet).toBe('number');
    }
  });

  it('leg-1 zero fill → FAILED, leg-2 호출 안 됨', async () => {
    const upbit = makeUpbit();
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l1', state: 'cancel', executed_volume: '0',
      trades: [], paid_fee: '0',
    });

    const result = await executeArbitrage(baseOpp, baseBot, baseBalance, baseBooks, upbit);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/leg-1 zero/);
    }
    expect(upbit.placeBestIoc).toHaveBeenCalledTimes(1);
  });

  it('leg-2 zero → fallback (받은 KRW로 X 재매수), rolledBack=true', async () => {
    const upbit = makeUpbit();
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l1', state: 'done', executed_volume: '6.73',
      trades: [{ funds: '10000' }], paid_fee: '5',
    });
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l2', state: 'cancel', executed_volume: '0',
      trades: [], paid_fee: '0',
    });
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'fb', state: 'cancel', executed_volume: '6.7',
      trades: [{ funds: '9990' }], paid_fee: '5',
    });

    const result = await executeArbitrage(baseOpp, baseBot, baseBalance, baseBooks, upbit);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/leg-2/);
      expect(result.rolledBack).toBe(true);
    }
    expect(upbit.placeBestIoc).toHaveBeenCalledTimes(3);
    // fallback이 KRW-USDT(원래 X) buy로 호출됐는지
    const fbCall = upbit.placeBestIoc.mock.calls[2];
    expect(fbCall[0]).toBe('KRW-USDT');
    expect(fbCall[1]).toBe('bid');
  });

  it('부분 체결: leg-2 buyKrw = leg-1 받은 KRW - 수수료', async () => {
    const upbit = makeUpbit();
    // leg-1: 50% 체결 (3.36 USDT, 4995 KRW)
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l1', state: 'cancel', executed_volume: '3.36',
      trades: [{ funds: '4995' }], paid_fee: '2.5',
    });
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l2', state: 'cancel', executed_volume: '3.36',
      trades: [{ funds: '4990' }], paid_fee: '2.5',
    });

    const result = await executeArbitrage(baseOpp, baseBot, baseBalance, baseBooks, upbit);
    expect(result.ok).toBe(true);
    // leg-2 호출 시 buyKrw = 4995 - 2.5 = 4992.5
    const leg2Call = upbit.placeBestIoc.mock.calls[1];
    expect(leg2Call[1]).toBe('bid');
    expect(parseFloat(leg2Call[2].price ?? '0')).toBeCloseTo(4992.5, 0);
  });

  it('수수료 파싱: paid_fee 누락 시 0 fallback', async () => {
    const upbit = makeUpbit();
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l1', state: 'done', executed_volume: '6.73',
      trades: [{ funds: '10000' }],
      // paid_fee 누락
    } as UpbitOrderResp);
    upbit.placeBestIoc.mockResolvedValueOnce({
      uuid: 'l2', state: 'cancel', executed_volume: '6.73',
      trades: [{ funds: '10000' }],
    } as UpbitOrderResp);

    const result = await executeArbitrage(baseOpp, baseBot, baseBalance, baseBooks, upbit);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.totalFeeKrw).toBe(0);
    }
  });
});
