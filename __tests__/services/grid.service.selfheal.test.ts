/**
 * GridService dead-zone 자가치유 헬퍼 테스트
 *
 * 대상:
 * - detectDeadZone      : 현재가 ±nearBand에 pending 부재 판정 (범위 밖이면 개입 안 함)
 * - findHealCandidates  : 페어 sell status classifier(재고 SOLD/HELD) + STALE 게이트
 * - reactivateLevel     : 원자적 재활성 (동시 전이 시 count===0)
 *
 * prisma는 __mocks__/database.ts로 moduleNameMapper 매핑됨.
 */

// moduleNameMapper가 grid.service.ts의 '../config/database'를 __mocks__/database.ts로 매핑하므로
// 같은 인스턴스를 참조하려면 테스트도 __mocks__에서 직접 import한다.
import prisma from '../../__mocks__/database';
import { GridService } from '../../src/services/grid.service';

const gl = (prisma as any).gridLevel;

beforeEach(() => {
  // clearAllMocks는 mockResolvedValueOnce 큐를 비우지 않아 테스트 간 누수 → resetAllMocks 사용
  jest.resetAllMocks();
});

describe('GridService.detectDeadZone', () => {
  it('현재가가 봇 범위 밖이면 개입하지 않음(false) + count 미조회', async () => {
    const r = await GridService.detectDeadZone(1, 2000, 1400, 1600, 20);
    expect(r).toBe(false);
    expect(gl.count).not.toHaveBeenCalled();
  });

  it('현재가 근처에 살아있는 pending 주문이 있으면 dead-zone 아님(false)', async () => {
    gl.count.mockResolvedValue(1);
    const r = await GridService.detectDeadZone(1, 1474, 1400, 1600, 20);
    expect(r).toBe(false);
  });

  it('현재가 근처에 pending 주문이 하나도 없으면 dead-zone(true)', async () => {
    gl.count.mockResolvedValue(0);
    const r = await GridService.detectDeadZone(1, 1474, 1400, 1600, 20);
    expect(r).toBe(true);
    // ±nearBand(20) 범위로 조회하는지 확인
    expect(gl.count).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          botId: 1,
          status: 'pending',
          price: { gte: 1454, lte: 1494 },
        }),
      })
    );
  });
});

describe('GridService.findHealCandidates (페어 status classifier)', () => {
  it('buy=filled + 페어 sell=filled(재고 SOLD) → buy-heal 포함', async () => {
    gl.findMany
      .mockResolvedValueOnce([{ id: 10, price: 1470, sellPrice: 1480 }]) // filled buys
      .mockResolvedValueOnce([{ price: 1480, status: 'filled' }]); // sells
    const { buyHeals } = await GridService.findHealCandidates(1, 1474, { staleMs: 600000 });
    expect(buyHeals).toHaveLength(1);
    expect(buyHeals[0].id).toBe(10);
  });

  it('buy=filled + 페어 sell=inactive(재고 HELD) → 제외 (이중매수 방지)', async () => {
    gl.findMany
      .mockResolvedValueOnce([{ id: 11, price: 1460, sellPrice: 1470 }])
      .mockResolvedValueOnce([{ price: 1470, status: 'inactive' }]);
    const { buyHeals } = await GridService.findHealCandidates(1, 1474, { staleMs: 600000 });
    expect(buyHeals).toHaveLength(0);
  });

  it('buy=filled + 페어 sell=pending(라이브 매도 중) → 제외', async () => {
    gl.findMany
      .mockResolvedValueOnce([{ id: 12, price: 1460, sellPrice: 1470 }])
      .mockResolvedValueOnce([{ price: 1470, status: 'pending' }]);
    const { buyHeals } = await GridService.findHealCandidates(1, 1474, { staleMs: 600000 });
    expect(buyHeals).toHaveLength(0);
  });

  it('페어 sell을 찾을 수 없으면 제외', async () => {
    gl.findMany
      .mockResolvedValueOnce([{ id: 13, price: 1460, sellPrice: 1470 }])
      .mockResolvedValueOnce([]); // sell 없음
    const { buyHeals } = await GridService.findHealCandidates(1, 1474, { staleMs: 600000 });
    expect(buyHeals).toHaveLength(0);
  });

  it('STALE 게이트: filled 매수 조회 where에 updatedAt lt + price lte + status/type 조건', async () => {
    gl.findMany.mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    await GridService.findHealCandidates(1, 1474, { staleMs: 600000 });
    const firstWhere = gl.findMany.mock.calls[0][0].where;
    expect(firstWhere.status).toBe('filled');
    expect(firstWhere.type).toBe('buy');
    expect(firstWhere.price).toEqual({ lte: 1474 });
    expect(firstWhere.updatedAt.lt).toBeInstanceOf(Date);
    // staleMs=10분 전 시각 근처인지(±5초)
    const expected = Date.now() - 600000;
    expect(Math.abs(firstWhere.updatedAt.lt.getTime() - expected)).toBeLessThan(5000);
  });

  it('cap 초과 시 현재가에 가까운 순으로 최대 cap개만 반환', async () => {
    gl.findMany
      .mockResolvedValueOnce([
        { id: 1, price: 1472, sellPrice: 1482 },
        { id: 2, price: 1462, sellPrice: 1472 },
        { id: 3, price: 1452, sellPrice: 1462 },
      ])
      .mockResolvedValueOnce([
        { price: 1482, status: 'filled' },
        { price: 1472, status: 'filled' },
        { price: 1462, status: 'filled' },
      ]);
    const { buyHeals } = await GridService.findHealCandidates(1, 1474, { staleMs: 600000, cap: 2 });
    expect(buyHeals).toHaveLength(2);
    expect(buyHeals.map((b) => b.id)).toEqual([1, 2]);
  });

  it('후보가 없으면 빈 배열 (sell 조회도 생략)', async () => {
    gl.findMany.mockResolvedValueOnce([]);
    const { buyHeals } = await GridService.findHealCandidates(1, 1474, { staleMs: 600000 });
    expect(buyHeals).toHaveLength(0);
    expect(gl.findMany).toHaveBeenCalledTimes(1); // sell 조회 안 함
  });
});

describe('GridService.reactivateLevel (원자적 재활성)', () => {
  it('여전히 filled면 available로 전환하고 전환 행 수 반환', async () => {
    gl.updateMany.mockResolvedValue({ count: 1 });
    const n = await GridService.reactivateLevel(10, 'filled');
    expect(n).toBe(1);
    expect(gl.updateMany).toHaveBeenCalledWith({
      where: { id: 10, status: 'filled' },
      data: { status: 'available', orderId: null, filledAt: null },
    });
  });

  it('동시 전이로 이미 바뀌었으면(count===0) 0 반환', async () => {
    gl.updateMany.mockResolvedValue({ count: 0 });
    const n = await GridService.reactivateLevel(10, 'filled');
    expect(n).toBe(0);
  });
});
