import { Request, Response, NextFunction } from 'express';
import axios from 'axios';

export class AppError extends Error {
  statusCode: number;
  isOperational: boolean;

  constructor(message: string, statusCode: number) {
    super(message);
    this.statusCode = statusCode;
    this.isOperational = true;

    Error.captureStackTrace(this, this.constructor);
  }
}

export const errorHandler = (
  err: Error,
  req: Request,
  res: Response,
  next: NextFunction
) => {
  if (err instanceof AppError) {
    return res.status(err.statusCode).json({
      status: 'error',
      message: err.message,
    });
  }

  // axios 오류는 통째로 찍으면 요청 본문·헤더·URL의 비밀값(client_secret, 토큰)이 로그에 남으므로 응답만 요약
  if (axios.isAxiosError(err)) {
    console.error('ERROR (외부 API):', err.response?.status ?? err.code, JSON.stringify(err.response?.data ?? null).slice(0, 500));
  } else {
    console.error('ERROR:', err);
  }

  return res.status(500).json({
    status: 'error',
    message: process.env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message,
    error: process.env.NODE_ENV === 'production'
      ? undefined
      : err.stack,
  });
};
