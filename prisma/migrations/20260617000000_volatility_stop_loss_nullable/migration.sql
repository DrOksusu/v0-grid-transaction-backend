-- 변동성 돌파봇 손절 비활성화 옵션: stop_loss_pct를 nullable로 변경
-- null = 손절 OFF (일일 마감 청산만 사용)
ALTER TABLE `volatility_breakout_bots`
  MODIFY COLUMN `stop_loss_pct` DOUBLE NULL DEFAULT 3;
