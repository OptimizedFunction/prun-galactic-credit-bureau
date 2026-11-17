// Deploys the site to production, stamped with its version so the footer and About page can show it.
//
//   npm run deploy                  type-check, test, apply new migrations, deploy
//   npm run deploy -- --allow-dirty deploy even with uncommitted changes (the version then says "+changes")
//
// The version is package.json's. Bump it before a release with `npm version patch` (fixes), `npm version minor`
// (new features) or `npm version major`; that also commits the bump and tags it in git.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';

const args = new Set(process.argv.slice(2));
for (const a of args) if (a !== '--allow-dirty') throw new Error(`Unknown option ${a}. Option: --allow-dirty`);

const git = (...a: string[]) => execFileSync('git', a, { encoding: 'utf8' }).trim();
const wrangler = (...a: string[]) => execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', ...a], { stdio: 'inherit' });
const npm = (script: string) => execFileSync(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['run', '-s', script], { stdio: 'inherit', shell: process.platform === 'win32' });

const dirty = git('status', '--porcelain') !== '';
if (dirty && !args.has('--allow-dirty')) {
  console.error('There are uncommitted changes. Commit them first, or run "npm run deploy -- --allow-dirty".');
  process.exit(1);
}

const version: string = JSON.parse(fs.readFileSync('package.json', 'utf8')).version;
const commit = git('rev-parse', '--short', 'HEAD') + (dirty ? '+changes' : '');
const released = new Date().toISOString();
const subject = git('log', '-1', '--format=%s');
console.log(`Deploying version ${version} (${commit}) from branch ${git('branch', '--show-current') || '(detached)'}`);

npm('typecheck');
npm('test');
wrangler('d1', 'migrations', 'apply', 'bureau', '--remote');
wrangler(
  'deploy',
  '--define', `__APP_VERSION__:${JSON.stringify(version)}`,
  '--define', `__APP_COMMIT__:${JSON.stringify(commit)}`,
  '--define', `__APP_RELEASED__:${JSON.stringify(released)}`,
  '--tag', `v${version}`,
  '--message', `${commit}: ${subject}`.slice(0, 100),
);
console.log(`\nVersion ${version} (${commit}) is live. If something is wrong: npx wrangler rollback`);
