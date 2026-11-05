// Second-factor (SMS / WeCom) handling.
//
// The SSO page shows radio inputs (wechat / mobile) plus a 确定 button; the code
// field appears only after the code has been sent. A headless run cannot answer
// it, so ensureLoggedIn must stop there and hand the choice to the settings page.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ensureLoggedIn, holdSecondFactor, secondFactorStatus, chooseSecondFactor,
  submitSecondFactorCode, cancelSecondFactor,
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
