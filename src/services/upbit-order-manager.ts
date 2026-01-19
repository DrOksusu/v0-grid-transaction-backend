/**
 * Upbit WebSocket Order Manager
 *
 * Private WebSocket으로 체결 알림을 실시간으로 수신
 * - 사용자별 WebSocket 연결 관리
 * - myTrade 채널로 체결 알림 수신
 * - REST API 호출 대폭 감소 (429 에러 해결)
 */

import WebSocket from 'ws';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import prisma from '../config/database';
import { decrypt } from '../utils/encryption';
import { TradingService } from './trading.service';
import { GridService } from './grid.service';
import { socketService } from './socket.service';
import { ProfitService } from './profit.service';

interface UserConnection {
  userId: number;
  ws: WebSocket | null;
  apiKey: string;
  secretKey: string;
  isConnected: boolean;
  reconnectAttempts: number;
  reconnectTimeout: NodeJS.Timeout | null;
  pingInterval: NodeJS.Timeout | null;
  markets: Set<string>; // 사용자가 거래 중인 마켓 목록
}

interface MyTradeData {
  type: 'myTrade';
  code: string;           // 마켓 코드 (예: KRW-BTC)
  uuid: string;           // 주문 UUID
  ask_bid: 'ASK' | 'BID'; // ASK=매도, BID=매수
  order_type: string;     // 주문 타입
  state: string;          // 주문 상태 (wait, done, cancel)
  price: number;          // 주문 가격
  volume: number;         // 주문 수량
  executed_volume: number; // 체결 수량
  trades_count: number;   // 체결 횟수
  timestamp: number;
}

class UpbitOrderManager {
  private static instance: UpbitOrderManager;

  private connections: Map<number, UserConnection> = new Map(); // userId -> connection
  private orderToBot: Map<string, { botId: number; gridLevelId: number }> = new Map(); // orderId -> botId
  private isRunning: boolean = false;

  private readonly WS_URL = 'wss://api.upbit.com/websocket/v1/private';
  private readonly PING_INTERVAL = 30000;
  private readonly MAX_RECONNECT_ATTEMPTS = 10;

  private constructor() {}

  static getInstance(): UpbitOrderManager {
    if (!UpbitOrderManager.instance) {
      UpbitOrderManager.instance = new UpbitOrderManager();
    }
    return UpbitOrderManager.instance;
  }

  /**
   * 서비스 시작 - 모든 활성 사용자의 WebSocket 연결
   */
  async start(): Promise<void> {
    if (this.isRunning) {
      console.log('[OrderManager] Already running');
      return;
    }

    console.log('[OrderManager] Starting...');
    this.isRunning = true;

    try {
      // 활성 봇이 있는 사용자 조회
      const activeUsers = await prisma.bot.findMany({
        where: { status: 'running' },
        select: {
          userId: true,
          ticker: true,
          user: {
            select: {
              credentials: {
                where: { exchange: 'upbit' },
                select: { apiKey: true, secretKey: true },
              },
            },
          },
        },
        distinct: ['userId'],
      });

      // 사용자별로 마켓 그룹화
      const userMarkets = new Map<number, Set<string>>();
      for (const bot of activeUsers) {
        if (!userMarkets.has(bot.userId)) {
          userMarkets.set(bot.userId, new Set());
        }
        userMarkets.get(bot.userId)!.add(bot.ticker);
      }

      // 각 사용자별 WebSocket 연결
      for (const bot of activeUsers) {
        if (!bot.user.credentials[0]) continue;

        const credential = bot.user.credentials[0];
        const apiKey = decrypt(credential.apiKey);
        const secretKey = decrypt(credential.secretKey);
        const markets = userMarkets.get(bot.userId) || new Set();

        await this.connectUser(bot.userId, apiKey, secretKey, markets);
      }

      // 주문-봇 매핑 초기화
      await this.initializeOrderMapping();

      console.log(`[OrderManager] Started with ${this.connections.size} user connections`);
    } catch (error: any) {
      console.error('[OrderManager] Failed to start:', error.message);
      this.isRunning = false;
    }
  }

  /**
   * 서비스 중지
   */
  stop(): void {
    console.log('[OrderManager] Stopping...');

    for (const [userId, conn] of this.connections) {
      this.disconnectUser(userId);
    }

    this.connections.clear();
    this.orderToBot.clear();
    this.isRunning = false;

    console.log('[OrderManager] Stopped');
  }

  /**
   * 사용자 WebSocket 연결
   */
  async connectUser(
    userId: number,
    apiKey: string,
    secretKey: string,
    markets: Set<string>
  ): Promise<void> {
    // 기존 연결이 있으면 종료
    if (this.connections.has(userId)) {
      this.disconnectUser(userId);
    }

    const conn: UserConnection = {
      userId,
      ws: null,
      apiKey,
      secretKey,
      isConnected: false,
      reconnectAttempts: 0,
      reconnectTimeout: null,
      pingInterval: null,
      markets,
    };

    this.connections.set(userId, conn);
    this.doConnect(conn);
  }

  /**
   * 사용자 WebSocket 연결 해제
   */
  disconnectUser(userId: number): void {
    const conn = this.connections.get(userId);
    if (!conn) return;

    if (conn.pingInterval) {
      clearInterval(conn.pingInterval);
      conn.pingInterval = null;
    }

    if (conn.reconnectTimeout) {
      clearTimeout(conn.reconnectTimeout);
      conn.reconnectTimeout = null;
    }

    if (conn.ws) {
      conn.ws.close();
      conn.ws = null;
    }

    conn.isConnected = false;
    this.connections.delete(userId);
  }

  /**
   * 봇 시작 시 호출 - 해당 사용자 연결 확인/추가
   */
  async onBotStarted(botId: number, userId: number, ticker: string): Promise<void> {
    const conn = this.connections.get(userId);

    if (conn) {
      // 기존 연결에 마켓 추가
      conn.markets.add(ticker);
      // 구독 갱신
      if (conn.isConnected) {
        this.sendSubscription(conn);
      }
    } else {
      // 새 연결 필요
      const credential = await prisma.credential.findFirst({
        where: { userId, exchange: 'upbit' },
        select: { apiKey: true, secretKey: true },
      });

      if (credential) {
        const apiKey = decrypt(credential.apiKey);
        const secretKey = decrypt(credential.secretKey);
        await this.connectUser(userId, apiKey, secretKey, new Set([ticker]));
      }
    }

    // 봇의 pending 주문 매핑
    const pendingGrids = await prisma.gridLevel.findMany({
      where: { botId, status: 'pending', orderId: { not: null } },
      select: { id: true, orderId: true },
    });

    for (const grid of pendingGrids) {
      if (grid.orderId) {
        this.orderToBot.set(grid.orderId, { botId, gridLevelId: grid.id });
      }
    }
  }

  /**
   * 봇 중지 시 호출
   */
  async onBotStopped(botId: number, userId: number, ticker: string): Promise<void> {
    // 해당 사용자의 다른 봇이 같은 마켓을 사용하는지 확인
    const otherBots = await prisma.bot.findMany({
      where: {
        userId,
        ticker,
        status: 'running',
        id: { not: botId },
      },
    });

    if (otherBots.length === 0) {
      const conn = this.connections.get(userId);
      if (conn) {
        conn.markets.delete(ticker);

        // 마켓이 없으면 연결 종료
        if (conn.markets.size === 0) {
          this.disconnectUser(userId);
        } else if (conn.isConnected) {
          this.sendSubscription(conn);
        }
      }
    }

    // 해당 봇의 주문 매핑 제거
    for (const [orderId, data] of this.orderToBot) {
      if (data.botId === botId) {
        this.orderToBot.delete(orderId);
      }
    }
  }

  /**
   * 새 주문 등록 (주문 실행 시 호출)
   */
  registerOrder(orderId: string, botId: number, gridLevelId: number): void {
    this.orderToBot.set(orderId, { botId, gridLevelId });
  }

  /**
   * 실제 WebSocket 연결 수행
   */
  private doConnect(conn: UserConnection): void {
    try {
      // JWT 토큰 생성
      const token = this.generateToken(conn.apiKey, conn.secretKey);

      conn.ws = new WebSocket(this.WS_URL, {
        headers: {
          Authorization: `Bearer ${token}`,
        },
      });

      conn.ws.on('open', () => {
        console.log(`[OrderManager] User ${conn.userId} connected`);
        conn.isConnected = true;
        conn.reconnectAttempts = 0;

        // 구독 전송
        this.sendSubscription(conn);

        // Ping 시작
        this.startPing(conn);
      });

      conn.ws.on('message', (data: Buffer) => {
        this.handleMessage(conn, data);
      });

      conn.ws.on('close', (code: number) => {
        console.log(`[OrderManager] User ${conn.userId} disconnected: ${code}`);
        conn.isConnected = false;
        this.stopPing(conn);
        this.scheduleReconnect(conn);
      });

      conn.ws.on('error', (error: Error) => {
        console.error(`[OrderManager] User ${conn.userId} error:`, error.message);
        conn.isConnected = false;
      });

    } catch (error: any) {
      console.error(`[OrderManager] User ${conn.userId} connection failed:`, error.message);
      this.scheduleReconnect(conn);
    }
  }

  /**
   * JWT 토큰 생성
   */
  private generateToken(apiKey: string, secretKey: string): string {
    const payload = {
      access_key: apiKey,
      nonce: uuidv4(),
      timestamp: Date.now(),
    };

    return jwt.sign(payload, secretKey);
  }

  /**
   * 구독 메시지 전송
   */
  private sendSubscription(conn: UserConnection): void {
    if (!conn.ws || !conn.isConnected) return;

    const markets = Array.from(conn.markets);
    if (markets.length === 0) return;

    const message = JSON.stringify([
      { ticket: `order-${conn.userId}-${Date.now()}` },
      { type: 'myTrade', codes: markets },
      { format: 'DEFAULT' }
    ]);

    console.log(`[OrderManager] User ${conn.userId} subscribing to ${markets.length} markets`);
    conn.ws.send(message);
  }

  /**
   * 메시지 처리
   */
  private async handleMessage(conn: UserConnection, data: Buffer): Promise<void> {
    try {
      const message = JSON.parse(data.toString());

      // myTrade 메시지 처리
      if (message.type === 'myTrade') {
        await this.handleMyTrade(conn.userId, message as MyTradeData);
      }
    } catch (error: any) {
      // PONG 응답 등은 무시
      const text = data.toString();
      if (text !== 'PONG') {
        console.error(`[OrderManager] User ${conn.userId} parse error:`, error.message);
      }
    }
  }

  /**
   * 체결 알림 처리
   */
  private async handleMyTrade(userId: number, trade: MyTradeData): Promise<void> {
    // 체결 완료된 주문만 처리
    if (trade.state !== 'done') return;

    const orderId = trade.uuid;
    const botData = this.orderToBot.get(orderId);

    if (!botData) {
      // 우리 봇의 주문이 아님 (수동 주문 등)
      return;
    }

    const { botId, gridLevelId } = botData;

    console.log(`[OrderManager] Trade filled: Bot ${botId}, Order ${orderId}, ${trade.ask_bid} ${trade.code} @ ${trade.price}`);

    try {
      // 그리드 레벨 조회
      const grid = await prisma.gridLevel.findUnique({
        where: { id: gridLevelId },
        include: { bot: true },
      });

      if (!grid || grid.status !== 'pending') {
        console.log(`[OrderManager] Grid ${gridLevelId} not found or not pending`);
        return;
      }

      // 체결 처리
      await this.processFilledOrder(userId, grid, trade);

      // 매핑에서 제거
      this.orderToBot.delete(orderId);

    } catch (error: any) {
      console.error(`[OrderManager] Failed to process trade:`, error.message);
    }
  }

  /**
   * 체결된 주문 처리 (TradingService.processFilledOrder와 유사)
   */
  private async processFilledOrder(userId: number, grid: any, trade: MyTradeData): Promise<void> {
    const botId = grid.botId;
    const now = new Date();

    // 그리드 상태 업데이트
    await prisma.gridLevel.update({
      where: { id: grid.id },
      data: {
        status: 'filled',
        filledAt: now,
      },
    });

    // 수익 계산 (매도 체결 시)
    let profit = 0;
    const UPBIT_FEE_RATE = 0.0005;

    if (grid.type === 'sell' && grid.buyPrice) {
      const buyPrice = grid.buyPrice;
      const sellPrice = trade.price;
      const volume = trade.executed_volume;

      const buyAmount = volume * buyPrice;
      const buyFee = buyAmount * UPBIT_FEE_RATE;
      const sellAmount = volume * sellPrice;
      const sellFee = sellAmount * UPBIT_FEE_RATE;

      profit = sellAmount - buyAmount - buyFee - sellFee;
      console.log(`[OrderManager] Bot ${botId}: Sell filled - buy ${buyPrice}, sell ${sellPrice}, profit ${profit.toFixed(2)}`);
    }

    // 봇 통계 업데이트
    await prisma.bot.update({
      where: { id: botId },
      data: {
        totalTrades: { increment: 1 },
        currentProfit: { increment: profit },
      },
    });

    // 월별 수익 기록
    if (grid.type === 'sell' && profit !== 0) {
      await ProfitService.recordProfit(userId, 'upbit', profit);
    }

    // 거래 기록 업데이트
    const tradeRecord = await prisma.trade.findFirst({
      where: { orderId: trade.uuid },
    });

    if (tradeRecord) {
      await prisma.trade.update({
        where: { id: tradeRecord.id },
        data: {
          status: 'filled',
          filledAt: now,
          ...(grid.type === 'sell' && profit !== 0 ? { profit } : {}),
        },
      });

      socketService.emitTradeFilled(botId, {
        id: tradeRecord.id,
        type: grid.type,
        price: tradeRecord.price,
        amount: tradeRecord.amount,
        total: tradeRecord.total,
        profit: profit !== 0 ? profit : undefined,
        status: 'filled',
        filledAt: now,
      });
    }

    // 봇 상태 알림
    const updatedBot = await prisma.bot.findUnique({
      where: { id: botId },
    });

    if (updatedBot) {
      socketService.emitBotUpdate(botId, {
        totalTrades: updatedBot.totalTrades,
        currentProfit: updatedBot.currentProfit,
      });

      // 반대 주문 실행
      if (updatedBot.status === 'running') {
        await this.executeOppositeOrder(userId, updatedBot, grid);
      }
    }
  }

  /**
   * 반대 주문 실행
   */
  private async executeOppositeOrder(userId: number, bot: any, filledGrid: any): Promise<void> {
    // TradingService의 executeOppositeOrder 로직을 재사용
    // 여기서는 사용자의 credential로 Upbit 서비스 초기화
    const conn = this.connections.get(userId);
    if (!conn) return;

    const { UpbitService } = await import('./upbit.service');
    const upbit = new UpbitService({
      accessKey: conn.apiKey,
      secretKey: conn.secretKey,
    });

    console.log(`[OrderManager] Bot ${bot.id}: Executing opposite order - type: ${filledGrid.type}, sellPrice: ${filledGrid.sellPrice}, buyPrice: ${filledGrid.buyPrice}`);

    try {
      if (filledGrid.type === 'buy' && filledGrid.sellPrice) {
        // 매수 체결 → 매도 주문
        const sellPrice = filledGrid.sellPrice;
        const volume = bot.orderAmount / sellPrice;

        const sellGrid = await prisma.gridLevel.findFirst({
          where: {
            botId: bot.id,
            price: { gte: sellPrice - 0.01, lte: sellPrice + 0.01 },
            type: 'sell',
            status: { in: ['inactive', 'filled'] },
          },
        });

        if (!sellGrid) {
          console.log(`[OrderManager] Bot ${bot.id}: Sell grid not found at ${sellPrice}`);
          return;
        }

        const order = await upbit.sellLimit(bot.ticker, sellPrice, volume);

        await GridService.updateGridLevel(sellGrid.id, 'pending', order.uuid);

        const newTrade = await prisma.trade.create({
          data: {
            botId: bot.id,
            gridLevelId: sellGrid.id,
            type: 'sell',
            price: sellPrice,
            amount: volume,
            total: bot.orderAmount,
            orderId: order.uuid,
          },
        });

        // 새 주문 등록
        this.registerOrder(order.uuid, bot.id, sellGrid.id);

        socketService.emitNewTrade(bot.id, {
          id: newTrade.id,
          type: 'sell',
          price: sellPrice,
          amount: volume,
          total: bot.orderAmount,
          orderId: order.uuid,
          status: 'pending',
          createdAt: newTrade.createdAt,
        });

        console.log(`[OrderManager] Bot ${bot.id}: Sell order placed at ${sellPrice}`);

      } else if (filledGrid.type === 'sell' && filledGrid.buyPrice) {
        // 매도 체결 → 매수 주문
        const buyPrice = filledGrid.buyPrice;
        const volume = bot.orderAmount / buyPrice;

        const buyGrid = await prisma.gridLevel.findFirst({
          where: {
            botId: bot.id,
            price: { gte: buyPrice - 0.01, lte: buyPrice + 0.01 },
            type: 'buy',
            status: 'filled',
          },
        });

        if (!buyGrid) {
          console.log(`[OrderManager] Bot ${bot.id}: Buy grid not found at ${buyPrice}`);
          return;
        }

        const order = await upbit.buyLimit(bot.ticker, buyPrice, volume);

        await GridService.updateGridLevel(buyGrid.id, 'pending', order.uuid);

        const newTrade = await prisma.trade.create({
          data: {
            botId: bot.id,
            gridLevelId: buyGrid.id,
            type: 'buy',
            price: buyPrice,
            amount: volume,
            total: bot.orderAmount,
            orderId: order.uuid,
          },
        });

        // 새 주문 등록
        this.registerOrder(order.uuid, bot.id, buyGrid.id);

        socketService.emitNewTrade(bot.id, {
          id: newTrade.id,
          type: 'buy',
          price: buyPrice,
          amount: volume,
          total: bot.orderAmount,
          orderId: order.uuid,
          status: 'pending',
          createdAt: newTrade.createdAt,
        });

        console.log(`[OrderManager] Bot ${bot.id}: Buy order placed at ${buyPrice}`);
      }
    } catch (error: any) {
      console.error(`[OrderManager] Bot ${bot.id}: Opposite order failed -`, error.message);

      await prisma.bot.update({
        where: { id: bot.id },
        data: { errorMessage: `반대 주문 실패: ${error.message}` },
      });

      socketService.emitError(bot.id, {
        type: 'order_failed',
        message: `반대 주문 실패: ${error.message}`,
      });
    }
  }

  /**
   * Ping 시작
   */
  private startPing(conn: UserConnection): void {
    this.stopPing(conn);

    conn.pingInterval = setInterval(() => {
      if (conn.ws && conn.isConnected) {
        try {
          conn.ws.send('PING');
        } catch (error) {
          console.error(`[OrderManager] User ${conn.userId}: Failed to send PING`);
        }
      }
    }, this.PING_INTERVAL);
  }

  /**
   * Ping 중지
   */
  private stopPing(conn: UserConnection): void {
    if (conn.pingInterval) {
      clearInterval(conn.pingInterval);
      conn.pingInterval = null;
    }
  }

  /**
   * 재연결 스케줄링
   */
  private scheduleReconnect(conn: UserConnection): void {
    if (conn.reconnectAttempts >= this.MAX_RECONNECT_ATTEMPTS) {
      console.error(`[OrderManager] User ${conn.userId}: Max reconnect attempts reached`);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, conn.reconnectAttempts), 30000);
    conn.reconnectAttempts++;

    console.log(`[OrderManager] User ${conn.userId}: Reconnecting in ${delay}ms`);

    conn.reconnectTimeout = setTimeout(() => {
      this.doConnect(conn);
    }, delay);
  }

  /**
   * 주문-봇 매핑 초기화
   */
  private async initializeOrderMapping(): Promise<void> {
    const pendingGrids = await prisma.gridLevel.findMany({
      where: {
        status: 'pending',
        orderId: { not: null },
        bot: { status: 'running' },
      },
      select: {
        id: true,
        orderId: true,
        botId: true,
      },
    });

    for (const grid of pendingGrids) {
      if (grid.orderId) {
        this.orderToBot.set(grid.orderId, {
          botId: grid.botId,
          gridLevelId: grid.id,
        });
      }
    }

    console.log(`[OrderManager] Initialized ${this.orderToBot.size} order mappings`);
  }

  /**
   * 상태 조회
   */
  getStatus(): {
    isRunning: boolean;
    connections: number;
    orderMappings: number;
  } {
    return {
      isRunning: this.isRunning,
      connections: this.connections.size,
      orderMappings: this.orderToBot.size,
    };
  }
}

export const orderManager = UpbitOrderManager.getInstance();
