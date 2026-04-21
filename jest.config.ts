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
};

export default config;
