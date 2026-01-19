/**
 * TRC-20 USDT 입금 모니터링 서비스
 *
 * TronGrid API를 사용해 서비스 지갑으로 들어오는 USDT 입금을 모니터링하고
 * 입금 확인 시 구독을 자동 활성화
 */

import { config } from '../config/env';
import prisma from '../config/database';
// import { socketService } from './socket.service';

interface TRC20Transaction {
  transaction_id: string;
  token_info: {
    symbol: string;
    address: string;
    decimals: number;
  };
  from: string;
  to: string;
  value: string;
  block_timestamp: number;
}

interface TronGridResponse {
  success: boolean;
  data: TRC20Transaction[];
  meta: {
    at: number;
    page_size: number;
  };
}

class TRC20MonitorService {
  private readonly API_BASE = config.tron.apiBase;
  private readonly USDT_CONTRACT = config.tron.usdtContract;
  private readonly DEPOSIT_ADDRESS = config.tron.depositAddress;
  private readonly POLL_INTERVAL = config.tron.pollInterval;
  private readonly MIN_AMOUNT = config.usdt.subscriptionAmount;

  private pollInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private lastCheckTime: number = 0;
  private processedTxHashes: Set<string> = new Set();

  constructor() {
    // 마지막 체크 시간 초기화 (최근 1시간)
    this.lastCheckTime = Date.now() - 3600000;
  }

  /**
   * 모니터링 시작
   */
  start(): void {
    if (!this.DEPOSIT_ADDRESS) {
      console.log('[TRC20Monitor] 입금 주소가 설정되지 않음. 서비스 비활성화.');
      return;
    }

    if (!config.tron.apiKey) {
      console.log('[TRC20Monitor] TronGrid API 키가 설정되지 않음. 서비스 비활성화.');
      return;
    }

    if (this.isRunning) {
      console.log('[TRC20Monitor] 이미 실행 중');
      return;
    }

    this.isRunning = true;
    console.log('[TRC20Monitor] USDT 입금 모니터링 시작');
    console.log(`[TRC20Monitor] 감시 주소: ${this.DEPOSIT_ADDRESS}`);

    // 기존 처리된 트랜잭션 로드
    this.loadProcessedTransactions();

    // 즉시 한 번 실행
    this.checkDeposits();

    // 주기적으로 실행
    this.pollInterval = setInterval(() => {
      this.checkDeposits();
    }, this.POLL_INTERVAL);
  }

  /**
   * 모니터링 중지
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.isRunning = false;
    console.log('[TRC20Monitor] USDT 입금 모니터링 중지');
  }

  /**
   * 기존에 처리된 트랜잭션 해시 로드
   */
  private async loadProcessedTransactions(): Promise<void> {
    try {
      const deposits = await prisma.usdtDeposit.findMany({
        where: {
          txHash: { not: null }
        },
        select: { txHash: true }
      });

      deposits.forEach((d: { txHash: string | null }) => {
        if (d.txHash) {
          this.processedTxHashes.add(d.txHash);
        }
      });

      console.log(`[TRC20Monitor] 기존 처리 트랜잭션 ${this.processedTxHashes.size}개 로드`);
    } catch (error) {
      console.error('[TRC20Monitor] 처리된 트랜잭션 로드 실패:', error);
    }
  }

  /**
   * 입금 확인
   */
  private async checkDeposits(): Promise<void> {
    try {
      // TronGrid API로 TRC-20 거래 조회
      const transactions = await this.fetchTRC20Transactions();

      if (!transactions || transactions.length === 0) {
        return;
      }

      // 대기 중인 입금 요청 조회
      const pendingDeposits = await prisma.usdtDeposit.findMany({
        where: {
          status: 'pending',
          expiresAt: { gt: new Date() }
        }
      });

      if (pendingDeposits.length === 0) {
        return;
      }

      // 각 트랜잭션 처리
      for (const tx of transactions) {
        // 이미 처리된 트랜잭션 스킵
        if (this.processedTxHashes.has(tx.transaction_id)) {
          continue;
        }

        // USDT 입금만 처리
        if (tx.to.toLowerCase() !== this.DEPOSIT_ADDRESS.toLowerCase()) {
          continue;
        }

        // 금액 파싱 (USDT는 6 decimals)
        const amount = parseInt(tx.value) / 1e6;

        // 최소 금액 체크
        if (amount < this.MIN_AMOUNT) {
          console.log(`[TRC20Monitor] 금액 부족: ${amount} USDT (최소 ${this.MIN_AMOUNT})`);
          continue;
        }

        // 소수점에서 사용자 코드 추출 (예: 10.123456 → "123456")
        const uniqueCode = this.extractUniqueCode(amount);

        // 매칭되는 입금 요청 찾기
        const matchedDeposit = pendingDeposits.find((d: { uniqueCode: string }) => d.uniqueCode === uniqueCode);

        if (matchedDeposit) {
          await this.processConfirmedDeposit(matchedDeposit, tx, amount);
        } else {
          console.log(`[TRC20Monitor] 매칭 안됨: ${amount} USDT (코드: ${uniqueCode})`);
        }
      }

      this.lastCheckTime = Date.now();

    } catch (error: any) {
      console.error('[TRC20Monitor] 입금 확인 실패:', error.message);
    }
  }

  /**
   * TronGrid API로 TRC-20 거래 조회
   */
  private async fetchTRC20Transactions(): Promise<TRC20Transaction[]> {
    try {
      const url = `${this.API_BASE}/v1/accounts/${this.DEPOSIT_ADDRESS}/transactions/trc20`;

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'TRON-PRO-API-KEY': config.tron.apiKey,
          'Accept': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error(`API 오류: ${response.status}`);
      }

      const data = await response.json() as TronGridResponse;

      if (!data.success || !data.data) {
        return [];
      }

      // USDT 컨트랙트만 필터링 + 최근 거래만
      return data.data.filter(tx =>
        tx.token_info?.address === this.USDT_CONTRACT &&
        tx.to.toLowerCase() === this.DEPOSIT_ADDRESS.toLowerCase() &&
        tx.block_timestamp > this.lastCheckTime
      );

    } catch (error) {
      console.error('[TRC20Monitor] TronGrid API 호출 실패:', error);
      return [];
    }
  }

  /**
   * 금액에서 사용자 고유 코드 추출
   * 예: 10.123456 → "123456"
   */
  private extractUniqueCode(amount: number): string {
    const decimalPart = (amount % 1).toFixed(6).slice(2);  // "123456"
    return decimalPart;
  }

  /**
   * 입금 확인 처리
   */
  private async processConfirmedDeposit(
    deposit: any,
    tx: TRC20Transaction,
    amount: number
  ): Promise<void> {
    try {
      console.log(`[TRC20Monitor] 입금 확인: ${amount} USDT (사용자 ${deposit.userId})`);

      // 트랜잭션 기록
      this.processedTxHashes.add(tx.transaction_id);

      // 입금 상태 업데이트
      await prisma.usdtDeposit.update({
        where: { id: deposit.id },
        data: {
          status: 'confirmed',
          txHash: tx.transaction_id,
          confirmedAmount: amount,
          confirmedAt: new Date(),
        },
      });

      // 결제 기록 생성
      const periodStart = new Date();
      const periodEnd = new Date();
      periodEnd.setDate(periodEnd.getDate() + config.usdt.subscriptionDays);

      await prisma.usdtPayment.create({
        data: {
          userId: deposit.userId,
          txHash: tx.transaction_id,
          fromAddress: tx.from,
          amount: amount,
          periodStart,
          periodEnd,
        },
      });

      // 구독 활성화
      await prisma.subscription.upsert({
        where: { userId: deposit.userId },
        update: {
          plan: 'pro',
          status: 'active',
          paymentMethod: 'usdt',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
          cancelAtPeriodEnd: false,
        },
        create: {
          userId: deposit.userId,
          plan: 'pro',
          status: 'active',
          paymentMethod: 'usdt',
          currentPeriodStart: periodStart,
          currentPeriodEnd: periodEnd,
        },
      });

      // TODO: Socket.io로 실시간 알림 (emitToUser 구현 필요)
      // socketService.emitToUser(deposit.userId, 'deposit:confirmed', {
      //   txHash: tx.transaction_id,
      //   amount,
      //   periodEnd,
      // });

      console.log(`[TRC20Monitor] 구독 활성화 완료: 사용자 ${deposit.userId}, 만료일 ${periodEnd.toISOString()}`);

    } catch (error) {
      console.error('[TRC20Monitor] 입금 처리 실패:', error);
    }
  }

  /**
   * 만료된 입금 요청 처리
   */
  async cleanupExpiredDeposits(): Promise<void> {
    try {
      const result = await prisma.usdtDeposit.updateMany({
        where: {
          status: 'pending',
          expiresAt: { lt: new Date() }
        },
        data: {
          status: 'expired'
        }
      });

      if (result.count > 0) {
        console.log(`[TRC20Monitor] ${result.count}개의 만료된 입금 요청 처리`);
      }
    } catch (error) {
      console.error('[TRC20Monitor] 만료 입금 처리 실패:', error);
    }
  }

  /**
   * 서비스 상태 조회
   */
  getStatus(): {
    isRunning: boolean;
    hasApiKey: boolean;
    hasDepositAddress: boolean;
    depositAddress: string;
    lastCheckTime: number;
    processedTransactions: number;
  } {
    return {
      isRunning: this.isRunning,
      hasApiKey: !!config.tron.apiKey,
      hasDepositAddress: !!this.DEPOSIT_ADDRESS,
      depositAddress: this.DEPOSIT_ADDRESS,
      lastCheckTime: this.lastCheckTime,
      processedTransactions: this.processedTxHashes.size,
    };
  }
}

export const trc20MonitorService = new TRC20MonitorService();
