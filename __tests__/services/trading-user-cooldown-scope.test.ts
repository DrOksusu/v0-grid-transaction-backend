import { TradingService } from '../../src/services/trading.service';

describe('유저 잔고 쿨다운 거래소군 스코프', () => {
  it('mexc 쿨다운은 upbit/bithumb(krw)에 영향 없음', () => {
    TradingService.setUserBalanceCooldown(101, 'mexc');
    expect(TradingService.isUserOnBalanceCooldown(101, 'mexc')).toBe(true);
    expect(TradingService.isUserOnBalanceCooldown(101, 'upbit')).toBe(false);
    expect(TradingService.isUserOnBalanceCooldown(101, 'bithumb')).toBe(false);
  });

  it('upbit 쿨다운은 bithumb와 공유, mexc에는 영향 없음', () => {
    TradingService.setUserBalanceCooldown(102, 'upbit');
    expect(TradingService.isUserOnBalanceCooldown(102, 'upbit')).toBe(true);
    expect(TradingService.isUserOnBalanceCooldown(102, 'bithumb')).toBe(true);
    expect(TradingService.isUserOnBalanceCooldown(102, 'mexc')).toBe(false);
  });
});
