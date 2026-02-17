import { Router, Request, Response } from 'express';
import { agentManager } from '../agents';

const router = Router();

// GET /api/agents - 모든 에이전트 상태 조회
router.get('/', (req: Request, res: Response) => {
  const statuses = agentManager.getAllStatus();
  res.json({ success: true, data: statuses });
});

// GET /api/agents/metrics - 전체 메트릭스 대시보드
router.get('/metrics', (req: Request, res: Response) => {
  const metrics = agentManager.getMetrics();
  res.json({ success: true, data: metrics });
});

// GET /api/agents/:id - 특정 에이전트 상태
router.get('/:id', (req: Request, res: Response) => {
  const agent = agentManager.getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ success: false, error: { code: 'AGENT_NOT_FOUND', message: `Agent '${req.params.id}' not found` } });
    return;
  }
  res.json({ success: true, data: agent.getStatus() });
});

// POST /api/agents/:id/start - 에이전트 시작
router.post('/:id/start', async (req: Request, res: Response) => {
  const agent = agentManager.getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ success: false, error: { code: 'AGENT_NOT_FOUND', message: `Agent '${req.params.id}' not found` } });
    return;
  }

  try {
    await agent.start();
    res.json({ success: true, data: agent.getStatus() });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'AGENT_START_FAILED', message: error.message } });
  }
});

// POST /api/agents/:id/stop - 에이전트 중지
router.post('/:id/stop', async (req: Request, res: Response) => {
  const agent = agentManager.getAgent(req.params.id);
  if (!agent) {
    res.status(404).json({ success: false, error: { code: 'AGENT_NOT_FOUND', message: `Agent '${req.params.id}' not found` } });
    return;
  }

  try {
    await agent.stop();
    res.json({ success: true, data: agent.getStatus() });
  } catch (error: any) {
    res.status(500).json({ success: false, error: { code: 'AGENT_STOP_FAILED', message: error.message } });
  }
});

export default router;
