/**
 * 최근 업비트 KRW 마켓 기준으로 바이낸스/바이빗/MEXC/빗썸 가격 수집 테스트
 * 실행: npx ts-node --compiler-options '{"module":"commonjs"}' scripts/seed-upbit-listings.ts
 *
 * 업비트 notices API가 공개되지 않아 아래 방식으로 대체:
 *  1. 업비트 KRW 마켓 전체 조회
 *  2. 바이낸스 스팟 마켓과 교차 확인 → 양쪽 다 있는 코인 목록 추출
 *  3. 테스트할 코인을 직접 지정하거나 최근 추가된 코인을 수동 입력
 */

import axios from 'axios';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ── 테스트할 최근 업비트 상장 코인 (수동 지정) ──────────────────────────────
// 최근에 업비트에 상장된 코인 티커를 직접 입력합니다.
// 업비트 공지 페이지(https://upbit.com/service_center/notice)에서 확인 후 추가하세요.
const TEST_LISTINGS: Array<{ ticker: string; title: string; noticeId: number }> = [
  { ticker: 'BERA',   title: '업비트 원화(KRW) 마켓 베라체인(BERA) 추가 안내',    noticeId: 90001 },
  { ticker: 'SIGN',   title: '업비트 원화(KRW) 마켓 사인(SIGN) 추가 안내',        noticeId: 90002 },
  { ticker: 'LAYER',  title: '업비트 원화(KRW) 마켓 레이어(LAYER) 추가 안내',     noticeId: 90003 },
  { ticker: 'IP',     title: '업비트 원화(KRW) 마켓 스토리(IP) 추가 안내',        noticeId: 90004 },
  { ticker: 'PARTI',  title: '업비트 원화(KRW) 마켓 파티클네트워크(PARTI) 추가',  noticeId: 90005 },
];
// ────────────────────────────────────────────────────────────────────────────

async function fetchBinance(ticker: string) {
  try {
    const r = await axios.get(`https://api.binance.com/api/v3/ticker/24hr?symbol=${ticker}USDT`, { timeout: 6000 });
    return { exchange: 'binance', price: parseFloat(r.data.lastPrice), volume24h: parseFloat(r.data.quoteVolume) };
  } catch { return { exchange: 'binance', price: null as null, volume24h: null as null }; }
}

async function fetchBybit(ticker: string) {
  try {
    const r = await axios.get(`https://api.bybit.com/v5/market/tickers?category=spot&symbol=${ticker}USDT`, { timeout: 6000 });
    const item = r.data?.result?.list?.[0];
    if (!item) return { exchange: 'bybit', price: null as null, volume24h: null as null };
    return { exchange: 'bybit', price: parseFloat(item.lastPrice), volume24h: parseFloat(item.turnover24h) };
  } catch { return { exchange: 'bybit', price: null as null, volume24h: null as null }; }
}

async function fetchMexc(ticker: string) {
  try {
    const r = await axios.get(`https://api.mexc.com/api/v3/ticker/24hr?symbol=${ticker}USDT`, { timeout: 6000 });
    return { exchange: 'mexc', price: parseFloat(r.data.lastPrice), volume24h: parseFloat(r.data.quoteVolume) };
  } catch { return { exchange: 'mexc', price: null as null, volume24h: null as null }; }
}

async function fetchBithumb(ticker: string) {
  try {
    const r = await axios.get(`https://api.bithumb.com/public/ticker/${ticker}_KRW`, { timeout: 6000 });
    if (r.data?.status !== '0000') return { exchange: 'bithumb', price: null as null, volume24h: null as null };
    return { exchange: 'bithumb', price: parseFloat(r.data.data.closing_price), volume24h: parseFloat(r.data.data.acc_trade_value_24H) };
  } catch { return { exchange: 'bithumb', price: null as null, volume24h: null as null }; }
}

async function fetchAllPrices(ticker: string) {
  const results = await Promise.allSettled([
    fetchBinance(ticker), fetchBybit(ticker), fetchMexc(ticker), fetchBithumb(ticker),
  ]);
  return results.map(r => r.status === 'fulfilled' ? r.value : { exchange: '?', price: null as null, volume24h: null as null });
}

async function main() {
  console.log('=== 업비트 상장 코인 가격 시드 스크립트 ===\n');

  // 1. 업비트 KRW 마켓 목록 확인
  let upbitKrwTickers = new Set<string>();
  try {
    const r = await axios.get('https://api.upbit.com/v1/market/all?isDetails=false', { timeout: 8000 });
    upbitKrwTickers = new Set(
      (r.data as any[])
        .filter(m => m.market.startsWith('KRW-'))
        .map(m => m.market.replace('KRW-', '') as string)
    );
    console.log(`업비트 KRW 마켓: ${upbitKrwTickers.size}개`);
  } catch (e) {
    console.warn('업비트 마켓 목록 조회 실패:', e);
  }

  for (const listing of TEST_LISTINGS) {
    const { ticker, title, noticeId } = listing;
    const onUpbit = upbitKrwTickers.has(ticker);

    console.log(`\n────────────────────────────────────`);
    console.log(`티커: ${ticker} | 업비트 KRW 마켓: ${onUpbit ? '✅ 있음' : '❌ 없음'}`);
    console.log(`공지: ${title}`);

    // 2. DB 중복 확인 (raw SQL — prisma generate 미실행 환경 대응)
    const existingRows = await prisma.$queryRawUnsafe<any[]>(
      'SELECT id FROM upbit_listing_announcements WHERE noticeId = ? LIMIT 1', noticeId
    );
    let announcementId: number;

    if (existingRows.length > 0) {
      console.log(`  → 이미 DB에 있음 (id=${existingRows[0].id})`);
      announcementId = existingRows[0].id;
    } else {
      const url = `https://upbit.com/service_center/notice?id=${noticeId}`;
      const listedAt = onUpbit ? new Date().toISOString().slice(0, 19).replace('T', ' ') : null;
      await prisma.$executeRawUnsafe(
        `INSERT INTO upbit_listing_announcements (noticeId, title, ticker, url, status, listedAt, announcedAt)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        noticeId, title, ticker, url, onUpbit ? 'listed' : 'announced', listedAt
      );
      const newRows = await prisma.$queryRawUnsafe<any[]>(
        'SELECT id FROM upbit_listing_announcements WHERE noticeId = ? LIMIT 1', noticeId
      );
      announcementId = newRows[0].id;
      console.log(`  → DB 저장 완료 (id=${announcementId})`);
    }

    // 3. 가격 조회
    console.log(`  거래소 가격 조회 중...`);
    const prices = await fetchAllPrices(ticker);

    const rows: string[] = [];
    const toInsert: any[] = [];

    for (const p of prices) {
      if (p.price !== null && !isNaN(p.price) && p.price > 0) {
        rows.push(`    ${p.exchange.padEnd(8)}: $${p.price} (vol: ${p.volume24h?.toLocaleString('en-US', { maximumFractionDigits: 0 }) ?? 'N/A'})`);
        toInsert.push({
          announcementId,
          exchange: p.exchange,
          price: p.price,
          volume24h: p.volume24h !== null && !isNaN(p.volume24h) ? p.volume24h : null,
          snapshotType: 'announced',
        });
      } else {
        rows.push(`    ${p.exchange.padEnd(8)}: ❌ 데이터 없음 (미상장)`);
      }
    }

    rows.forEach(r => console.log(r));

    if (toInsert.length > 0) {
      for (const row of toInsert) {
        await prisma.$executeRawUnsafe(
          `INSERT INTO listing_price_snapshots (announcementId, exchange, price, volume24h, snapshotType, recordedAt)
           VALUES (?, ?, ?, ?, ?, NOW())`,
          row.announcementId, row.exchange, row.price.toString(), row.volume24h?.toString() ?? null, row.snapshotType
        );
      }
      console.log(`  → ${toInsert.length}개 거래소 스냅샷 저장`);
    } else {
      console.log(`  → 어느 거래소에도 가격 없음`);
    }
  }

  console.log('\n=== 완료 ===\n');
  console.log('Admin 페이지 /admin/upbit-listings 에서 확인하세요.');
}

main()
  .catch(e => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
