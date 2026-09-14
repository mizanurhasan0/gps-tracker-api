const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const source = path.resolve(__dirname, '..');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gps-deploy-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const repo = path.join(root, 'repo');
  const bin = path.join(root, 'bin');
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.mkdirSync(bin);
  for (const file of ['deploy.sh', 'deploy-vps.sh']) fs.copyFileSync(path.join(source, 'scripts', file), path.join(repo, 'scripts', file));
  const git = (...args) => {
    const result = spawnSync('git', args, { cwd: repo, encoding: 'utf8' });
    assert.equal(result.status, 0, result.stderr);
    return result.stdout.trim();
  };
  git('init', '-b', 'main');
  git('config', 'user.email', 'test@example.invalid');
  git('config', 'user.name', 'Deployment Test');
  git('add', '.');
  git('commit', '-m', 'Test release');
  git('init', '--bare', path.join(root, 'origin.git'));
  git('remote', 'add', 'origin', path.join(root, 'origin.git'));
  const log = path.join(root, 'commands');
  const mock = (name, body) => fs.writeFileSync(path.join(bin, name), `#!/usr/bin/env bash\nset -eu\nprintf '%s\\n' "${name} $*" >> "$COMMAND_LOG"\n${body}\n`, { mode: 0o755 });
  mock('npm', 'exit 0');
  mock('scp', 'exit 0');
  mock('ssh', `case "$*" in
    *--check*) exit "\u0024{SSH_CHECK_STATUS:-0}" ;;
    *'mktemp /tmp/gps-api-helper.'*) echo /tmp/gps-api-helper.TEST1234 ;;
    *mktemp*) echo /tmp/gps-api-release.TEST1234 ;;
    *) exit 0 ;;
  esac`);
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, COMMAND_LOG: log, DEPLOY_HOST: 'test-vps', DEPLOY_PATH: '/srv/gps-api', DEPLOY_BRANCH: 'main', DEPLOY_REMOTE: 'origin' };
  delete env.TEST_DATABASE_URL;
  delete env.HISTORY_TEST_DATABASE_URL;
  delete env.DEPLOY_SSH_KEY;
  const run = (extra = {}) => spawnSync('bash', ['scripts/deploy.sh'], { cwd: repo, env: { ...env, ...extra }, encoding: 'utf8' });
  return { root, repo, bin, git, mock, env, run, commands: () => fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '' };
}

test('pushes the tested commit and transfers it only after successful validation', t => {
  const f = fixture(t);
  const result = f.run();
  assert.equal(result.status, 0, result.stderr);
  const revision = f.git('rev-parse', 'HEAD');
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main').split(/\s/)[0], revision);
  const commands = f.commands();
  assert.match(commands, /npm run typecheck/);
  assert.match(commands, /npm run test:deploy/);
  assert.match(commands, /npm run test:unit/);
  assert.ok(commands.indexOf('npm run test:unit') < commands.indexOf('release.bundle'));
  assert.ok(commands.includes(`'${revision}' '/tmp/gps-api-release.TEST1234'`));
  assert.match(commands, /StrictHostKeyChecking=yes/);
});

test('dirty checkout and SSH failure stop before tests or push', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'uncommitted.txt'), 'local edit');
  assert.notEqual(f.run().status, 0);
  assert.equal(f.commands(), '');
  fs.unlinkSync(path.join(f.repo, 'uncommitted.txt'));
  assert.notEqual(f.run({ SSH_CHECK_STATUS: '255' }).status, 0);
  assert.doesNotMatch(f.commands(), /npm |release.bundle/);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main'), '');
});

test('test failures do not push and configured test databases select the full suite', t => {
  const f = fixture(t);
  f.mock('npm', 'if [[ "$*" == test ]]; then exit 1; fi');
  assert.notEqual(f.run({ TEST_DATABASE_URL: 'postgresql://disposable/test' }).status, 0);
  assert.match(f.commands(), /npm test\n/);
  assert.doesNotMatch(f.commands(), /test:unit|release.bundle/);
  assert.equal(f.git('ls-remote', 'origin', 'refs/heads/main'), '');
});

test('push rejection does not upload or deploy', t => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'origin.git', 'hooks', 'pre-receive'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
  assert.notEqual(f.run().status, 0);
  assert.doesNotMatch(f.commands(), /release.bundle|mktemp \/tmp\/gps-api-release/);
});

function remoteFixture(t) {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.repo, 'compose.yml'), 'name: test\n');
  fs.writeFileSync(path.join(f.repo, '.env'), 'SECRET=never-print\n');
  fs.writeFileSync(path.join(f.repo, '.gitignore'), '.env\n');
  f.git('add', '.');
  f.git('commit', '-m', 'VPS fixture');
  const revision = f.git('rev-parse', 'HEAD');
  // A real bundle in the same path shape accepted by the remote helper.
  const bundle = path.join('/tmp', `gps-api-release.${path.basename(f.root).replace(/[^a-zA-Z0-9]/g, '')}`);
  t.after(() => fs.rmSync(bundle, { force: true }));
  f.git('bundle', 'create', bundle, 'main');
  f.mock('flock', 'exit 0');
  f.mock('docker', `case "$*" in
    *'ps -q postgres'*) echo postgres-id ;;
    *'ps -q api'*) echo api-id ;;
    *'inspect --format {{.Image}}'*) echo sha256:old-image ;;
    *'org.opencontainers.image.revision'*) echo "$RELEASE_REVISION" ;;
    *pg_dump*) [[ "\u0024{FAIL_BACKUP:-0}" == 0 ]] || exit 1; echo fake-dump ;;
    *'pg_restore --list'*) cat >/dev/null; echo fake-contents ;;
    *) exit 0 ;;
  esac`);
  const runRemote = (extra = {}) => spawnSync('bash', ['scripts/deploy-vps.sh', f.repo, revision, bundle], { cwd: f.repo, env: { ...f.env, RELEASE_REVISION: revision, ...extra }, encoding: 'utf8' });
  return { ...f, revision, runRemote };
}

test('remote build and verified backup precede API-only recreation', t => {
  const f = remoteFixture(t);
  const result = f.runRemote();
  assert.equal(result.status, 0, result.stderr);
  const commands = f.commands();
  assert.ok(commands.indexOf('build --build-arg') < commands.indexOf('pg_dump'));
  assert.ok(commands.indexOf('pg_restore --list') < commands.indexOf('up -d'));
  assert.match(commands, /up -d --no-deps --wait --wait-timeout 120 api/);
  assert.doesNotMatch(commands, / down|volume rm/);
  assert.doesNotMatch(result.stdout + result.stderr, /never-print/);
  const backupRoot = path.join(f.root, 'gps-deploy-backups');
  const backup = path.join(backupRoot, fs.readdirSync(backupRoot)[0]);
  assert.equal(fs.readFileSync(path.join(backup, 'deployed-commit'), 'utf8').trim(), f.revision);
  assert.equal(fs.statSync(backup).mode & 0o777, 0o700);
});

test('failed remote database backup never recreates the API', t => {
  const f = remoteFixture(t);
  const result = f.runRemote({ FAIL_BACKUP: '1' });
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(f.commands(), /up -d/);
  assert.match(result.stderr, /Deployment failed/);
});
