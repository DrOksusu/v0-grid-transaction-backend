import { decideAction, buildEmergencyMessage } from '../../src/services/inventory-arb.service';

describe('decideAction', () => {
  const bot = { enabled: true, killSwitch: false, autoExecute: true };

  it('killSwitch면 skip', () => {
    expect(decideAction({ ...bot, killSwitch: true }).action).toBe('skip');
  });
  it('enabled=false면 skip', () => {
    expect(decideAction({ ...bot, enabled: false }).action).toBe('skip');
  });
  it('autoExecute=true면 execute', () => {
    expect(decideAction(bot).action).toBe('execute');
  });
  it('autoExecute=false면 notify (반자동 = 알림만)', () => {
    expect(decideAction({ ...bot, autoExecute: false }).action).toBe('notify');
  });
});

describe('buildEmergencyMessage', () => {
  it('flatten_failed 정보를 포함', () => {
    const msg = buildEmergencyMessage('XRP', 4, 'net long but ...');
    expect(msg).toContain('XRP');
    expect(msg).toContain('killSwitch');
  });
});
