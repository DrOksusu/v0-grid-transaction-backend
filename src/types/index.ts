import { Request } from 'express';

export interface AuthRequest extends Request {
  userId?: number;
}

export interface ApiResponse<T = any> {
  success: boolean;
  message?: string;
  data?: T;
  error?: {
    code: string;
    message: string;
    details?: any;
  };
}

export type Exchange = 'upbit' | 'binance';
export type BotStatus = 'running' | 'stopped' | 'error';
export type GridLevelStatus = 'available' | 'pending' | 'filled';
export type TradeType = 'buy' | 'sell';
