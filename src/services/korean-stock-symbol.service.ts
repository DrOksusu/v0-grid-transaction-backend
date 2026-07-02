// 한국주식 종목 lazy resolve 헬퍼
// 자세한 사양: docs/superpowers/specs/2026-06-29-korean-stock-grid-design.md § 10

import prisma from '../config/database';
import { tossService, TossApiError, TossCredentials } from './toss.service';

const KR_CODE_PATTERN = /^\d{6}$/;

// KR 종목코드 형식(6자리 숫자) 여부
export function isKoreanStockCodePattern(input: string): boolean {
  return KR_CODE_PATTERN.test(input);
}

// 사용자 credential로 lazy resolve 후 upsert. 없으면 null 반환.
// - 정확한 code가 아니면 즉시 null (`stocks?symbols=`가 exact 조회이므로)
// - Toss `stocks?symbols=` 응답에 없으면 null
// - 응답 있어도 KR 시장(KOSPI/KOSDAQ)이 아니면 null (본 스코프는 국내 주식만)
// - status=DELISTED여도 upsert는 하되 호출자가 tradable 여부 판단
export async function resolveKoreanStockSymbol(
  cred: TossCredentials,
  code: string,
): Promise<{ code: string; name: string; market: string; sector: string | null; status: string | null } | null> {
  if (!isKoreanStockCodePattern(code)) return null;
  try {
    const list = await tossService.getStocks(cred, [code]);
    const info = list.find((s) => s.symbol === code);
    if (!info) return null;
    if (info.market !== 'KOSPI' && info.market !== 'KOSDAQ') return null;

    const saved = await prisma.koreanStockSymbol.upsert({
      where: { code: info.symbol },
      create: {
        code: info.symbol,
        name: info.name,
        market: info.market,
        sector: null,
      },
      update: {
        name: info.name,
        market: info.market,
      },
    });
    return {
      code: saved.code,
      name: saved.name,
      market: saved.market,
      sector: saved.sector,
      status: info.status,
    };
  } catch (e) {
    // 404 stock-not-found는 정상 not-found로 취급
    if (e instanceof TossApiError && e.code === 'stock-not-found') return null;
    throw e;
  }
}
