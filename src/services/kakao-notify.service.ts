// 카카오 나에게 보내기 — OAuth 토큰 관리 + 메시지 발송
import axios from 'axios';
import { config } from '../config/env';
import prisma from '../config/database';

class KakaoNotifyService {
  /** OAuth 인증 URL 반환 (관리자가 한 번 방문하여 승인) */
  getAuthUrl(): string {
    const params = new URLSearchParams({
      client_id: config.kakao.restApiKey,
      redirect_uri: config.kakao.redirectUri,
      response_type: 'code',
      scope: 'talk_message',
    });
    return `https://kauth.kakao.com/oauth/authorize?${params.toString()}`;
  }

  /** OAuth 콜백에서 code 수령 → access/refresh 토큰 교환 후 DB 저장 */
  async exchangeCode(code: string): Promise<void> {
    const params = new URLSearchParams({
      grant_type: 'authorization_code',
      client_id: config.kakao.restApiKey,
      redirect_uri: config.kakao.redirectUri,
      code,
      client_secret: config.kakao.clientSecret,
    });
    const res = await axios.post('https://kauth.kakao.com/oauth/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    await this.saveTokens(res.data.access_token, res.data.refresh_token, res.data.expires_in);
    console.log('[KakaoNotify] 토큰 발급 완료 (expires_in:', res.data.expires_in, 's)');
  }

  /** access_token 반환 (만료 5분 전이면 자동 갱신) */
  async getValidAccessToken(): Promise<string> {
    const token = await this.getStoredToken();
    if (!token) throw new Error('카카오 토큰 없음 — /admin/btc-rsi 에서 카카오 연결 필요');

    const fiveMinFromNow = new Date(Date.now() + 5 * 60 * 1000);
    if (token.expiresAt > fiveMinFromNow) {
      return token.accessToken;
    }

    // access_token 만료 임박 → refresh_token으로 갱신
    return this.refreshAccessToken(token.refreshToken);
  }

  /** 나에게 보내기 */
  async sendToMe(message: string): Promise<void> {
    const accessToken = await this.getValidAccessToken();
    const template = {
      object_type: 'text',
      text: message,
      link: {
        web_url: 'https://koco.me',
        mobile_web_url: 'https://koco.me',
      },
    };
    await axios.post(
      'https://kapi.kakao.com/v2/api/talk/memo/default/send',
      `template_object=${encodeURIComponent(JSON.stringify(template))}`,
      {
        headers: {
          Authorization: `Bearer ${accessToken}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        timeout: 10000,
      },
    );
    console.log('[KakaoNotify] 메시지 발송 완료');
  }

  /** 토큰 상태 조회 */
  async getStatus(): Promise<{ hasToken: boolean; expiresAt: Date | null; isValid: boolean }> {
    const token = await this.getStoredToken();
    if (!token) return { hasToken: false, expiresAt: null, isValid: false };
    return {
      hasToken: true,
      expiresAt: token.expiresAt,
      isValid: token.expiresAt > new Date(),
    };
  }

  private async refreshAccessToken(refreshToken: string): Promise<string> {
    const params = new URLSearchParams({
      grant_type: 'refresh_token',
      client_id: config.kakao.restApiKey,
      refresh_token: refreshToken,
      client_secret: config.kakao.clientSecret,
    });
    const res = await axios.post('https://kauth.kakao.com/oauth/token', params.toString(), {
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      timeout: 10000,
    });
    const newRefresh = res.data.refresh_token ?? refreshToken;
    await this.saveTokens(res.data.access_token, newRefresh, res.data.expires_in);
    console.log('[KakaoNotify] 액세스 토큰 갱신 완료');
    return res.data.access_token;
  }

  private async saveTokens(accessToken: string, refreshToken: string, expiresIn: number): Promise<void> {
    const expiresAt = new Date(Date.now() + expiresIn * 1000);
    await (prisma as any).kakaoToken.upsert({
      where: { id: 1 },
      create: { accessToken, refreshToken, expiresAt },
      update: { accessToken, refreshToken, expiresAt },
    });
  }

  private async getStoredToken() {
    return (prisma as any).kakaoToken.findUnique({ where: { id: 1 } });
  }
}

export const kakaoNotifyService = new KakaoNotifyService();
