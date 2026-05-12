// src/services/transfer.service.ts
//
// 거래소 간 코인 이체 서비스.
// 업비트 ↔ 빗썸 간 스테이블코인 이체를 지원한다.
//
// 흐름: prepareTransfer → executeTransfer
// - prepareTransfer: 도착지 입금 주소 조회 + DB에 prepared 상태 저장
// - executeTransfer: fromExchange 출금 실행 + DB 상태 업데이트

import prisma from '../config/database';
import { decrypt } from '../utils/encryption';
import { UpbitService } from './upbit.service';
import { BithumbClient } from './exchange/bithumb-client';

// 이체 지원 코인 목록 (스테이블코인만)
const STABLE_COINS = ['USDT', 'USDC', 'USDS', 'USD1', 'USDE'];

type SupportedExchange = 'upbit' | 'bithumb';

/**
 * 에러 메시지에서 에러 코드를 추출한다.
 * Bithumb/Upbit API 에러 응답 패턴을 파싱하여 분류.
 */
function extractErrorCode(error: any): string {
  const msg: string = (error?.message ?? '').toLowerCase();

  if (msg.includes('withdraw_blocked') || error?.response?.status === 403) {
    return 'withdraw_blocked';
  }
  if (msg.includes('ip_restrict') || msg.includes('ip_whitelist')) {
    return 'ip_restrict';
  }
  if (msg.includes('insufficient') || msg.includes('insufficient_funds')) {
    return 'insufficient_funds';
  }
  if (msg.includes('address_not_registered') || msg.includes('travel_rule')) {
    return 'address_not_registered';
  }
  return 'unknown';
}

/**
 * userId로 특정 거래소의 Credential을 조회하고 복호화하여 반환.
 * 없으면 null 반환 (에러 던지지 않음).
 */
async function getDecryptedCreds(userId: number, exchange: SupportedExchange) {
  const cred = await prisma.credential.findFirst({
    where: { userId, exchange, purpose: 'default' },
  });
  if (!cred) return null;

  return {
    apiKey: decrypt(cred.apiKey),
    secretKey: decrypt(cred.secretKey),
  };
}

export class TransferService {
  /**
   * 두 거래소의 스테이블코인 잔고를 동시에 조회한다.
   * Credential이 없는 거래소는 빈 객체로 반환.
   */
  async getTransferBalances(userId: number): Promise<{
    upbit: Record<string, { available: number; locked: number }>;
    bithumb: Record<string, { available: number; locked: number }>;
  }> {
    const [upbitCreds, bithumbCreds] = await Promise.all([
      getDecryptedCreds(userId, 'upbit'),
      getDecryptedCreds(userId, 'bithumb'),
    ]);

    const [upbitBalances, bithumbBalances] = await Promise.all([
      // 업비트 잔고 조회
      upbitCreds
        ? (async () => {
            try {
              const upbit = new UpbitService({
                accessKey: upbitCreds.apiKey,
                secretKey: upbitCreds.secretKey,
              });
              const accounts: Array<{
                currency: string;
                balance: string;
                locked: string;
              }> = await upbit.getAccounts();

              const result: Record<string, { available: number; locked: number }> = {};
              for (const acc of accounts) {
                const symbol = acc.currency.toUpperCase();
                if (STABLE_COINS.includes(symbol)) {
                  result[symbol] = {
                    available: parseFloat(acc.balance ?? '0'),
                    locked: parseFloat(acc.locked ?? '0'),
                  };
                }
              }
              return result;
            } catch (err) {
              console.error('[Transfer] 업비트 잔고 조회 실패:', err);
              return {} as Record<string, { available: number; locked: number }>;
            }
          })()
        : Promise.resolve({} as Record<string, { available: number; locked: number }>),

      // 빗썸 잔고 조회
      bithumbCreds
        ? (async () => {
            try {
              const bithumb = new BithumbClient({
                accessKey: bithumbCreds.apiKey,
                secretKey: bithumbCreds.secretKey,
              });
              const allBalances = await bithumb.getBalances();

              const result: Record<string, { available: number; locked: number }> = {};
              for (const symbol of STABLE_COINS) {
                if (allBalances[symbol]) {
                  result[symbol] = allBalances[symbol];
                }
              }
              return result;
            } catch (err) {
              console.error('[Transfer] 빗썸 잔고 조회 실패:', err);
              return {} as Record<string, { available: number; locked: number }>;
            }
          })()
        : Promise.resolve({} as Record<string, { available: number; locked: number }>),
    ]);

    return {
      upbit: upbitBalances,
      bithumb: bithumbBalances,
    };
  }

  /**
   * 이체 준비: 도착지 입금 주소 조회 + DB에 prepared 상태로 저장.
   * fromExchange에서 toExchange로 currency를 이체할 준비를 한다.
   */
  async prepareTransfer(
    userId: number,
    params: {
      fromExchange: SupportedExchange;
      toExchange: SupportedExchange;
      currency: string;
      netType: string;
      amount: string;
    }
  ): Promise<{
    transferId: number;
    destAddress: string;
    secondaryAddress?: string;
    expectedFee: string;
    minWithdraw: string;
  }> {
    const { fromExchange, toExchange, currency, netType, amount } = params;

    if (fromExchange === toExchange) {
      throw new Error('출발지와 도착지 거래소가 동일합니다');
    }

    if (!STABLE_COINS.includes(currency.toUpperCase())) {
      throw new Error(`지원하지 않는 코인입니다: ${currency}`);
    }

    // 도착지(toExchange) 입금 주소 조회
    const toCreds = await getDecryptedCreds(userId, toExchange);
    if (!toCreds) {
      throw new Error(`${toExchange} API 키가 등록되어 있지 않습니다`);
    }

    let destAddress: string;
    let secondaryAddress: string | undefined;

    if (toExchange === 'upbit') {
      const upbit = new UpbitService({
        accessKey: toCreds.apiKey,
        secretKey: toCreds.secretKey,
      });
      const addrData = await upbit.getDepositAddress(currency.toUpperCase(), netType);
      if (!addrData?.deposit_address) {
        throw new Error(`${toExchange} 입금 주소 조회 실패`);
      }
      destAddress = addrData.deposit_address;
      secondaryAddress = addrData.secondary_address ?? undefined;
    } else {
      // toExchange === 'bithumb'
      const bithumb = new BithumbClient({
        accessKey: toCreds.apiKey,
        secretKey: toCreds.secretKey,
      });
      const addrData = await bithumb.getDepositAddress(currency.toUpperCase(), netType);
      if (!addrData?.deposit_address) {
        throw new Error(`${toExchange} 입금 주소 조회 실패`);
      }
      destAddress = addrData.deposit_address;
      secondaryAddress = addrData.secondary_address ?? undefined;
    }

    // 출발지(fromExchange) 출금 가능 정보 조회 (수수료, 최소 출금액)
    const fromCreds = await getDecryptedCreds(userId, fromExchange);
    if (!fromCreds) {
      throw new Error(`${fromExchange} API 키가 등록되어 있지 않습니다`);
    }

    let expectedFee: string;
    let minWithdraw: string;

    if (fromExchange === 'upbit') {
      const upbit = new UpbitService({
        accessKey: fromCreds.apiKey,
        secretKey: fromCreds.secretKey,
      });
      const chanceData = await upbit.getWithdrawChance(currency.toUpperCase(), netType);
      // Upbit 응답 필드명: currency.withdraw_fee / withdraw_limit.minimum / member_level.wallet_locked
      expectedFee = chanceData?.currency?.withdraw_fee ?? '0';
      minWithdraw = chanceData?.withdraw_limit?.minimum ?? '0';

      // 출금 잠금 여부 확인 (member_level.wallet_locked)
      if (chanceData?.member_level?.wallet_locked) {
        throw new Error('출금이 잠겨 있습니다. 업비트 출금 제한을 확인하세요');
      }
    } else {
      // fromExchange === 'bithumb'
      const bithumb = new BithumbClient({
        accessKey: fromCreds.apiKey,
        secretKey: fromCreds.secretKey,
      });
      const chanceData = await bithumb.getWithdrawChance(currency.toUpperCase(), netType);
      expectedFee = chanceData.fee;
      minWithdraw = chanceData.minimum_amount;
    }

    // 최소 출금액 검증
    if (parseFloat(amount) < parseFloat(minWithdraw)) {
      throw new Error(
        `최소 출금액(${minWithdraw} ${currency}) 미만입니다. 요청 금액: ${amount}`
      );
    }

    // DB에 prepared 상태로 저장
    const transfer = await prisma.coinTransfer.create({
      data: {
        userId,
        fromExchange,
        toExchange,
        currency: currency.toUpperCase(),
        netType,
        amount: amount,
        fee: expectedFee,
        destAddress,
        secondaryAddress: secondaryAddress ?? null,
        state: 'prepared',
      },
    });

    return {
      transferId: transfer.id,
      destAddress,
      secondaryAddress,
      expectedFee,
      minWithdraw,
    };
  }

  /**
   * 이체 실행: prepared → executing → requested/failed.
   * 동시 실행 방지를 위해 updateMany로 원자적 상태 전환.
   */
  async executeTransfer(userId: number, transferId: number): Promise<any> {
    // 원자적으로 prepared → executing 전환 (중복 실행 방지)
    const updated = await prisma.coinTransfer.updateMany({
      where: { id: transferId, userId, state: 'prepared' },
      data: { state: 'executing' },
    });

    if (updated.count === 0) {
      throw new Error('이미 처리된 이체입니다 (state != prepared)');
    }

    // 이체 정보 조회
    const transfer = await prisma.coinTransfer.findUnique({
      where: { id: transferId },
    });

    if (!transfer) {
      throw new Error('이체 정보를 찾을 수 없습니다');
    }

    const fromExchange = transfer.fromExchange as SupportedExchange;
    const fromCreds = await getDecryptedCreds(userId, fromExchange);
    if (!fromCreds) {
      await prisma.coinTransfer.update({
        where: { id: transferId },
        data: {
          state: 'failed',
          errorCode: 'no_credential',
          errorMessage: `${fromExchange} API 키가 등록되어 있지 않습니다`,
        },
      });
      throw new Error(`${fromExchange} API 키가 등록되어 있지 않습니다`);
    }

    try {
      let withdrawResult: { uuid: string };

      if (fromExchange === 'upbit') {
        const upbit = new UpbitService({
          accessKey: fromCreds.apiKey,
          secretKey: fromCreds.secretKey,
        });
        withdrawResult = await upbit.withdrawCoin({
          currency: transfer.currency,
          net_type: transfer.netType,
          amount: transfer.amount.toString(),
          address: transfer.destAddress,
          secondary_address: transfer.secondaryAddress ?? undefined,
        });
      } else {
        // fromExchange === 'bithumb'
        const bithumb = new BithumbClient({
          accessKey: fromCreds.apiKey,
          secretKey: fromCreds.secretKey,
        });
        withdrawResult = await bithumb.withdrawCoin({
          currency: transfer.currency,
          net_type: transfer.netType,
          amount: transfer.amount.toString(),
          address: transfer.destAddress,
          secondary_address: transfer.secondaryAddress ?? undefined,
        });
      }

      // 출금 성공: requested 상태로 업데이트
      const result = await prisma.coinTransfer.update({
        where: { id: transferId },
        data: {
          state: 'requested',
          srcWithdrawUuid: withdrawResult.uuid,
          executedAt: new Date(),
        },
      });

      return result;
    } catch (err: any) {
      const errorCode = extractErrorCode(err);
      const errorMessage = err?.message ?? '알 수 없는 오류';

      // 출금 실패: failed 상태로 업데이트
      await prisma.coinTransfer.update({
        where: { id: transferId },
        data: {
          state: 'failed',
          errorCode,
          errorMessage,
        },
      });

      throw new Error(`출금 실패 (${errorCode}): ${errorMessage}`);
    }
  }

  /**
   * 이체 이력 목록 조회 (최신순 50건).
   */
  async listTransfers(userId: number): Promise<any[]> {
    return prisma.coinTransfer.findMany({
      where: { userId },
      orderBy: { preparedAt: 'desc' },
      take: 50,
    });
  }
}
