/**
 * Explicit opt-in live probe against the real Tsinghua console.
 * Requires an already-logged-in dedicated profile (run the plugin's 重新登录 once).
 * Must be enabled deliberately: EASYCOMPUTE_LIVE_TEST=1
 */
import { fetchBalance, readSession, refreshSession } from '../lib/refresh.mjs'

if (process.env.EASYCOMPUTE_LIVE_TEST !== '1') {
  console.error('Live test skipped: set EASYCOMPUTE_LIVE_TEST=1 to hit the real console.')
  process.exitCode = 2
} else {
  const session = readSession()
  const renewed = session ? { ok: true, skipped: true } : await refreshSession({ force: true })
  const result = renewed.ok ? await fetchBalance() : { ok: false, error: renewed.error }
  console.log(JSON.stringify({
    ok: result.ok,
    couponFree: result.ok ? result.data.couponFree : undefined,
    error: result.ok ? undefined : result.error,
  }))
  process.exitCode = result.ok ? 0 : 1
}
