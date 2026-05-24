// 카카오 OAuth + BTC RSI 관리자 컨트롤러
import { Request, Response, NextFunction } from 'express';
import { kakaoNotifyService } from '../services/kakao-notify.service';
import { telegramNotifyService } from '../services/telegram-notify.service';
import { btcRsiMonitorService } from '../services/btc-rsi-monitor.service';
import { sendDailyReport } from '../services/daily-report.service';

/** OAuth 인증 URL 반환 */
export const getAuthUrl = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const url = kakaoNotifyService.getAuthUrl();
    res.json({ authUrl: url });
  } catch (err) {
    next(err);
  }
};

/** OAuth 콜백 — code 수령 후 토큰 교환 */
export const handleCallback = async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { code } = req.query as { code: string };
    if (!code) {
      res.status(400).json({ error: 'code 파라미터 없음' });
      return;
    }
    await kakaoNotifyService.exchangeCode(code);
    res.send('<script>window.close();</script><p>카카오 연결 완료. 창을 닫아주세요.</p>');
  } catch (err) {
    next(err);
  }
};

/** 토큰 상태 조회 */
export const getStatus = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [tokenStatus, currentRsi] = await Promise.all([
      kakaoNotifyService.getStatus(),
      btcRsiMonitorService.getCurrentRsi().catch(() => null),
    ]);
    res.json({ token: tokenStatus, rsi: currentRsi });
  } catch (err) {
    next(err);
  }
};

/** 알림 이력 조회 */
export const getAlertHistory = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const history = await btcRsiMonitorService.getAlertHistory(50);
    res.json({ history });
  } catch (err) {
    next(err);
  }
};

/** 테스트 메시지 발송 */
export const sendTestMessage = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const testText = '[BTC RSI Monitor] 테스트 메시지 ✅\nhttps://v0-grid-transaction.vercel.app/admin/btc-rsi';
    const testTelegramText = '[BTC RSI Monitor] 테스트 메시지 ✅\n<a href="https://v0-grid-transaction.vercel.app/admin/btc-rsi">RSI 관리자 페이지 바로가기</a>';
    await Promise.all([
      kakaoNotifyService.sendToMe(testText),
      telegramNotifyService.sendMessage(testTelegramText),
    ]);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
};

/** RSI 수동 체크 (즉시 실행) */
export const runRsiCheck = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await btcRsiMonitorService.check();
    const rsi = await btcRsiMonitorService.getCurrentRsi();
    res.json({ ok: true, rsi });
  } catch (err) {
    next(err);
  }
};

/** 일일 수익 리포트 즉시 발송 (테스트용) */
export const sendDailyReportNow = async (_req: Request, res: Response, next: NextFunction) => {
  try {
    await sendDailyReport();
    res.json({ ok: true, message: '일일 수익 리포트 발송 완료' });
  } catch (err) {
    next(err);
  }
};
