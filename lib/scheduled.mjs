// Entry point for the scheduled task: renew the console session without DSH running.
// Usage: node lib/scheduled.mjs
import { refreshSession, cancelSecondFactor } from './refresh.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export async function runScheduledRefresh({ refresh = refreshSession, cancel = cancelSecondFactor } = {}) {
  const result = await refresh();
  // A scheduler has no settings page to submit the code to this process.
  // Release its own parked browser rather than leaving an orphaned SSO window.
  if (result.secondFactor || result.error === 'second-factor-required') await cancel();
  return result;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = await runScheduledRefresh();
  console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
  if (!result.ok && result.error !== 'refresh-busy') process.exitCode = 1;
}
