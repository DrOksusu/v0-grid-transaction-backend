import prisma from '../config/database';
import { CredentialPurpose } from '@prisma/client';

/**
 * purpose별 KIS credential 조회 (폴백 로직 포함)
 * 1. 지정된 purpose의 credential 조회
 * 2. 없으면 'default' credential로 폴백
 */
export async function getKisCredential(
  userId: number,
  purpose: CredentialPurpose = 'default'
) {
  // 1. 지정된 purpose로 조회
  let credential = await prisma.credential.findFirst({
    where: { userId, exchange: 'kis', purpose },
  });

  // 2. 폴백: default credential 조회
  if (!credential && purpose !== 'default') {
    credential = await prisma.credential.findFirst({
      where: { userId, exchange: 'kis', purpose: 'default' },
    });
  }

  return credential;
}

/**
 * 특정 계좌번호에 해당하는 credential 조회
 */
export async function getKisCredentialByAccountNo(
  userId: number,
  accountNo: string
) {
  return prisma.credential.findFirst({
    where: { userId, exchange: 'kis', accountNo },
  });
}

/**
 * 사용자의 모든 KIS credentials 조회
 */
export async function getAllKisCredentials(userId: number) {
  return prisma.credential.findMany({
    where: { userId, exchange: 'kis' },
    orderBy: { purpose: 'asc' },  // default, infinite_buy, vr 순
  });
}

/**
 * 특정 purpose의 credential 조회 (폴백 없음)
 */
export async function getKisCredentialByPurpose(
  userId: number,
  purpose: CredentialPurpose
) {
  return prisma.credential.findFirst({
    where: { userId, exchange: 'kis', purpose },
  });
}
