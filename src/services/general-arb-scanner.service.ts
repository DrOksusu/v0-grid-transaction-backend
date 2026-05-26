import prisma from '../config/database';
import { Prisma } from '@prisma/client';

// 일반 아비트리지 스프레드 스냅샷 인터페이스
export interface GeneralArbSpreadSnapshot {
  symbol: string;
  upbitPrice: number;
  bithumbPrice: number;
  spreadPct: number;        // (bithumb - upbit) / upbit * 100
  direction: string;        // "upbit_higher" | "bithumb_higher" | "equal"
  updatedAt: Date;
}

// 일반 아비트리지 설정 DTO
export interface GeneralArbConfigDto {
  thresholdPct: number;
  minIntervalSec: number;
  isEnabled: boolean;
}

class GeneralArbScannerService {
  // 현재 스프레드 인메모리 스냅샷 (symbol → snapshot)
  private snapshots: Map<string, GeneralArbSpreadSnapshot> = new Map();
  // 마지막 기회 기록 시각 (symbol → timestamp ms)
  private lastOpportunityAt: Map<string, number> = new Map();

  // 설정 캐시 (30초 TTL — 매 사이클 DB 조회 방지)
  private configCache: GeneralArbConfigDto | null = null;
  private configCachedAt = 0;
  private static readonly CONFIG_TTL_MS = 30_000;

  // 설정 조회 (없으면 id=1 생성)
  async getConfig(): Promise<GeneralArbConfigDto> {
    if (this.configCache && Date.now() - this.configCachedAt < GeneralArbScannerService.CONFIG_TTL_MS) {
      return this.configCache;
    }
    let cfg = await (prisma as any).generalArbConfig.findFirst();
    if (!cfg) {
      cfg = await (prisma as any).generalArbConfig.create({
        data: {
          id: 1,
          thresholdPct: new Prisma.Decimal(0.5),
          minIntervalSec: 60,
          isEnabled: true,
        },
      });
    }
    const result: GeneralArbConfigDto = {
      thresholdPct: Number(cfg.thresholdPct),
      minIntervalSec: cfg.minIntervalSec,
      isEnabled: cfg.isEnabled,
    };
    this.configCache = result;
    this.configCachedAt = Date.now();
    return result;
  }

  // 설정 수정
  async patchConfig(dto: Partial<GeneralArbConfigDto>): Promise<GeneralArbConfigDto> {
    // 없으면 생성
    await this.getConfig();
    const updated = await (prisma as any).generalArbConfig.update({
      where: { id: 1 },
      data: {
        ...(dto.thresholdPct !== undefined && {
          thresholdPct: new Prisma.Decimal(dto.thresholdPct),
        }),
        ...(dto.minIntervalSec !== undefined && { minIntervalSec: dto.minIntervalSec }),
        ...(dto.isEnabled !== undefined && { isEnabled: dto.isEnabled }),
      },
    });
    // 설정 변경 시 캐시 무효화
    this.configCache = null;
    this.configCachedAt = 0;
    return {
      thresholdPct: Number(updated.thresholdPct),
      minIntervalSec: updated.minIntervalSec,
      isEnabled: updated.isEnabled,
    };
  }

  // 감시 종목 전체 조회
  async listWatchedSymbols(): Promise<Array<{ id: number; symbol: string; isActive: boolean }>> {
    const rows = await (prisma as any).generalArbWatchedSymbol.findMany({
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((r: any) => ({
      id: r.id,
      symbol: r.symbol,
      isActive: r.isActive,
    }));
  }

  // 활성 종목만 조회
  async getActiveSymbols(): Promise<string[]> {
    const rows = await (prisma as any).generalArbWatchedSymbol.findMany({
      where: { isActive: true },
      select: { symbol: true },
    });
    return rows.map((r: any) => r.symbol as string);
  }

  // 종목 추가 (upsert)
  async addSymbol(symbol: string): Promise<void> {
    await (prisma as any).generalArbWatchedSymbol.upsert({
      where: { symbol },
      create: { symbol, isActive: true },
      update: { isActive: true },
    });
  }

  // 종목 비활성화
  async removeSymbol(symbol: string): Promise<void> {
    await (prisma as any).generalArbWatchedSymbol.updateMany({
      where: { symbol },
      data: { isActive: false },
    });
  }

  // 인메모리 스냅샷 업데이트 (에이전트에서 호출)
  updateSnapshot(symbol: string, upbitPrice: number, bithumbPrice: number): void {
    // 스프레드 계산: (bithumbPrice - upbitPrice) / upbitPrice * 100
    const spreadPct = ((bithumbPrice - upbitPrice) / upbitPrice) * 100;

    // 방향 결정
    let direction: string;
    if (upbitPrice > bithumbPrice) {
      direction = 'upbit_higher';
    } else if (bithumbPrice > upbitPrice) {
      direction = 'bithumb_higher';
    } else {
      direction = 'equal';
    }

    this.snapshots.set(symbol, {
      symbol,
      upbitPrice,
      bithumbPrice,
      spreadPct,
      direction,
      updatedAt: new Date(),
    });
  }

  // 현재 스냅샷 전체 반환
  getSnapshots(): GeneralArbSpreadSnapshot[] {
    return Array.from(this.snapshots.values());
  }

  // 기회 기록 (minIntervalSec 쿨다운 적용)
  // 반환: 기록 여부 (true=기록함, false=쿨다운 중)
  async maybeLogOpportunity(
    symbol: string,
    spreadPct: number,
    thresholdPct: number,
  ): Promise<boolean> {
    // 설정에서 minIntervalSec 가져오기
    const config = await this.getConfig();
    const minIntervalMs = config.minIntervalSec * 1000;

    // 쿨다운 확인
    const lastAt = this.lastOpportunityAt.get(symbol);
    if (lastAt !== undefined && Date.now() - lastAt < minIntervalMs) {
      return false;
    }

    // 스냅샷에서 현재 가격 조회
    const snapshot = this.snapshots.get(symbol);
    const upbitPrice = snapshot?.upbitPrice ?? 0;
    const bithumbPrice = snapshot?.bithumbPrice ?? 0;

    // 방향 결정 (스냅샷 기반)
    let direction: string;
    if (snapshot) {
      direction = snapshot.direction;
    } else {
      direction = spreadPct > 0 ? 'bithumb_higher' : spreadPct < 0 ? 'upbit_higher' : 'equal';
    }

    // DB에 기회 이력 저장
    await (prisma as any).generalArbOpportunity.create({
      data: {
        symbol,
        upbitPrice: new Prisma.Decimal(upbitPrice),
        bithumbPrice: new Prisma.Decimal(bithumbPrice),
        spreadPct: new Prisma.Decimal(spreadPct),
        direction,
        thresholdPct: new Prisma.Decimal(thresholdPct),
      },
    });

    // 마지막 기록 시각 갱신
    this.lastOpportunityAt.set(symbol, Date.now());
    return true;
  }

  // 기회 이력 조회
  async listOpportunities(limit: number, symbol?: string): Promise<any[]> {
    const rows = await (prisma as any).generalArbOpportunity.findMany({
      where: symbol ? { symbol } : undefined,
      orderBy: { detectedAt: 'desc' },
      take: limit,
    });

    // Decimal 타입 → Number 변환
    return rows.map((row: any) => ({
      ...row,
      upbitPrice: Number(row.upbitPrice),
      bithumbPrice: Number(row.bithumbPrice),
      spreadPct: Number(row.spreadPct),
      thresholdPct: Number(row.thresholdPct),
    }));
  }

  // 기회 통계 (심볼별 집계)
  async getOpportunityStats(sinceMs?: number): Promise<
    Array<{
      symbol: string;
      count: number;
      avgSpreadPct: number;
      maxSpreadPct: number;
    }>
  > {
    // 기준 시각: 인자 없으면 최근 7일
    const since = sinceMs
      ? new Date(sinceMs)
      : new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    const rows = await (prisma as any).generalArbOpportunity.findMany({
      where: { detectedAt: { gte: since } },
      select: { symbol: true, spreadPct: true },
    });

    // symbol별 그룹화
    const groupMap = new Map<
      string,
      { count: number; sumSpreadPct: number; maxSpreadPct: number }
    >();

    for (const row of rows) {
      const pct = Number(row.spreadPct);
      const existing = groupMap.get(row.symbol);
      if (existing) {
        existing.count += 1;
        existing.sumSpreadPct += pct;
        existing.maxSpreadPct = Math.max(existing.maxSpreadPct, pct);
      } else {
        groupMap.set(row.symbol, {
          count: 1,
          sumSpreadPct: pct,
          maxSpreadPct: pct,
        });
      }
    }

    // 결과 배열로 변환
    const result: Array<{
      symbol: string;
      count: number;
      avgSpreadPct: number;
      maxSpreadPct: number;
    }> = [];

    groupMap.forEach((val, symbol) => {
      result.push({
        symbol,
        count: val.count,
        avgSpreadPct: val.sumSpreadPct / val.count,
        maxSpreadPct: val.maxSpreadPct,
      });
    });

    // count 내림차순 정렬
    result.sort((a, b) => b.count - a.count);
    return result;
  }

  // 오래된 이력 정리 (days일 이상)
  async pruneOldOpportunities(days: number = 7): Promise<void> {
    const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    await (prisma as any).generalArbOpportunity.deleteMany({
      where: { detectedAt: { lt: cutoff } },
    });
  }
}

export const generalArbScannerService = new GeneralArbScannerService();
