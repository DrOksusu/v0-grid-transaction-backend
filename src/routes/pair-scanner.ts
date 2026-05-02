import { Router, Request, Response } from 'express';
import { pairScannerService, PairConfig } from '../services/pair-scanner.service';

const router = Router();

// GET /api/pair-scanner/pairs — 등록된 페어 목록 + 설정값
router.get('/pairs', (_req: Request, res: Response) => {
  res.json({ success: true, data: pairScannerService.getPairs() });
});

// POST /api/pair-scanner/pairs — 페어 추가
router.post('/pairs', (req: Request, res: Response) => {
  const { name, makerCoin, takerCoin, qty, makerFeeRate, takerFeeRate } = req.body as Partial<PairConfig>;

  if (!name || !makerCoin || !takerCoin || qty == null || makerFeeRate == null || takerFeeRate == null) {
    res.status(400).json({ success: false, error: '필수 필드 누락: name, makerCoin, takerCoin, qty, makerFeeRate, takerFeeRate' });
    return;
  }

  const result = pairScannerService.addPair({ name, makerCoin, takerCoin, qty: Number(qty), makerFeeRate: Number(makerFeeRate), takerFeeRate: Number(takerFeeRate) });

  if (!result.success) {
    res.status(400).json(result);
    return;
  }

  res.json({ success: true, data: pairScannerService.getPairs() });
});

// DELETE /api/pair-scanner/pairs/:name — 페어 제거
router.delete('/pairs/:name', (req: Request, res: Response) => {
  const { name } = req.params;
  const removed = pairScannerService.removePair(name);

  if (!removed) {
    res.status(404).json({ success: false, error: `페어 '${name}'을 찾을 수 없습니다` });
    return;
  }

  res.json({ success: true, data: pairScannerService.getPairs() });
});

// GET /api/pair-scanner/stats — 전체 페어 통계 스냅샷 (REST 폴백)
router.get('/stats', (_req: Request, res: Response) => {
  res.json({ success: true, data: pairScannerService.getSnapshot() });
});

export default router;
