// Task 3: UpbitClient unit tests
// 통합 테스트(실제 Upbit API 호출)는 Task 18에서 진행. 여기서는 어댑터 + mapStatus + calcAvgPrice 단위 검증.

import { UpbitClient } from '../../../src/services/exchange/upbit-client';

// UpbitService 의 모든 인스턴스 메서드를 stub 가능하도록 mock
jest.mock('../../../src/services/upbit.service', () => ({
  UpbitService: jest.fn().mockImplementation(() => ({
    getAccounts: jest.fn(),
    getOrder: jest.fn(),
    placeBestIoc: jest.fn(),
  })),
}));

describe('UpbitClient', () => {
  const creds = { accessKey: 'k', secretKey: 's' };

  it('exchangeName 이 upbit 이다', () => {
    const c = new UpbitClient(creds);
    expect(c.exchangeName).toBe('upbit');
  });

  describe('mapStatus (via getOrder)', () => {
    function makeClientWithOrderResp(resp: any) {
      const c = new UpbitClient(creds);
      // service 의 getOrder 가 resp 반환하도록 override
      (c as any).service.getOrder = jest.fn().mockResolvedValue(resp);
      return c;
    }

    it('done → filled', async () => {
      const c = makeClientWithOrderResp({ state: 'done', executed_volume: '10', paid_fee: '0' });
      const r = await c.getOrder('uuid1');
      expect(r.status).toBe('filled');
    });

    it('wait → pending', async () => {
      const c = makeClientWithOrderResp({ state: 'wait', executed_volume: '0', paid_fee: '0' });
      const r = await c.getOrder('uuid1');
      expect(r.status).toBe('pending');
    });

    it('cancel + executed_volume > 0 → partial (IOC 부분체결)', async () => {
      const c = makeClientWithOrderResp({ state: 'cancel', executed_volume: '5', paid_fee: '0' });
      const r = await c.getOrder('uuid1');
      expect(r.status).toBe('partial');
    });

    it('cancel + executed_volume = 0 → cancelled', async () => {
      const c = makeClientWithOrderResp({ state: 'cancel', executed_volume: '0', paid_fee: '0' });
      const r = await c.getOrder('uuid1');
      expect(r.status).toBe('cancelled');
    });

    it('unknown state → failed', async () => {
      const c = makeClientWithOrderResp({ state: 'unknown', executed_volume: '0', paid_fee: '0' });
      const r = await c.getOrder('uuid1');
      expect(r.status).toBe('failed');
    });
  });

  describe('calcAvgPrice (via getOrder)', () => {
    function makeClientWithOrderResp(resp: any) {
      const c = new UpbitClient(creds);
      (c as any).service.getOrder = jest.fn().mockResolvedValue(resp);
      return c;
    }

    it('executed_funds 우선: funds=10000, volume=10 → 1000', async () => {
      const c = makeClientWithOrderResp({
        state: 'done', executed_volume: '10', executed_funds: '10000', paid_fee: '0',
      });
      const r = await c.getOrder('uuid');
      expect(r.avgFillPrice).toBe(1000);
    });

    it('trades fallback: funds 합 = 10000, volume = 10 → 1000', async () => {
      const c = makeClientWithOrderResp({
        state: 'done', executed_volume: '10', paid_fee: '0',
        trades: [{ funds: '5000' }, { funds: '5000' }],
      });
      const r = await c.getOrder('uuid');
      expect(r.avgFillPrice).toBe(1000);
    });

    it('executed_volume = 0 → 0 (no divide by zero)', async () => {
      const c = makeClientWithOrderResp({ state: 'wait', executed_volume: '0', paid_fee: '0' });
      const r = await c.getOrder('uuid');
      expect(r.avgFillPrice).toBe(0);
    });

    it('executed_funds=0 + trades 비어있음 → 0', async () => {
      const c = makeClientWithOrderResp({ state: 'cancel', executed_volume: '0', paid_fee: '0' });
      const r = await c.getOrder('uuid');
      expect(r.avgFillPrice).toBe(0);
    });
  });
});
