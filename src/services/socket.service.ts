import { Server as SocketServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';

// 가격 데이터 인터페이스
interface PriceData {
  ticker: string;
  price: number;
  change24h: number;
  volume24h: number;
  timestamp: number;
}

class SocketService {
  private io: SocketServer | null = null;
  private botRooms: Map<string, Set<string>> = new Map(); // botId -> Set of socket ids
  private priceSubscribers: Set<string> = new Set(); // 가격 구독자 socket ids

  initialize(httpServer: HttpServer) {
    // CORS 설정: 쉼표로 구분된 여러 도메인 허용
    const allowedOrigins = (process.env.CORS_ORIGIN || 'http://localhost:3000')
      .split(',')
      .map(origin => origin.trim());

    this.io = new SocketServer(httpServer, {
      cors: {
        origin: allowedOrigins,
        methods: ['GET', 'POST'],
        credentials: true,
      },
    });

    this.io.on('connection', (socket: Socket) => {
      console.log(`[Socket] Client connected: ${socket.id}`);

      // 봇 방 구독
      socket.on('subscribe:bot', (botId: string) => {
        const room = `bot:${botId}`;
        socket.join(room);

        if (!this.botRooms.has(botId)) {
          this.botRooms.set(botId, new Set());
        }
        this.botRooms.get(botId)!.add(socket.id);

        console.log(`[Socket] ${socket.id} subscribed to bot ${botId}`);
      });

      // 봇 방 구독 해제
      socket.on('unsubscribe:bot', (botId: string) => {
        const room = `bot:${botId}`;
        socket.leave(room);

        if (this.botRooms.has(botId)) {
          this.botRooms.get(botId)!.delete(socket.id);
        }

        console.log(`[Socket] ${socket.id} unsubscribed from bot ${botId}`);
      });

      // 가격 구독 (대시보드용)
      socket.on('subscribe:prices', () => {
        socket.join('prices');
        this.priceSubscribers.add(socket.id);
        console.log(`[Socket] ${socket.id} subscribed to prices (total: ${this.priceSubscribers.size})`);
      });

      // 가격 구독 해제
      socket.on('unsubscribe:prices', () => {
        socket.leave('prices');
        this.priceSubscribers.delete(socket.id);
        console.log(`[Socket] ${socket.id} unsubscribed from prices`);
      });

      // 연결 해제
      socket.on('disconnect', () => {
        console.log(`[Socket] Client disconnected: ${socket.id}`);

        // 모든 방에서 제거
        this.botRooms.forEach((sockets, botId) => {
          sockets.delete(socket.id);
        });

        // 가격 구독자에서도 제거
        this.priceSubscribers.delete(socket.id);
      });
    });

    console.log('[Socket] Socket.IO server initialized');
  }

  // 새로운 거래 이벤트 전송
  emitNewTrade(botId: number, trade: {
    id: number;
    type: 'buy' | 'sell';
    price: number;
    amount: number;
    total: number;
    orderId: string | null;
    status: string;
    createdAt: Date;
    filledAt?: Date | null;
  }) {
    if (!this.io) {
      console.warn('[Socket] Socket.IO not initialized');
      return;
    }

    const room = `bot:${botId}`;
    this.io.to(room).emit('trade:new', {
      botId,
      trade: {
        id: trade.id.toString(),
        time: trade.createdAt.toISOString(),
        type: trade.type,
        price: trade.price,
        amount: trade.amount,
        total: trade.total,
        orderId: trade.orderId,
        status: trade.status,
      },
    });

    console.log(`[Socket] Emitted new trade to bot ${botId}`);
  }

  // 거래 체결 완료 이벤트 전송
  emitTradeFilled(botId: number, trade: {
    id: number;
    type: 'buy' | 'sell';
    price: number;
    amount: number;
    total: number;
    profit?: number;
    status: string;
    filledAt: Date;
  }) {
    if (!this.io) {
      console.warn('[Socket] Socket.IO not initialized');
      return;
    }

    const room = `bot:${botId}`;
    this.io.to(room).emit('trade:filled', {
      botId,
      trade: {
        id: trade.id.toString(),
        time: trade.filledAt.toISOString(),
        type: trade.type,
        price: trade.price,
        amount: trade.amount,
        total: trade.total,
        profit: trade.profit,
        status: trade.status,
      },
    });

    console.log(`[Socket] Emitted trade filled to bot ${botId}`);
  }

  // 봇 상태 업데이트 이벤트 전송
  emitBotUpdate(botId: number, data: {
    status?: string;
    currentProfit?: number;
    totalTrades?: number;
    currentPrice?: number;
  }) {
    if (!this.io) {
      console.warn('[Socket] Socket.IO not initialized');
      return;
    }

    const room = `bot:${botId}`;
    this.io.to(room).emit('bot:update', {
      botId,
      ...data,
    });
  }

  // 에러 알림 이벤트 전송
  emitError(botId: number, error: {
    type: 'order_failed' | 'api_error' | 'system_error';
    message: string;
    details?: string;
  }) {
    if (!this.io) {
      console.warn('[Socket] Socket.IO not initialized');
      return;
    }

    const room = `bot:${botId}`;
    this.io.to(room).emit('bot:error', {
      botId,
      error: {
        ...error,
        timestamp: new Date().toISOString(),
      },
    });

    console.log(`[Socket] Emitted error to bot ${botId}: ${error.message}`);
  }

  getIO() {
    return this.io;
  }

  // 가격 업데이트 브로드캐스트 (단일 티커)
  emitPriceUpdate(ticker: string, data: {
    price: number;
    change24h: number;
    volume24h: number;
    high24h?: number;
    low24h?: number;
  }) {
    if (!this.io || this.priceSubscribers.size === 0) {
      return;
    }

    this.io.to('prices').emit('price:update', {
      ticker,
      ...data,
      timestamp: Date.now(),
    });
  }

  // 여러 가격 일괄 브로드캐스트
  emitPricesBatch(prices: Array<{
    ticker: string;
    price: number;
    change24h: number;
    volume24h: number;
  }>) {
    if (!this.io || this.priceSubscribers.size === 0) {
      return;
    }

    this.io.to('prices').emit('prices:batch', {
      prices,
      timestamp: Date.now(),
    });
  }

  // 가격 구독자 수
  getPriceSubscribersCount(): number {
    return this.priceSubscribers.size;
  }
}

export const socketService = new SocketService();
