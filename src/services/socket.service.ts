import { Server as SocketServer, Socket } from 'socket.io';
import { Server as HttpServer } from 'http';

class SocketService {
  private io: SocketServer | null = null;
  private botRooms: Map<string, Set<string>> = new Map(); // botId -> Set of socket ids

  initialize(httpServer: HttpServer) {
    this.io = new SocketServer(httpServer, {
      cors: {
        origin: process.env.CORS_ORIGIN || 'http://localhost:3000',
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

      // 연결 해제
      socket.on('disconnect', () => {
        console.log(`[Socket] Client disconnected: ${socket.id}`);

        // 모든 방에서 제거
        this.botRooms.forEach((sockets, botId) => {
          sockets.delete(socket.id);
        });
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
}

export const socketService = new SocketService();
