/**
 * Whale Alert Service
 *
 * 온체인 고래 활동을 모니터링하고 클라이언트에 브로드캐스트
 * - Whale Alert API를 통해 대형 거래 감지
 * - BTC, ETH, XRP 지원
 * - 다중 시간대 지원: 1h, 24h, 7d
 */

import { socketService } from './socket.service';

// 고래 거래 인터페이스
export interface WhaleTransaction {
  id: string;
  blockchain: string;
  symbol: string;
  amount: number;
  amountUsd: number;
  from: {
    address: string;
    owner: string;
    ownerType: 'exchange' | 'wallet' | 'unknown';
  };
  to: {
    address: string;
    owner: string;
    ownerType: 'exchange' | 'wallet' | 'unknown';
  };
  timestamp: number;
  hash: string;
  transactionType: 'exchange_to_wallet' | 'wallet_to_exchange' | 'exchange_to_exchange' | 'wallet_to_wallet' | 'unknown';
  signal: 'bullish' | 'bearish' | 'neutral';
}

// 기간별 요약 통계 인터페이스
export interface PeriodSummary {
  exchangeToWallet: { count: number; totalAmount: number; totalUsd: number };
  walletToExchange: { count: number; totalAmount: number; totalUsd: number };
  netFlow: number; // 양수: 거래소에서 유출 (매수 신호), 음수: 거래소로 유입 (매도 신호)
  netFlowUsd: number;
  dominantSignal: 'bullish' | 'bearish' | 'neutral';
  transactionCount: number;
}

// 다중 시간대 요약 인터페이스
export interface WhaleSummary {
  symbol: string;
  period: string; // 대표 기간 (하위호환)
  // 기간별 요약
  periods: {
    '1h': PeriodSummary;
    '24h': PeriodSummary;
    '7d': PeriodSummary;
  };
  // 하위호환용 (24h 기준)
  exchangeToWallet: { count: number; totalAmount: number; totalUsd: number };
  walletToExchange: { count: number; totalAmount: number; totalUsd: number };
  netFlow: number;
  netFlowUsd: number;
  dominantSignal: 'bullish' | 'bearish' | 'neutral';
  // 신호 강도 (모든 기간이 같은 방향이면 strong)
  signalStrength: 'strong' | 'moderate' | 'weak' | 'mixed';
  lastUpdated: number;
}

// 시간대별 초 단위
const PERIODS = {
  '1h': 3600,
  '24h': 86400,
  '7d': 604800,
} as const;

type PeriodKey = keyof typeof PERIODS;

class WhaleAlertService {
  private apiKey: string;
  private readonly API_BASE = 'https://api.whale-alert.io/v1';
  private readonly MIN_VALUE_USD = 250000; // 최소 $250,000 거래만 추적
  private readonly SUPPORTED_SYMBOLS = ['btc', 'eth', 'xrp'];
  private readonly FETCH_INTERVAL = 60000; // 1분마다 조회
  private readonly QUERY_PERIOD = 604800; // 7일 (유료 API 기준)
  private readonly MAX_TRANSACTIONS = 1000; // 심볼당 최대 저장 거래 수

  private fetchInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;
  private lastFetchTime: number = 0;
  private lastFetchSuccess: boolean = false;
  private lastError: string | null = null;

  // 캐시: 최근 거래 및 요약 (7일치 누적)
  private recentTransactions: Map<string, WhaleTransaction[]> = new Map(); // symbol -> transactions
  private summaries: Map<string, WhaleSummary> = new Map(); // symbol -> summary

  constructor() {
    this.apiKey = process.env.WHALE_ALERT_API_KEY || '';

    // 각 심볼별 빈 배열 초기화
    for (const symbol of this.SUPPORTED_SYMBOLS) {
      this.recentTransactions.set(symbol, []);
    }
  }

  /**
   * 서비스 시작
   */
  start(): void {
    if (!this.apiKey) {
      console.log('[WhaleAlert] API 키가 설정되지 않음. 서비스 비활성화.');
      return;
    }

    if (this.isRunning) {
      console.log('[WhaleAlert] 이미 실행 중');
      return;
    }

    this.isRunning = true;
    console.log('[WhaleAlert] 고래 모니터링 시작 (다중 시간대: 1h, 24h, 7d)');

    // 즉시 한 번 실행
    this.fetchAllTransactions();

    // 주기적으로 실행
    this.fetchInterval = setInterval(() => {
      this.fetchAllTransactions();
    }, this.FETCH_INTERVAL);
  }

  /**
   * 서비스 중지
   */
  stop(): void {
    if (this.fetchInterval) {
      clearInterval(this.fetchInterval);
      this.fetchInterval = null;
    }
    this.isRunning = false;
    console.log('[WhaleAlert] 고래 모니터링 중지');
  }

  /**
   * 모든 지원 코인의 거래 조회
   */
  private async fetchAllTransactions(): Promise<void> {
    this.lastFetchTime = Date.now();

    try {
      // 현재 시간에서 24시간 전부터 조회 (API 제한)
      const now = Math.floor(Date.now() / 1000);
      const start = now - this.QUERY_PERIOD;

      const url = `${this.API_BASE}/transactions?api_key=${this.apiKey}&min_value=${this.MIN_VALUE_USD}&start=${start}&cursor=`;

      const response = await fetch(url);

      if (!response.ok) {
        const errorText = await response.text();
        this.lastFetchSuccess = false;
        this.lastError = `API 오류: ${response.status}`;
        console.error('[WhaleAlert] API 오류:', response.status, errorText);
        return;
      }

      const data = await response.json() as { transactions?: any[]; result?: string; count?: number };

      // API 응답 디버깅 (매 요청마다)
      const txCount = data.transactions?.length || 0;
      const supportedCount = data.transactions?.filter((tx: any) =>
        this.SUPPORTED_SYMBOLS.includes(tx.symbol?.toLowerCase())
      ).length || 0;
      console.log(`[WhaleAlert] API 응답: result=${data.result}, 전체=${txCount}건, 지원코인=${supportedCount}건, start=${start} (${new Date(start * 1000).toISOString()})`);

      if (!data.transactions || !Array.isArray(data.transactions)) {
        this.lastFetchSuccess = true;
        this.lastError = null;
        console.log('[WhaleAlert] 거래 데이터 없음');
        return;
      }

      this.lastFetchSuccess = true;
      this.lastError = null;

      // 새로운 거래를 기존 데이터에 병합
      let newTxCount = 0;
      for (const tx of data.transactions as any[]) {
        const symbol = tx.symbol?.toLowerCase();
        if (!this.SUPPORTED_SYMBOLS.includes(symbol)) continue;

        const transaction = this.parseTransaction(tx);
        this.addTransaction(symbol, transaction);
      }

      // 7일 이전 거래 정리 및 요약 계산
      const cutoffTime = now - PERIODS['7d'];
      for (const symbol of this.SUPPORTED_SYMBOLS) {
        this.cleanOldTransactions(symbol, cutoffTime);
        this.calculateMultiPeriodSummary(symbol);
      }

      // 클라이언트에 브로드캐스트
      this.broadcastToClients();

      // 디버그 로그 (10분마다)
      if (Date.now() % 600000 < this.FETCH_INTERVAL) {
        const totalTx = Array.from(this.recentTransactions.values()).reduce((sum, arr) => sum + arr.length, 0);
        console.log(`[WhaleAlert] ${totalTx}개 고래 거래 저장 중 (7일 누적)`);
      }

    } catch (error: any) {
      this.lastFetchSuccess = false;
      this.lastError = error.message;
      console.error('[WhaleAlert] 거래 조회 실패:', error.message);
    }
  }

  /**
   * 거래 추가 (중복 방지)
   */
  private addTransaction(symbol: string, transaction: WhaleTransaction): void {
    const transactions = this.recentTransactions.get(symbol) || [];

    // 중복 확인 (id 또는 hash로)
    const exists = transactions.some(tx => tx.id === transaction.id || tx.hash === transaction.hash);
    if (exists) return;

    transactions.push(transaction);

    // 최신순 정렬
    transactions.sort((a, b) => b.timestamp - a.timestamp);

    // 최대 개수 제한
    if (transactions.length > this.MAX_TRANSACTIONS) {
      transactions.splice(this.MAX_TRANSACTIONS);
    }

    this.recentTransactions.set(symbol, transactions);
  }

  /**
   * 오래된 거래 정리
   */
  private cleanOldTransactions(symbol: string, cutoffTime: number): void {
    const transactions = this.recentTransactions.get(symbol) || [];
    const filtered = transactions.filter(tx => tx.timestamp >= cutoffTime);
    this.recentTransactions.set(symbol, filtered);
  }

  /**
   * API 응답을 WhaleTransaction으로 변환
   */
  private parseTransaction(tx: any): WhaleTransaction {
    const fromType = this.getOwnerType(tx.from?.owner_type);
    const toType = this.getOwnerType(tx.to?.owner_type);

    const transactionType = this.getTransactionType(fromType, toType);
    const signal = this.getSignal(transactionType);

    return {
      id: tx.id || tx.hash,
      blockchain: tx.blockchain,
      symbol: tx.symbol?.toUpperCase(),
      amount: tx.amount || 0,
      amountUsd: tx.amount_usd || 0,
      from: {
        address: tx.from?.address || '',
        owner: tx.from?.owner || 'unknown',
        ownerType: fromType,
      },
      to: {
        address: tx.to?.address || '',
        owner: tx.to?.owner || 'unknown',
        ownerType: toType,
      },
      timestamp: tx.timestamp || 0,
      hash: tx.hash || '',
      transactionType,
      signal,
    };
  }

  /**
   * 소유자 유형 분류
   */
  private getOwnerType(type: string): 'exchange' | 'wallet' | 'unknown' {
    if (!type) return 'unknown';
    if (type === 'exchange') return 'exchange';
    if (type === 'wallet' || type === 'unknown') return 'wallet';
    return 'unknown';
  }

  /**
   * 거래 유형 분류
   */
  private getTransactionType(
    fromType: 'exchange' | 'wallet' | 'unknown',
    toType: 'exchange' | 'wallet' | 'unknown'
  ): WhaleTransaction['transactionType'] {
    if (fromType === 'exchange' && toType === 'wallet') return 'exchange_to_wallet';
    if (fromType === 'wallet' && toType === 'exchange') return 'wallet_to_exchange';
    if (fromType === 'exchange' && toType === 'exchange') return 'exchange_to_exchange';
    if (fromType === 'wallet' && toType === 'wallet') return 'wallet_to_wallet';
    return 'unknown';
  }

  /**
   * 신호 결정
   */
  private getSignal(transactionType: WhaleTransaction['transactionType']): WhaleTransaction['signal'] {
    switch (transactionType) {
      case 'exchange_to_wallet':
        return 'bullish'; // 거래소에서 지갑으로 = 장기 보유 의도
      case 'wallet_to_exchange':
        return 'bearish'; // 지갑에서 거래소로 = 매도 준비
      default:
        return 'neutral';
    }
  }

  /**
   * 기간별 요약 계산
   */
  private calculatePeriodSummary(transactions: WhaleTransaction[], periodSeconds: number): PeriodSummary {
    const now = Math.floor(Date.now() / 1000);
    const cutoff = now - periodSeconds;

    const filteredTx = transactions.filter(tx => tx.timestamp >= cutoff);

    const summary: PeriodSummary = {
      exchangeToWallet: { count: 0, totalAmount: 0, totalUsd: 0 },
      walletToExchange: { count: 0, totalAmount: 0, totalUsd: 0 },
      netFlow: 0,
      netFlowUsd: 0,
      dominantSignal: 'neutral',
      transactionCount: filteredTx.length,
    };

    for (const tx of filteredTx) {
      if (tx.transactionType === 'exchange_to_wallet') {
        summary.exchangeToWallet.count++;
        summary.exchangeToWallet.totalAmount += tx.amount;
        summary.exchangeToWallet.totalUsd += tx.amountUsd;
      } else if (tx.transactionType === 'wallet_to_exchange') {
        summary.walletToExchange.count++;
        summary.walletToExchange.totalAmount += tx.amount;
        summary.walletToExchange.totalUsd += tx.amountUsd;
      }
    }

    // 순 유출량 계산 (양수 = 거래소에서 유출 = 매수 신호)
    summary.netFlow = summary.exchangeToWallet.totalAmount - summary.walletToExchange.totalAmount;
    summary.netFlowUsd = summary.exchangeToWallet.totalUsd - summary.walletToExchange.totalUsd;

    // 지배적 신호 결정 (기간별 임계값 적용)
    const threshold = periodSeconds <= 3600 ? 500000 : periodSeconds <= 86400 ? 1000000 : 5000000;
    if (summary.netFlowUsd > threshold) {
      summary.dominantSignal = 'bullish';
    } else if (summary.netFlowUsd < -threshold) {
      summary.dominantSignal = 'bearish';
    } else {
      summary.dominantSignal = 'neutral';
    }

    return summary;
  }

  /**
   * 다중 시간대 요약 통계 계산
   */
  private calculateMultiPeriodSummary(symbol: string): void {
    const transactions = this.recentTransactions.get(symbol) || [];

    const periods = {
      '1h': this.calculatePeriodSummary(transactions, PERIODS['1h']),
      '24h': this.calculatePeriodSummary(transactions, PERIODS['24h']),
      '7d': this.calculatePeriodSummary(transactions, PERIODS['7d']),
    };

    // 신호 강도 계산
    const signals = [periods['1h'].dominantSignal, periods['24h'].dominantSignal, periods['7d'].dominantSignal];
    const bullishCount = signals.filter(s => s === 'bullish').length;
    const bearishCount = signals.filter(s => s === 'bearish').length;

    let signalStrength: WhaleSummary['signalStrength'];
    if (bullishCount === 3 || bearishCount === 3) {
      signalStrength = 'strong';
    } else if (bullishCount >= 2 || bearishCount >= 2) {
      signalStrength = 'moderate';
    } else if (bullishCount === 1 && bearishCount === 1) {
      signalStrength = 'mixed';
    } else {
      signalStrength = 'weak';
    }

    const summary: WhaleSummary = {
      symbol: symbol.toUpperCase(),
      period: '24h', // 하위호환
      periods,
      // 하위호환용 (24h 기준)
      exchangeToWallet: periods['24h'].exchangeToWallet,
      walletToExchange: periods['24h'].walletToExchange,
      netFlow: periods['24h'].netFlow,
      netFlowUsd: periods['24h'].netFlowUsd,
      dominantSignal: periods['24h'].dominantSignal,
      signalStrength,
      lastUpdated: Date.now(),
    };

    this.summaries.set(symbol, summary);
  }

  /**
   * 클라이언트에 브로드캐스트
   */
  private broadcastToClients(): void {
    const data = {
      transactions: Object.fromEntries(this.recentTransactions),
      summaries: Object.fromEntries(this.summaries),
      timestamp: Date.now(),
    };

    socketService.emitWhaleUpdate(data);
  }

  /**
   * 현재 데이터 조회 (API용)
   */
  getData(symbol?: string): {
    transactions: WhaleTransaction[];
    summary: WhaleSummary | null;
  } {
    if (symbol) {
      const sym = symbol.toLowerCase();
      return {
        transactions: this.recentTransactions.get(sym) || [],
        summary: this.summaries.get(sym) || null,
      };
    }

    // 모든 데이터 반환
    const allTransactions: WhaleTransaction[] = [];
    for (const txs of this.recentTransactions.values()) {
      allTransactions.push(...txs);
    }
    allTransactions.sort((a, b) => b.timestamp - a.timestamp);

    return {
      transactions: allTransactions,
      summary: null,
    };
  }

  /**
   * 모든 요약 조회
   */
  getAllSummaries(): WhaleSummary[] {
    return Array.from(this.summaries.values());
  }

  /**
   * 상태 조회
   */
  getStatus(): {
    isRunning: boolean;
    hasApiKey: boolean;
    supportedSymbols: string[];
    minValueUsd: number;
    periods: string[];
    lastFetchTime: number;
    lastFetchSuccess: boolean;
    lastError: string | null;
    totalTransactions: number;
    totalUsd: number;
  } {
    let totalTransactions = 0;
    let totalUsd = 0;

    for (const txs of this.recentTransactions.values()) {
      totalTransactions += txs.length;
      for (const tx of txs) {
        totalUsd += tx.amountUsd || 0;
      }
    }

    return {
      isRunning: this.isRunning,
      hasApiKey: !!this.apiKey,
      supportedSymbols: this.SUPPORTED_SYMBOLS.map(s => s.toUpperCase()),
      minValueUsd: this.MIN_VALUE_USD,
      periods: ['1h', '24h', '7d'],
      lastFetchTime: this.lastFetchTime,
      lastFetchSuccess: this.lastFetchSuccess,
      lastError: this.lastError,
      totalTransactions,
      totalUsd,
    };
  }
}

export const whaleAlertService = new WhaleAlertService();
