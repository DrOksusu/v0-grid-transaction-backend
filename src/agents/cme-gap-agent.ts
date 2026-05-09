/**
 * CME 갭 매매 에이전트
 *
 * 30초마다 사이클을 실행하며 KST(UTC+9) 시간 기반으로 트리거를 관리한다:
 *   - 토요일 07:00~08:00 KST: CME 금요일 종가 기록 (업비트 BTC/KRW 현재가)
 *   - 월요일 07:00~08:00 KST: CME 월요일 시가 기록 + 갭 감지 및 하방 갭 즉시 진입
 *   - 매 사이클: 활성 갭 상태 점검 (상방 갭 진입 조건 확인 + TP 체결 확인 + 만료 처리)
 */

import { BaseAgent } from './base-agent';
import { cmeGapService } from '../services/cme-gap.service';

/** KST 오프셋: UTC + 9시간 */
const KST_OFFSET_MS = 9 * 60 * 60 * 1000;

/**
 * UTC Date를 KST로 변환하여 시(hour)와 요일(day)을 반환
 * @param utcDate - UTC 기준 Date 객체
 * @returns { kstHour: 0-23, kstDay: 0(일)~6(토) }
 */
function getKstTime(utcDate: Date): { kstHour: number; kstDay: number } {
  const kstMs = utcDate.getTime() + KST_OFFSET_MS;
  const kstDate = new Date(kstMs);
  return {
    kstHour: kstDate.getUTCHours(), // UTC 기반으로 읽어야 KST 변환이 정확
    kstDay: kstDate.getUTCDay(),    // 0=일요일, 6=토요일
  };
}

export class CmeGapAgent extends BaseAgent {
  constructor() {
    super({
      id: 'cme-gap',
      name: 'CmeGapAgent',
      description: 'CME BTC 선물 주말 갭 자동매매 봇 (Upbit BTC/KRW 기반)',
      cycleIntervalMs: 30_000, // 30초 사이클
    });
  }

  protected async onStart(): Promise<void> {
    console.log('[CmeGapAgent] 시작 — 30초 사이클로 CME 갭 모니터링');
  }

  protected async onStop(): Promise<void> {
    console.log('[CmeGapAgent] 정지');
  }

  protected async onCycle(): Promise<void> {
    const now = new Date();
    const { kstHour, kstDay } = getKstTime(now);

    // ── 토요일(6) 07:00~08:00 KST: CME 금요일 종가 기록 ──────────────
    if (kstDay === 6 && kstHour === 7) {
      try {
        await cmeGapService.recordFridayClose();
      } catch (err: any) {
        console.error(`[CmeGapAgent] 금요일 종가 기록 오류 — ${err.message}`);
      }
    }

    // ── 월요일(1) 07:00~08:00 KST: CME 월요일 시가 + 갭 감지 ──────────
    if (kstDay === 1 && kstHour === 7) {
      try {
        await cmeGapService.recordMondayOpenAndDetectGaps();
      } catch (err: any) {
        console.error(`[CmeGapAgent] 월요일 시가 기록 오류 — ${err.message}`);
      }
    }

    // ── 매 사이클: 활성 갭 상태 점검 ────────────────────────────────────
    try {
      await cmeGapService.checkActiveGaps();
    } catch (err: any) {
      console.error(`[CmeGapAgent] 활성 갭 점검 오류 — ${err.message}`);
    }
  }

  protected getExtraInfo(): Record<string, any> {
    return {
      note: '토요일 07:00 KST: fridayClose 기록, 월요일 07:00 KST: mondayOpen + 갭 감지',
    };
  }
}
