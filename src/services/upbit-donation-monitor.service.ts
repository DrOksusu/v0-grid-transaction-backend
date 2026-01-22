import { checkAndConfirmDeposits } from './upbit-donation.service';
import { config } from '../config/env';

class UpbitDonationMonitorService {
  private intervalId: NodeJS.Timeout | null = null;
  private isRunning = false;

  /**
   * 모니터링 서비스 시작
   */
  start() {
    if (this.isRunning) {
      console.log('[UpbitDonationMonitor] 이미 실행 중');
      return;
    }

    // API 키가 설정되어 있는지 확인
    if (!config.donation.upbitAccessKey || !config.donation.upbitSecretKey) {
      console.log('[UpbitDonationMonitor] 운영자 업비트 API 키가 설정되지 않아 모니터링 비활성화');
      return;
    }

    this.isRunning = true;
    console.log(`[UpbitDonationMonitor] 시작 - ${config.donation.pollInterval / 1000}초 간격으로 입금 확인`);

    // 즉시 한 번 실행
    this.checkDeposits();

    // 주기적 실행
    this.intervalId = setInterval(() => {
      this.checkDeposits();
    }, config.donation.pollInterval);
  }

  /**
   * 모니터링 서비스 중지
   */
  stop() {
    if (this.intervalId) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
    this.isRunning = false;
    console.log('[UpbitDonationMonitor] 중지됨');
  }

  /**
   * 입금 확인 실행
   */
  private async checkDeposits() {
    try {
      const result = await checkAndConfirmDeposits();
      if (result.confirmed > 0) {
        console.log(`[UpbitDonationMonitor] ${result.confirmed}건의 후원 확인됨`);
      }
    } catch (error: any) {
      console.error('[UpbitDonationMonitor] 입금 확인 실패:', error.message);
    }
  }
}

export const upbitDonationMonitor = new UpbitDonationMonitorService();
