// Entry point for the scheduled task: renew the console session without DSH running.
// Usage: node lib/scheduled.mjs
import { refreshSession } from './refresh.mjs';

const result = await refreshSession();
console.log(JSON.stringify({ at: new Date().toISOString(), ...result }));
