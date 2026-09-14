// WalletStatusProvider 파싱 테스트 — 각 거래소 응답 형식 → 정규화 맵 변환 (spec §11)
import {
  parseBinanceWalletConfig,
  parseMexcWalletConfig,
  parseUpbitWalletStatus,
  parseBithumbWalletStatus,
  parseGateioCurrencies,
  normalizeNetwork,
} from '../../src/services/multi-arb-wallet-status.service';

describe('normalizeNetwork', () => {
  it('별칭을 정규화한다 (ERC20→ETH, TRC20→TRX, BEP20→BSC, LISK→LSK)', () => {
    expect(normalizeNetwork('ERC20')).toBe('ETH');
    expect(normalizeNetwork('erc20')).toBe('ETH');
    expect(normalizeNetwork('TRC20')).toBe('TRX');
    expect(normalizeNetwork('BEP20')).toBe('BSC');
    expect(normalizeNetwork('LISK')).toBe('LSK');
    expect(normalizeNetwork('ETH')).toBe('ETH');   // 이미 정규형이면 그대로
    expect(normalizeNetwork('SOL')).toBe('SOL');   // 미등록 네트워크는 대문자 그대로
  });
});

describe('parseBinanceWalletConfig', () => {
  it('networkList를 NetworkStatus[]로 변환한다 (spec §3: LSK=ETH망 실측)', () => {
    const rows = [
      {
        coin: 'LSK',
        networkList: [{ network: 'ETH', depositEnable: true, withdrawEnable: true, withdrawFee: '1.03' }],
      },
      {
        coin: 'BTC',
        networkList: [
          { network: 'BTC', depositEnable: true, withdrawEnable: false },
          { network: 'BSC', depositEnable: false, withdrawEnable: true },
        ],
      },
    ];
    const map = parseBinanceWalletConfig(rows);
    expect(map.get('LSK')).toEqual([{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]);
    expect(map.get('BTC')).toEqual([
      { network: 'BTC', depositEnabled: true, withdrawEnabled: false },
      { network: 'BSC', depositEnabled: false, withdrawEnabled: true },
    ]);
  });
});

describe('parseMexcWalletConfig', () => {
  it('netWork(구 필드명)와 network 둘 다 처리한다', () => {
    const rows = [
      { coin: 'USDT', networkList: [{ netWork: 'TRC20', depositEnable: true, withdrawEnable: true }] },
      { coin: 'ETH', networkList: [{ network: 'ERC20', depositEnable: true, withdrawEnable: false }] },
    ];
    const map = parseMexcWalletConfig(rows);
    expect(map.get('USDT')).toEqual([{ network: 'TRX', depositEnabled: true, withdrawEnabled: true }]);
    expect(map.get('ETH')).toEqual([{ network: 'ETH', depositEnabled: true, withdrawEnabled: false }]);
  });
});

describe('parseUpbitWalletStatus / parseBithumbWalletStatus', () => {
  // spec §3: GET /v1/status/wallet → { currency, net_type, wallet_state, block_state }
  const rows = [
    { currency: 'LSK', net_type: 'LSK', wallet_state: 'working', block_state: 'normal' },
    { currency: 'BTC', net_type: 'BTC', wallet_state: 'withdraw_only', block_state: 'normal' },
    { currency: 'XRP', net_type: 'XRP', wallet_state: 'deposit_only', block_state: 'normal' },
    { currency: 'DOGE', net_type: 'DOGE', wallet_state: 'paused', block_state: 'inactive' },
  ];

  it('wallet_state를 입출금 가능 여부로 변환한다', () => {
    const map = parseUpbitWalletStatus(rows);
    expect(map.get('LSK')).toEqual([{ network: 'LSK', depositEnabled: true, withdrawEnabled: true }]);
    expect(map.get('BTC')).toEqual([{ network: 'BTC', depositEnabled: false, withdrawEnabled: true }]);
    expect(map.get('XRP')).toEqual([{ network: 'XRP', depositEnabled: true, withdrawEnabled: false }]);
    expect(map.get('DOGE')).toEqual([{ network: 'DOGE', depositEnabled: false, withdrawEnabled: false }]);
  });

  it('같은 코인의 멀티 net_type 행을 누적한다 (빗썸 LSK=ETH망 사례)', () => {
    const map = parseBithumbWalletStatus([
      { currency: 'USDT', net_type: 'TRX', wallet_state: 'working' },
      { currency: 'USDT', net_type: 'ETH', wallet_state: 'working' },
      { currency: 'LSK', net_type: 'ETH', wallet_state: 'working' },
    ]);
    expect(map.get('USDT')).toHaveLength(2);
    expect(map.get('LSK')).toEqual([{ network: 'ETH', depositEnabled: true, withdrawEnabled: true }]);
  });
});

describe('parseGateioCurrencies', () => {
  it('chains 배열이 있으면 체인별 상태로 변환한다', () => {
    const rows = [
      {
        currency: 'USDT',
        chains: [
          { name: 'ETH', deposit_disabled: false, withdraw_disabled: false },
          { name: 'TRX', deposit_disabled: true, withdraw_disabled: false },
        ],
      },
    ];
    const map = parseGateioCurrencies(rows);
    expect(map.get('USDT')).toEqual([
      { network: 'ETH', depositEnabled: true, withdrawEnabled: true },
      { network: 'TRX', depositEnabled: false, withdrawEnabled: true },
    ]);
  });

  it('chains가 없으면 chain 단일 필드 + 코인 레벨 disabled 플래그로 변환한다', () => {
    const rows = [{ currency: 'LSK', chain: 'LSK', deposit_disabled: false, withdraw_disabled: true }];
    const map = parseGateioCurrencies(rows);
    expect(map.get('LSK')).toEqual([{ network: 'LSK', depositEnabled: true, withdrawEnabled: false }]);
  });
});
