/** Explicit opt-in live probe. Never reads browser profiles or credential files. */
import host from '../lib/index.js'
const token = process.env.PARATERA_CONSOLE_TOKEN
if (!token || process.env.PARATERA_LIVE_TEST !== '1') {
  console.error('Live test skipped: explicitly set PARATERA_LIVE_TEST=1 and PARATERA_CONSOLE_TOKEN. Do not paste secrets into shell history.')
  process.exitCode = 2
} else {
  const routes = new Map()
  const ctx = {
    webServer: { register(route) { routes.set(route.path, route.handler); return () => routes.delete(route.path) } },
    credentials: { async resolve() { return { value: token } } },
    connection: { requestRejection() { return null } }, // Isolated test context only; no listening HTTP server.
    inject(deps, callback) { callback(this) },
    effect() {},
  }
  host.apply(ctx, { tokenMode: 'manual' })
  const res = { status: 0, body: '', writeHead(code) { this.status = code }, end(body) { this.body = body } }
  await routes.get('/paratera-balance/api/balance')({ method: 'GET', url: '/paratera-balance/api/balance' }, res)
  const data = JSON.parse(res.body)
  console.log(JSON.stringify({ status: res.status, ok: data.ok, quotaSource: data.quotaSource, error: data.error }))
  process.exitCode = data.ok ? 0 : 1
}
