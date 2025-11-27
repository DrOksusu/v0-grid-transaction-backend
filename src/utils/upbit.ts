import jwt from 'jsonwebtoken';
import { v4 as uuidv4 } from 'uuid';
import axios from 'axios';

const UPBIT_API_BASE_URL = 'https://api.upbit.com';

/**
 * 업비트 API JWT 토큰 생성
 */
export const generateUpbitToken = (accessKey: string, secretKey: string, queryString?: string) => {
  const payload: any = {
    access_key: accessKey,
    nonce: uuidv4(),
  };

  if (queryString) {
    const crypto = require('crypto');
    const hash = crypto.createHash('sha512');
    const queryHash = hash.update(queryString, 'utf-8').digest('hex');

    payload.query_hash = queryHash;
    payload.query_hash_alg = 'SHA512';
  }

  return jwt.sign(payload, secretKey, { algorithm: 'HS256' });
};

/**
 * 업비트 API 키 정보 조회 (만료일 포함)
 */
export const getUpbitApiKeyInfo = async (accessKey: string, secretKey: string) => {
  try {
    const token = generateUpbitToken(accessKey, secretKey);

    const response = await axios.get(`${UPBIT_API_BASE_URL}/v1/api_keys`, {
      headers: {
        Authorization: `Bearer ${token}`,
      },
    });

    return response.data;
  } catch (error: any) {
    console.error('Upbit API error:', error.response?.data || error.message);
    throw new Error(error.response?.data?.error?.message || 'Failed to fetch Upbit API key info');
  }
};
