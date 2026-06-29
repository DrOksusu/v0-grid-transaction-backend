import prisma from '../config/database';
import { tossService } from './toss.service';

// 일 1회 (KST 16:00) 토스 종목 마스터 동기화. 관리자용 토스 키 사용.
export class KoreanStockSymbolSyncService {
  async syncAll(): Promise<{ inserted: number; updated: number }> {
    const clientId = process.env.TOSS_ADMIN_CLIENT_ID;
    const clientSecret = process.env.TOSS_ADMIN_CLIENT_SECRET;
    if (!clientId || !clientSecret) {
      console.warn('[KoreanStockSymbolSync] TOSS_ADMIN_CLIENT_ID 미설정 — sync skip');
      return { inserted: 0, updated: 0 };
    }

    const symbols = await tossService.getSymbolMaster(clientId, clientSecret);
    let inserted = 0;
    let updated = 0;

    for (const sym of symbols) {
      const existing = await prisma.koreanStockSymbol.findUnique({ where: { code: sym.code } });
      await prisma.koreanStockSymbol.upsert({
        where: { code: sym.code },
        create: {
          code: sym.code,
          name: sym.name,
          market: sym.market,
          sector: (sym as { sector?: string }).sector ?? null,
        },
        update: {
          name: sym.name,
          market: sym.market,
          sector: (sym as { sector?: string }).sector ?? null,
        },
      });
      if (existing) updated++;
      else inserted++;
    }

    console.log(`[KoreanStockSymbolSync] 완료: 신규 ${inserted}, 갱신 ${updated}`);
    return { inserted, updated };
  }
}

export const koreanStockSymbolSyncService = new KoreanStockSymbolSyncService();
