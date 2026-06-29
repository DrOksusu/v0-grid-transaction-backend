// TossService — 토스증권 OpenAPI 클라이언트
// OAuth 2.0 Client Credentials Grant 기반 토큰 발급/캐싱
// TDD RED 단계: 빈 골격만 — 실제 구현은 GREEN 단계 task에서 진행
export class TossService {
  async getAccessToken(_clientId: string, _clientSecret: string): Promise<string> {
    throw new Error('Not implemented');
  }
}
