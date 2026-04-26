describe('config/env ADMIN_EMAIL 검증', () => {
  // Jest 모듈 캐시 격리를 위한 헬퍼
  const loadEnvModule = (envOverrides: Record<string, string | undefined>) => {
    jest.resetModules();

    // dotenv.config를 mock으로 대체 (실제 .env 파일을 읽지 않음)
    jest.doMock('dotenv', () => ({
      config: jest.fn(),
    }));

    const original: Record<string, string | undefined> = {};

    // 오버라이드 전에 원래값 저장
    for (const k of Object.keys(envOverrides)) {
      original[k] = process.env[k];
      if (envOverrides[k] === undefined) {
        delete process.env[k];
      } else {
        process.env[k] = envOverrides[k] as string;
      }
    }

    try {
      return require('../../src/config/env');
    } finally {
      // 복원
      for (const k of Object.keys(original)) {
        if (original[k] === undefined) delete process.env[k];
        else process.env[k] = original[k];
      }
      jest.dontMock('dotenv');
    }
  };

  it('ADMIN_EMAIL 미설정 시 require에서 throw 한다', () => {
    expect(() => loadEnvModule({ ADMIN_EMAIL: undefined })).toThrow(/ADMIN_EMAIL/);
  });

  it('ADMIN_EMAIL 설정 시 config.adminEmail 로 노출된다', () => {
    const mod = loadEnvModule({ ADMIN_EMAIL: 'admin@example.com' });
    expect(mod.config.adminEmail).toBe('admin@example.com');
  });
});
