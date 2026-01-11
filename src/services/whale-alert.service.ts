/**
 * Whale Alert Service
 *
 * 온체인 고래 활동을 모니터링하고 클라이언트에 브로드캐스트
 * - Whale Alert API를 통해 대형 거래 감지
 * - BTC, ETH, XRP 지원
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

// 요약 통계 인터페이스
export interface WhaleSummary {
  symbol: string;
  period: string;
  exchangeToWallet: { count: number; totalAmount: number; totalUsd: number };
  walletToExchange: { count: number; totalAmount: number; totalUsd: number };
  netFlow: number; // 양수: 거래소에서 유출 (매수 신호), 음수: 거래소로 유입 (매도 신호)
  netFlowUsd: number;
  dominantSignal: 'bullish' | 'bearish' | 'neutral';
  lastUpdated: number;
}

class WhaleAlertService {
  private apiKey: string;
  private readonly API_BASE = 'https://api.whale-alert.io/v1';
  private readonly MIN_VALUE_USD = 500000; // 최소 $500,000 거래만 추적
  private readonly SUPPORTED_SYMBOLS = ['btc', 'eth', 'xrp'];
  private readonly FETCH_INTERVAL = 60000; // 1분마다 조회 (무료 티어 제한)

  private fetchInterval: NodeJS.Timeout | null = null;
  private isRunning: boolean = false;

  // 캐시: 최근 거래 및 요약
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
    console.log('[WhaleAlert] 고래 모니터링 시작');

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
    try {
      // 현재 시간에서 1시간 전부터 조회
      const now = Math.floor(Date.now() / 1000);
      const start = now - 3600; // 1시간 전

      const url = `${this.API_BASE}/transactions?api_key=${this.apiKey}&min_value=${this.MIN_VALUE_USD}&start=${start}&cursor=`;

      const response = await fetch(url);

      if (!response.ok) {
        const errorText = await response.text();
        console.error('[WhaleAlert] API 오류:', response.status, errorText);
        return;
      }

      const data = await response.json() as { transactions?: any[]; result?: string };

      if (!data.transactions || !Array.isArray(data.transactions)) {
        return;
      }

      // 지원하는 코인별로 분류
      const transactionsBySymbol = new Map<string, WhaleTransaction[]>();
      for (const symbol of this.SUPPORTED_SYMBOLS) {
        transactionsBySymbol.set(symbol, []);
      }

      for (const tx of data.transactions as any[]) {
        const symbol = tx.symbol?.toLowerCase();
        if (!this.SUPPORTED_SYMBOLS.includes(symbol)) continue;

        const transaction = this.parseTransaction(tx);
        transactionsBySymbol.get(symbol)?.push(transaction);
      }

      // 캐시 업데이트 및 요약 계산
      for (const symbol of this.SUPPORTED_SYMBOLS) {
        const transactions = transactionsBySymbol.get(symbol) || [];

        // 최신순 정렬
        transactions.sort((a, b) => b.timestamp - a.timestamp);

        // 최근 50개만 유지
        this.recentTransactions.set(symbol, transactions.slice(0, 50));

        // 요약 계산
        this.calculateSummary(symbol);
      }

      // 클라이언트에 브로드캐스트
      this.broadcastToClients();

      // 디버그 로그 (10분마다)
      if (Date.now() % 600000 < this.FETCH_INTERVAL) {
        const totalTx = Array.from(this.recentTransactions.values()).reduce((sum, arr) => sum + arr.length, 0);
        console.log(`[WhaleAlert] ${totalTx}개 고래 거래 감지`);
      }

    } catch (error: any) {
      console.error('[WhaleAlert] 거래 조회 실패:', error.message);
    }
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
   * 요약 통계 계산
   */
  private calculateSummary(symbol: string): void {
    const transactions = this.recentTransactions.get(symbol) || [];

    const summary: WhaleSummary = {
      symbol: symbol.toUpperCase(),
      period: '1h',
      exchangeToWallet: { count: 0, totalAmount: 0, totalUsd: 0 },
      walletToExchange: { count: 0, totalAmount: 0, totalUsd: 0 },
      netFlow: 0,
      netFlowUsd: 0,
      dominantSignal: 'neutral',
      lastUpdated: Date.now(),
    };

    for (const tx of transactions) {
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

    // 지배적 신호 결정
    if (summary.netFlowUsd > 1000000) {
      summary.dominantSignal = 'bullish';
    } else if (summary.netFlowUsd < -1000000) {
      summary.dominantSignal = 'bearish';
    } else {
      summary.dominantSignal = 'neutral';
    }

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
  getStatus(): { isRunning: boolean; supportedSymbols: string[]; minValueUsd: number } {
    return {
      isRunning: this.isRunning,
      supportedSymbols: this.SUPPORTED_SYMBOLS.map(s => s.toUpperCase()),
      minValueUsd: this.MIN_VALUE_USD,
    };
  }
}

export const whaleAlertService = new WhaleAlertService();
