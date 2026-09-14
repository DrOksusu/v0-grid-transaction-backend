// 실현가능성 3단 필터 (spec §6)
// 1단: 매수·매도 거래소의 지원 네트워크 교집합 존재 여부 → 없으면 network_mismatch (⛔ 전송불가)
// 2단: 교집합 네트워크 중 "매수측 출금 가능 ∧ 매도측 입금 가능"이 하나라도 있는가 → 없으면 deposit_halt
// 3단: 상폐/거래중지 공지 경고(notice_warning)는 후속 과제 (spec §10 — 초기 구현에서는 2단 입출금 상태로 대체)
// 순수함수 — 외부 I/O 없음
import { FeasibilityResult, MultiArbExchange, NetworkStatus, SpreadCandidate, WalletStatusMap, EXCHANGE_LABELS } from './multi-arb-types';

export function evaluateFeasibility(
  candidate: SpreadCandidate,
  wallets: Partial<Record<MultiArbExchange, WalletStatusMap>>,
): FeasibilityResult {
  const buyNets = wallets[candidate.buyExchange]?.get(candidate.symbol);
  const sellNets = wallets[candidate.sellExchange]?.get(candidate.symbol);

  // 지갑 정보가 없으면 판정 불가 (지갑 조회 실패 or 상장만 되고 지갑 미지원)
  if (!buyNets || buyNets.length === 0 || !sellNets || sellNets.length === 0) {
    return {
      feasibility: 'unverified',
      networkMatch: null,
      matchedNetwork: null,
      note: '지갑/네트워크 정보 없음 — 실현가능성 미검증',
    };
  }

  // 1단: 네트워크 교집합
  const sellByNetwork = new Map<string, NetworkStatus>(sellNets.map(n => [n.network, n]));
  const commonNetworks = buyNets.filter(n => sellByNetwork.has(n.network));

  if (commonNetworks.length === 0) {
    const buyLabel = `${EXCHANGE_LABELS[candidate.buyExchange]} ${buyNets.map(n => n.network).join('/')}망`;
    const sellLabel = `${EXCHANGE_LABELS[candidate.sellExchange]} ${sellNets.map(n => n.network).join('/')}망`;
    return {
      feasibility: 'network_mismatch',
      networkMatch: false,
      matchedNetwork: null,
      note: `전송불가: 네트워크 불일치(${buyLabel} ↔ ${sellLabel})`,
    };
  }

  // 2단: 교집합 네트워크 중 매수측 출금 가능 ∧ 매도측 입금 가능
  const transferable = commonNetworks.find(
    buyNet => buyNet.withdrawEnabled && sellByNetwork.get(buyNet.network)!.depositEnabled,
  );

  if (!transferable) {
    return {
      feasibility: 'deposit_halt',
      networkMatch: true,
      matchedNetwork: commonNetworks[0].network,
      note: `입출금 중단: ${commonNetworks.map(n => n.network).join('/')}망에서 매수측 출금 또는 매도측 입금 불가`,
    };
  }

  // 3단(공지 경고)은 후속 과제 (spec §10) — 여기 도달하면 feasible
  return {
    feasibility: 'feasible',
    networkMatch: true,
    matchedNetwork: transferable.network,
    note: `네트워크 일치(${transferable.network}) · 양쪽 입출금 정상`,
  };
}
