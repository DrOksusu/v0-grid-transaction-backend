/**
 * Stablecoin Inventory Service
 *
 * 스테이블코인 잔고 조회, 재고 캐싱, 디페그 판정을 담당하는 독립 서비스.
 * 클래스 패턴이 아닌 함수형으로 구현 — 인메모리 캐시(Map)와 순수 함수를 혼용.
 */

import axios from 'axios';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';

const UPBIT_API_URL = 'https://api.upbit.com/v1';
const STABLECOINS = ['USDT', 'USDC', 'USDS', 'USD1', 'USDE'] as const;
export type Stablecoin = typeof STABLECOINS[number];

export interface InventorySnapshot {
  /** 각 코인 보유량 + "KRW" 잔고 */
  balances: Record<string, number>;
  /** 스냅샷 생성 시각 (ms) */
  timestamp: number;
}

/** 봇 단위 인메모리 캐시 (botId → 최신 스냅샷) */
const inventoryCache = new Map<number, InventorySnapshot>();

/**
 * Upbit 전체 잔고 조회 (모든 통화 포함)
 *
 * @param apiKey Upbit access key
 * @param secretKey Upbit secret key
 * @returns { "KRW": 10000, "USDT": 5.2, ... }
 */
export async function fetchAllBalances(
  apiKey: string,
  secretKey: string
): Promise<Record<string, number>> {
  const payload = {
    access_key: apiKey,
    nonce: uuidv4(),
  };
  const token = jwt.sign(payload, secretKey);

  const response = await axios.get(`${UPBIT_API_URL}/accounts`, {
    headers: { Authorization: `Bearer ${token}` },
    timeout: 10000,
  });

  const balances: Record<string, number> = {};
  for (const acc of response.data) {
    const total =
      parseFloat(acc.balance || '0') + parseFloat(acc.locked || '0');
    if (total > 0) {
      balances[acc.currency] = total;
    }
  }
  return balances;
}

/**
 * 봇 단위 재고 리콘실 + 캐시 갱신
 *
 * Upbit API를 호출하여 최신 잔고를 조회하고, botId 기준으로 캐시에 저장한다.
 */
export async function reconcileInventory(
  botId: number,
  apiKey: string,
  secretKey: string
): Promise<InventorySnapshot> {
  const raw = await fetchAllBalances(apiKey, secretKey);

  const balances: Record<string, number> = { KRW: raw['KRW'] || 0 };
  for (const coin of STABLECOINS) {
    balances[coin] = raw[coin] || 0;
  }

  const snapshot: InventorySnapshot = {
    balances,
    timestamp: Date.now(),
  };
  inventoryCache.set(botId, snapshot);
  return snapshot;
}

/**
 * 캐시된 재고 조회
 *
 * @param botId 봇 ID
 * @returns 캐시된 스냅샷 (없으면 undefined)
 */
export function getCachedInventory(
  botId: number
): InventorySnapshot | undefined {
  return inventoryCache.get(botId);
}

/**
 * Optimistic 재고 업데이트 (거래 직후 로컬만 갱신)
 *
 * 실제 API 호출 없이 delta를 적용하여 캐시를 즉시 갱신한다.
 * 불변성 유지: 기존 스냅샷을 변경하지 않고 새 객체를 생성.
 *
 * @param botId 봇 ID
 * @param delta { USDT: -10.5, USDC: +10.4, KRW: +1500 } 형태의 변경분
 * @returns 갱신된 스냅샷 (캐시 없으면 undefined)
 */
export function optimisticUpdate(
  botId: number,
  delta: Partial<Record<string, number>>
): InventorySnapshot | undefined {
  const snap = inventoryCache.get(botId);
  if (!snap) return undefined;

  // 불변성 유지: spread로 새 객체 생성
  const newBalances = { ...snap.balances };
  for (const [coin, d] of Object.entries(delta)) {
    newBalances[coin] = (newBalances[coin] || 0) + (d || 0);
  }

  const next: InventorySnapshot = {
    balances: newBalances,
    timestamp: Date.now(),
  };
  inventoryCache.set(botId, next);
  return next;
}

/**
 * 디페그 상태 판정
 *
 * 5종 코인 가격의 중앙값 대비 ±thresholdBps 초과 여부를 판단한다.
 * 마치 체온계처럼, 정상 범위(36.5±1℃)를 벗어난 코인만 "이상" 표시.
 *
 * @param prices 코인→KRW 가격 맵 (null/undefined는 데이터 없음으로 처리)
 * @param thresholdBps 허용 편차 (200 = 2%)
 * @returns 코인별 depegged 여부 (true = 거래 금지)
 */
export function computeDepegStatus(
  prices: Record<string, number | null | undefined>,
  thresholdBps: number
): Record<string, boolean> {
  // 유효한 가격만 추출 (null, undefined, 0 이하 제외)
  const valid = Object.entries(prices).filter(
    ([, v]) => typeof v === 'number' && v > 0
  ) as Array<[string, number]>;

  // 유효 데이터 3개 미만이면 판정 불가 → 전부 not-depegged 반환
  if (valid.length < 3) {
    return Object.fromEntries(Object.keys(prices).map(k => [k, false]));
  }

  // 중앙값 계산 (오름차순 정렬 후 중간 인덱스)
  const sorted = [...valid].sort(([, a], [, b]) => a - b);
  const mid = sorted[Math.floor(sorted.length / 2)][1];
  const allowedDeviation = mid * (thresholdBps / 10000);

  const result: Record<string, boolean> = {};
  for (const coin of Object.keys(prices)) {
    const v = prices[coin];
    // missing 값 → not depegged
    if (typeof v !== 'number' || v <= 0) {
      result[coin] = false;
      continue;
    }
    // "이상(≥)" 조건: 경계값 포함하여 depegged 처리
    result[coin] = Math.abs(v - mid) >= allowedDeviation;
  }
  return result;
}

export { STABLECOINS };
