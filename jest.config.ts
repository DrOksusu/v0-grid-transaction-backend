import type { Config } from 'jest';

const config: Config = {
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  moduleFileExtensions: ['ts', 'js', 'json'],
  transform: {
    '^.+\\.ts$': ['ts-jest', { tsconfig: 'tsconfig.test.json' }],
  },
  // src/ 내부 모듈 import 경로 매핑
  moduleNameMapper: {
    '^../config/database$': '<rootDir>/__mocks__/database.ts',
    '^../utils/encryption$': '<rootDir>/__mocks__/encryption.ts',
  },
  // 테스트 타임아웃 10초
  testTimeout: 10000,
  // 커버리지 설정
  collectCoverageFrom: ['src/services/**/*.ts'],
  coverageDirectory: 'coverage',
  // 모든 테스트 실행 전 환경변수 주입 (ADMIN_EMAIL 등)
  setupFiles: ['<rootDir>/__tests__/jest.setup.ts'],
};

export default config;
