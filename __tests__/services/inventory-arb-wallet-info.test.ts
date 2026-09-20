import { summarizeCoinWallet } from '../../src/services/inventory-arb/wallet-info';
import type { NetworkStatus } from '../../src/services/multi-arb-types';

const net = (network: string, dep: boolean, wd: boolean, fee?: number): NetworkStatus => ({
  network, depositEnabled: dep, withdrawEnabled: wd, withdrawFee: fee,
});

describe('summarizeCoinWallet', () => {
  it('데이터 없으면 known=false', () => {
    expect(summarizeCoinWallet(undefined)).toEqual({ known: false, deposit: false, withdraw: false });
    expect(summarizeCoinWallet([])).toEqual({ known: false, deposit: false, withdraw: false });
  });

  it('입출금 가능 + 최소 출금 수수료', () => {
    const r = summarizeCoinWallet([net('ETH', true, true, 0.005), net('BSC', true, true, 0.001)]);
    expect(r).toEqual({ known: true, deposit: true, withdraw: true, withdrawFeeMin: 0.001 });
  });

  it('출금 전면 중단 → withdraw=false, 수수료 없음', () => {
    const r = summarizeCoinWallet([net('ETH', true, false, 0.005)]);
    expect(r.known).toBe(true);
    expect(r.deposit).toBe(true);
    expect(r.withdraw).toBe(false);
    expect(r.withdrawFeeMin).toBeUndefined();
  });

  it('출금 가능 네트워크의 수수료만 최소 계산 (막힌 네트워크 제외)', () => {
    const r = summarizeCoinWallet([net('ETH', true, false, 0.001), net('TRX', true, true, 0.01)]);
    expect(r.withdraw).toBe(true);
    expect(r.withdrawFeeMin).toBe(0.01); // 출금 막힌 ETH의 0.001은 제외
  });
});
