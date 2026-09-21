// 깊이(depth) 조회 + VWAP 계산 (spec §Task3: 최소주문 규모 검증용)
// vwapForNotional은 순수함수(외부 I/O 없음). fetch*Depth는 USDT권 shortlist 전용 per-symbol 조회.
import axios from 'axios';
import { BookLevel } from './multi-arb-types';

const HTTP_TIMEOUT_MS = 10000;

// 호가 레벨 목록을 순서대로 누적 소비하여 목표금액(targetNotional)까지 체결했을 때의 VWAP·충족여부를 계산
// levels는 이미 유리한 순서(ask=오름차순, bid=내림차순)로 정렬돼 있다고 가정
export function vwapForNotional(
  levels: BookLevel[],
  targetNotional: number,
): { vwap: number; filledNotional: number; ok: boolean } {
  if (levels.length === 0) return { vwap: 0, filledNotional: 0, ok: false };

  let filledNotional = 0;
  let filledQty = 0;

  for (const level of levels) {
    if (filledNotional >= targetNotional) break;
    const remaining = targetNotional - filledNotional;
    const levelNotional = level.price * level.qty;

    if (levelNotional <= remaining) {
      // 레벨 전체 소비
      filledNotional += levelNotional;
      filledQty += level.qty;
    } else {
      // 레벨 일부만 소비
      const partialQty = remaining / level.price;
      filledNotional += remaining;
      filledQty += partialQty;
    }
  }

  const ok = filledNotional >= targetNotional * 0.999;
  const vwap = filledQty > 0 ? filledNotional / filledQty : 0;
  return { vwap, filledNotional, ok };
}

// 바이낸스/MEXC/Gate.io depth 조회 (USDT권 shortlist 전용, per-symbol) — 실패 시 null
export async function fetchBinanceDepth(symbol: string): Promise<{ askLevels: BookLevel[]; bidLevels: BookLevel[] } | null> {
  try {
    const res = await axios.get(`https://api.binance.com/api/v3/depth?symbol=${symbol}USDT&limit=20`, { timeout: HTTP_TIMEOUT_MS });
    return parseBinanceStyleDepth(res.data);
  } catch {
    return null;
  }
}

export async function fetchMexcDepth(symbol: string): Promise<{ askLevels: BookLevel[]; bidLevels: BookLevel[] } | null> {
  try {
    const res = await axios.get(`https://api.mexc.com/api/v3/depth?symbol=${symbol}USDT&limit=20`, { timeout: HTTP_TIMEOUT_MS });
    return parseBinanceStyleDepth(res.data);
  } catch {
    return null;
  }
}

export async function fetchGateioDepth(symbol: string): Promise<{ askLevels: BookLevel[]; bidLevels: BookLevel[] } | null> {
  try {
    const res = await axios.get(`https://api.gateio.ws/api/v4/spot/order_book?currency_pair=${symbol}_USDT&limit=20`, { timeout: HTTP_TIMEOUT_MS });
    return parseBinanceStyleDepth(res.data);
  } catch {
    return null;
  }
}

// 바이낸스/MEXC/Gate.io 공통 응답 포맷: { bids:[[price,qty]], asks:[[price,qty]] }
// (MEDIUM-2) vwapForNotional은 askLevels 오름차·bidLevels 내림차 순서를 계약으로 가정 — 거래소 응답
// 순서를 신뢰하지 않고 파싱 시점에 명시 정렬한다.
function parseBinanceStyleDepth(data: any): { askLevels: BookLevel[]; bidLevels: BookLevel[] } | null {
  if (!data || !Array.isArray(data.asks) || !Array.isArray(data.bids)) return null;
  const toLevels = (rows: any[]): BookLevel[] =>
    rows
      .map((row) => ({ price: parseFloat(row[0]), qty: parseFloat(row[1]) }))
      .filter((l) => l.price > 0 && l.qty > 0);
  const askLevels = toLevels(data.asks).sort((a, b) => a.price - b.price);
  const bidLevels = toLevels(data.bids).sort((a, b) => b.price - a.price);
  return { askLevels, bidLevels };
}
