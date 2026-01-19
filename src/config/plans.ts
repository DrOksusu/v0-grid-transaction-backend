/**
 * 구독 플랜 설정
 */

export type PlanType = 'free' | 'pro' | 'premium';
export type BotType = 'grid' | 'infiniteBuy' | 'vr';

// 플랜별 봇 제한
export const PLAN_LIMITS: Record<PlanType, Record<BotType, number>> = {
  free: {
    grid: 3,
    infiniteBuy: 2,
    vr: 1,
  },
  pro: {
    grid: Infinity,
    infiniteBuy: Infinity,
    vr: Infinity,
  },
  premium: {
    grid: Infinity,
    infiniteBuy: Infinity,
    vr: Infinity,
  },
};

// 플랜 가격 정보 (KRW)
export const PLAN_PRICES = {
  pro: {
    month: { amount: 9900, label: '월 9,900원' },
    year: { amount: 99000, label: '연 99,000원' },
  },
  premium: {
    month: { amount: 29900, label: '월 29,900원' },
    year: { amount: 299000, label: '연 299,000원' },
  },
} as const;

// 플랜 기능 목록
export const PLAN_FEATURES = {
  free: {
    name: 'Free',
    description: '무료 플랜',
    features: [
      '그리드 봇 3개',
      '무한매수 봇 2개',
      'VR 봇 1개',
      '실시간 가격 모니터링',
      '수익 랭킹',
      '고래 알림',
    ],
  },
  pro: {
    name: 'Pro',
    description: '프로 플랜 (월 10 USDT)',
    features: [
      '모든 봇 무제한',
      '모든 Free 기능',
      '고급 통계/리포트',
      '텔레그램/디스코드 알림',
      '우선 고객 지원',
    ],
  },
  premium: {
    name: 'Premium',
    description: '프리미엄 플랜',
    features: [
      '모든 봇 무제한',
      '모든 Pro 기능',
      'API 접근',
      '전용 고객 지원',
      '고급 분석 도구',
    ],
  },
} as const;

// 플랜 순서 (업그레이드 비교용)
export const PLAN_ORDER: Record<PlanType, number> = {
  free: 0,
  pro: 1,
  premium: 2,
};

// 플랜 업그레이드 가능 여부
export function canUpgrade(currentPlan: PlanType, targetPlan: PlanType): boolean {
  return PLAN_ORDER[targetPlan] > PLAN_ORDER[currentPlan];
}

// 플랜 다운그레이드 가능 여부
export function canDowngrade(currentPlan: PlanType, targetPlan: PlanType): boolean {
  return PLAN_ORDER[targetPlan] < PLAN_ORDER[currentPlan];
}
