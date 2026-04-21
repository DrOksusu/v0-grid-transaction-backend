// 암호화/복호화 Mock — 입력값을 그대로 반환
export const encrypt = jest.fn((text: string) => `encrypted_${text}`);
export const decrypt = jest.fn((text: string) => text.replace('encrypted_', ''));
export const maskApiKey = jest.fn((key: string) => '****');
