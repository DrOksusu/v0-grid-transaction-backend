// 코인별 입출금 상태 요약 (재고형 아비 후보에 첨부).
// 큰 스프레드가 입출금 제한발인지 + 리밸런싱(전송) 가능·비용 판단용.
import type { NetworkStatus } from '../multi-arb-types';

export interface WalletInfo {
  known: boolean; // 지갑 상태 데이터 확보 여부 (false면 조회 실패/미지원)
  deposit: boolean; // 어떤 네트워크든 입금 가능
  withdraw: boolean; // 어떤 네트워크든 출금 가능
  withdrawFeeMin?: number; // 출금 가능 네트워크 중 최소 출금 수수료 (코인 단위, 제공되는 경우만)
}

/**
 * 순수: 한 코인의 네트워크 목록 → 입출금 요약.
 * @param networks WalletStatusMap.get(symbol) 결과 (없으면 데이터 미확보)
 */
export function summarizeCoinWallet(networks: NetworkStatus[] | undefined): WalletInfo {
  if (!networks || networks.length === 0) {
    return { known: false, deposit: false, withdraw: false };
  }
  const deposit = networks.some((n) => n.depositEnabled);
  const withdraw = networks.some((n) => n.withdrawEnabled);
  const fees = networks
    .filter((n) => n.withdrawEnabled && typeof n.withdrawFee === 'number')
    .map((n) => n.withdrawFee as number);
  const withdrawFeeMin = fees.length > 0 ? Math.min(...fees) : undefined;
  return { known: true, deposit, withdraw, withdrawFeeMin };
}
