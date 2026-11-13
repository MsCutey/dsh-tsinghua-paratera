#!/usr/bin/env node
// Export only reviewed source files, initialise a new anonymous history, and
// build archives from that export. No remote, publication or credential access.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { findPnpm } from './install.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
const options = {};
for (let index = 0; index < args.length; index += 2) {
  if (!['--repository', '--out', '--copyright-name'].includes(args[index]) || !args[index + 1]) throw Error('usage: --repository owner/repo [--out DIR] [--copyright-name NAME]');
  options[args[index]] = args[index + 1];
}
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(options['--repository'] || '')) throw Error('a concrete GitHub repository is required');
const destination = path.resolve(options['--out'] || path.join(root, '.artifacts', 'public-release'));
if (fs.existsSync(destination)) throw Error('output directory already exists; choose a fresh directory');
const tree = path.join(destination, 'source');
const assets = path.join(destination, 'assets');
fs.mkdirSync(tree, { recursive: true }); fs.mkdirSync(assets);

const files = ['.gitattributes', '.gitignore', 'README.md', 'AGENTS.md', 'LICENSE', 'PRIVACY.md', 'SECURITY.md', 'CHANGELOG.md', 'package.json', 'pnpm-lock.yaml',
  'docs/ARCHITECTURE.md', 'docs/SECURITY-AUDIT.md', 'docs/WINDOWS.md', 'docs/VALIDATION.md', 'docs/KEY-MANAGEMENT.md', 'docs/HOST-COUPLING.md'];
for (const folder of ['lib', 'scripts', 'tests', '.github']) {
  const visit = (dir) => {
    if (!fs.existsSync(path.join(root, dir))) return;
    for (const entry of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const name = path.join(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error('symlink in source allowlist');
      if (entry.isDirectory()) visit(name);
      else if (entry.isFile() && /\.(?:js|mjs|swift|ps1|ya?ml)$/.test(name)) files.push(name);
    }
  };
  visit(folder);
}
for (const name of files) {
  const from = path.join(root, name);
  if (!fs.statSync(from).isFile()) throw Error('source entry is not a file');
  fs.mkdirSync(path.dirname(path.join(tree, name)), { recursive: true });
  fs.copyFileSync(from, path.join(tree, name));
}
fs.copyFileSync(path.join(root, 'cordis.patch.yml'), path.join(tree, 'cordis.patch.yml')); files.push('cordis.patch.yml');
const repository = options['--repository'];
const manifest = JSON.parse(fs.readFileSync(path.join(tree, 'package.json'), 'utf8'));
delete manifest.author; delete manifest.contributors;
manifest.repository = { type: 'git', url: `https://github.com/${repository}.git` };
manifest.homepage = `https://github.com/${repository}`;
manifest.bugs = { url: `https://github.com/${repository}/issues` };
fs.writeFileSync(path.join(tree, 'package.json'), JSON.stringify(manifest, null, 2) + '\n');
if (options['--copyright-name']) {
  // Use only with the copyright holder's consent; this is a proposed export,
  // and never rewrites the original source repository's license/history.
  const file = path.join(tree, 'LICENSE');
  fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace(/^Copyright \(c\) \d{4} .+$/m, `Copyright (c) 2026 ${options['--copyright-name']}`));
}
const date = new Date().toISOString();
const gitEnv = { ...process.env, TZ: 'UTC', GIT_AUTHOR_DATE: date, GIT_COMMITTER_DATE: date, GIT_AUTHOR_NAME: 'DSH Tsinghua Paratera Contributors', GIT_AUTHOR_EMAIL: 'contributors@dsh-tsinghua-paratera.invalid', GIT_COMMITTER_NAME: 'DSH Tsinghua Paratera Contributors', GIT_COMMITTER_EMAIL: 'contributors@dsh-tsinghua-paratera.invalid' };
const run = (file, parameters, env = process.env) => {
  const result = spawnSync(file, parameters, { cwd: tree, env, encoding: 'utf8', timeout: 120000 });
  if (result.status !== 0) throw Error(`release command failed: ${path.basename(file)}`);
  return result.stdout;
};
run('git', ['init', '-b', 'main'], gitEnv);
run('git', ['config', 'user.name', gitEnv.GIT_AUTHOR_NAME], gitEnv);
run('git', ['config', 'user.email', gitEnv.GIT_AUTHOR_EMAIL], gitEnv);
run('git', ['config', 'commit.gpgsign', 'false'], gitEnv);
run('git', ['config', 'core.hooksPath', path.join(destination, 'no-hooks')], gitEnv);
run('git', ['add', '--', '.'], gitEnv);
run('git', ['commit', '-m', `Release ${manifest.version}: privacy-hardened public source`], gitEnv);
run('git', ['-c', 'tag.gpgsign=false', 'tag', '-a', `v${manifest.version}`, '-m', `Release ${manifest.version}`], gitEnv);
const archive = `${manifest.name}-${manifest.version}`;
run('git', ['archive', '--format=zip', `--prefix=${archive}/`, '-o', path.join(assets, archive + '-source.zip'), 'HEAD'], gitEnv);
const pnpm = findPnpm();
run(pnpm.kind === 'script' ? process.execPath : pnpm.path,
  [...(pnpm.kind === 'script' ? [pnpm.path] : []), 'pack', '--out', path.join(assets, archive + '.tgz')],
  { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + (process.env.PATH || '') });
const hashes = fs.readdirSync(assets).sort().map((name) => `${createHash('sha256').update(fs.readFileSync(path.join(assets, name))).digest('hex')}  ${name}`);
fs.writeFileSync(path.join(assets, 'SHA256SUMS'), hashes.join('\n') + '\n');
const result = { version: manifest.version, repository, files: files.length, commit: run('git', ['rev-parse', 'HEAD']).trim(), historyCount: Number(run('git', ['rev-list', '--all', '--count']).trim()), tree, assets };
fs.writeFileSync(path.join(destination, 'manifest.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
