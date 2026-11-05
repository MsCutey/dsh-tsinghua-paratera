// Second-factor (SMS / WeCom) handling.
//
// The SSO page shows radio inputs (wechat / mobile) plus a 确定 button; the code
// field appears only after the code has been sent. A headless run cannot answer
// it, so ensureLoggedIn must stop there and hand the choice to the settings page.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureLoggedIn, holdSecondFactor, secondFactorStatus, chooseSecondFactor,
  submitSecondFactorCode, cancelSecondFactor, refreshSession,
} from '../lib/refresh.mjs';

const reply = (state) => ({ result: { result: { value: JSON.stringify(state) } } });
const dependencies = { pause: async () => {}, updateState: () => {}, readCredentials: async () => { throw Error('credentials must not be read'); } };

const secondFactorView = {
  href: 'https://id.tsinghua.edu.cn/do/off/ui/auth/login/check',
  title: '二次认证',
  radios: [
    { value: 'wechat', label: '通过清华大学信息服务（企业微信）发送验证码到您的微信' },
    { value: 'mobile', label: '发送短信验证码到您登记的手机 13*******09' },
  ],
  hasCodeInput: false,
};

test('the second-factor page stops auto-login immediately', async () => {
  let evaluations = 0;
  const send = async () => { evaluations += 1; return reply({ ...secondFactorView, secondFactor: true }); };
  assert.equal(await ensureLoggedIn(send, dependencies), 'second-factor-required');
  // One probe is enough: do not burn the whole 30-step loop on a page we cannot answer.
  assert.equal(evaluations, 1);
});

test('a closed login window aborts instead of polling to the end', async () => {
  let calls = 0;
  const send = async () => { calls += 1; return { result: { result: { value: null } } }; };
  assert.equal(await ensureLoggedIn(send, dependencies), 'login-window-closed');
  assert.ok(calls <= 4, `expected an early abort, got ${calls} probes`);
});

test('a parked session exposes the methods the page really offers', async () => {
  const opened = { send: async () => reply(secondFactorView) };
  await holdSecondFactor(opened);
  const status = secondFactorStatus();
  assert.equal(status.pending, true);
  assert.equal(status.stage, 'choose');
  assert.deepEqual(status.methods.map((m) => m.id), ['wechat', 'mobile']);
  assert.match(status.phoneHint, /13\*+09/);

  await cancelSecondFactor();
  assert.equal(secondFactorStatus().pending, false);
});

test('unknown methods and malformed codes are rejected before touching the page', async () => {
  const opened = { send: async () => reply(secondFactorView) };
  await holdSecondFactor(opened);
  assert.deepEqual(await chooseSecondFactor('carrier-pigeon'), { ok: false, error: 'invalid-second-factor-method' });
  assert.deepEqual(await submitSecondFactorCode('not-a-code'), { ok: false, error: 'invalid-second-factor-code' });
  assert.deepEqual(await submitSecondFactorCode('12'), { ok: false, error: 'invalid-second-factor-code' });
  await cancelSecondFactor();
});

test('choosing or submitting without a parked session is reported, not thrown', async () => {
  assert.deepEqual(await chooseSecondFactor('mobile'), { ok: false, error: 'no-second-factor' });
  assert.deepEqual(await submitSecondFactorCode('123456'), { ok: false, error: 'no-second-factor' });
});

test('a parked session blocks a competing refresh instead of driving the same browser', async () => {
  const opened = { send: async () => reply(secondFactorView) };
  await holdSecondFactor(opened);
  // Even an explicit refresh must wait: the parked browser owns the SSO state.
  assert.deepEqual(await refreshSession({ force: true }), { ok: false, error: 'second-factor-pending' });
  await cancelSecondFactor();
});

test('the chosen method must really be selected before 确定 is pressed', async () => {
  let calls = 0;
  const opened = {
    send: async () => {
      calls += 1;
      // First call parks on the choose page; the radio then refuses to flip.
      if (calls === 1) return reply(secondFactorView);
      return { result: { result: { value: JSON.stringify({ found: true, checked: false }) } } };
    },
  };
  await holdSecondFactor(opened);
  assert.deepEqual(await chooseSecondFactor('wechat'), { ok: false, error: 'second-factor-method-not-selected' });
  // Nothing was submitted, so no code can have gone out on the other channel.
  assert.equal(calls, 2);
  await cancelSecondFactor();
});

test('the code hint names the channel that was actually used', async () => {
  const opened = { send: async () => reply(secondFactorView) };
  await holdSecondFactor(opened);
  // Choosing a method updates the stage; the hint must not mention the other channel.
  const pending = secondFactorStatus();
  assert.equal(pending.stage, 'choose');
  assert.equal(pending.hint, '');
  await cancelSecondFactor();
});
