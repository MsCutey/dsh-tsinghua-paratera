// Bind secret-bearing evaluation to an isolated world of a verified top frame.
// Navigation destroys that execution context, so an OTP/password cannot race
// into a different-origin page or its monkey-patched JavaScript globals.
export async function trustedEvaluate(send, origin, expression) {
  const tree = await send('Page.getFrameTree');
  const frame = tree?.result?.frameTree?.frame;
  let actual;
  try { actual = new URL(frame?.url).origin; } catch {}
  if (actual !== origin || typeof frame?.id !== 'string') throw Error('untrusted-login-page');
  const world = await send('Page.createIsolatedWorld', { frameId: frame.id, worldName: 'dsh-balance-auth', grantUniveralAccess: false });
  const contextId = world?.result?.executionContextId;
  if (!Number.isInteger(contextId)) throw Error('untrusted-login-page');
  const checked = await send('Runtime.evaluate', { contextId, expression: 'location.origin', returnByValue: true });
  if (checked?.result?.result?.value !== origin) throw Error('untrusted-login-page');
  return send('Runtime.evaluate', { contextId, expression, returnByValue: true });
}
