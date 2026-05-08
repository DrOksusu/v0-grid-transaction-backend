/**
 * Cloudflare Worker: Upbit 공지 API 릴레이
 *
 * 목적: AWS IP가 Cloudflare WAF에 차단되어 있어, CF Workers의 자체 IP로 우회
 * 엔드포인트: GET /?page=1&per_page=10&category=거래
 *             → https://api-manager.upbit.com/api/v1/announcements?os=web&...
 *
 * 보안: X-Relay-Secret 헤더로 인증 (무단 오픈 릴레이 방지)
 * 배포: wrangler deploy
 *
 * Workers 환경변수 (wrangler secret put):
 *   RELAY_SECRET — 백엔드와 공유하는 임의 문자열
 */

const UPBIT_BASE = 'https://api-manager.upbit.com/api/v1/announcements';

export default {
  async fetch(request, env) {
    // OPTIONS preflight
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }

    // 시크릿 검증 (env.RELAY_SECRET 미설정 시 인증 생략 — 테스트 단계)
    if (env.RELAY_SECRET) {
      const incoming = request.headers.get('X-Relay-Secret') ?? '';
      if (incoming !== env.RELAY_SECRET) {
        return new Response('Forbidden', { status: 403 });
      }
    }

    // 쿼리스트링 그대로 전달 + os=web 추가
    const incomingUrl = new URL(request.url);
    const params = new URLSearchParams(incomingUrl.search);
    params.set('os', 'web');

    const targetUrl = `${UPBIT_BASE}?${params.toString()}`;

    const upbitRes = await fetch(targetUrl, {
      headers: {
        'accept': 'application/json, text/plain, */*',
        'accept-language': 'ko-KR,ko;q=0.9',
        'referer': 'https://upbit.com/',
        'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Mobile/15E148',
      },
    });

    const body = await upbitRes.text();

    return new Response(body, {
      status: upbitRes.status,
      headers: {
        'Content-Type': 'application/json',
        ...corsHeaders(),
      },
    });
  },
};

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'X-Relay-Secret',
  };
}
