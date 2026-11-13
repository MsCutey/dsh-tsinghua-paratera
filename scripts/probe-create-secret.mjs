#!/usr/bin/env node
// Retired: the former probe ran live mutations on import, retried deletes and
// could report success after a failed baseline. Use the explicitly opted-in,
// baseline-checked lifecycle entry instead. No library/session is loaded here.
console.error('This probe has been retired. Use: node scripts/verify-key-lifecycle.mjs --help');
process.exitCode = 2;
