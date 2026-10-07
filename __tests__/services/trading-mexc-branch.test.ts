import { getFeeRate, resolveGridClient } from '../../src/services/trading.service';
import { MexcGridClient } from '../../src/services/exchange/mexc-grid-client';
import { BithumbClient } from '../../src/services/exchange/bithumb-client';
import { UpbitService } from '../../src/services/upbit.service';

describe('trading.service mexc 분기', () => {
  const cred = { apiKey: 'k', secretKey: 's' };
  it('getFeeRate: mexc 기본 0.0005, bithumb 0.0004, upbit 0.0005', () => {
    expect(getFeeRate('mexc')).toBeCloseTo(0.0005, 6);
    expect(getFeeRate('bithumb')).toBeCloseTo(0.0004, 6);
    expect(getFeeRate('upbit')).toBeCloseTo(0.0005, 6);
  });
  it('resolveGridClient: 거래소별 올바른 클라이언트', () => {
    expect(resolveGridClient('mexc', cred)).toBeInstanceOf(MexcGridClient);
    expect(resolveGridClient('bithumb', cred)).toBeInstanceOf(BithumbClient);
    expect(resolveGridClient('upbit', cred)).toBeInstanceOf(UpbitService);
  });
});

import { checkMexcUsdtBalance } from '../../src/services/trading.service';

describe('MEXC start pre-flight', () => {
  afterEach(() => jest.restoreAllMocks());
  it('USDT 가용 < 투입금이면 ok:false', async () => {
    jest.spyOn(MexcGridClient.prototype, 'getUsdtBalance').mockResolvedValue(10);
    const r = await checkMexcUsdtBalance({ apiKey: 'k', secretKey: 's' }, 50);
    expect(r.ok).toBe(false);
    expect(r.available).toBe(10);
  });
  it('USDT 가용 ≥ 투입금이면 ok:true', async () => {
    jest.spyOn(MexcGridClient.prototype, 'getUsdtBalance').mockResolvedValue(100);
    const r = await checkMexcUsdtBalance({ apiKey: 'k', secretKey: 's' }, 50);
    expect(r.ok).toBe(true);
  });
});
