'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');
const { tmpdir } = require('os');

const CLI = join(__dirname, '..', 'bin', 'cli.js');

// Realistic reader function
const READER_FN = 'async function l59(H,_,q){try{let O=await Y_().readFile(H,{encoding:"utf-8"});return un4(O,H,_,q)}catch(K){return mn4(K,H),{info:null,includePaths:[]}}}';

function runCli(args, env = {}, cwd) {
  const opts = {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 15000,
  };
  if (cwd) opts.cwd = cwd;
  try {
    return {
      stdout: execSync(`node "${CLI}" ${args}`, opts),
      exitCode: 0,
    };
  } catch (err) {
    return {
      stdout: (err.stdout || '') + (err.stderr || ''),
      exitCode: err.status || 1,
    };
  }
}

describe('CLI — patch command', () => {
  let fakeHome;
  let fakeNpmDir;
  let fakeCliJs;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-patch-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    // Create a fake npm-installed cli.js
    fakeNpmDir = mkdtempSync(join(tmpdir(), 'agents-md-fake-npm-'));
    fakeCliJs = join(fakeNpmDir, 'cli.js');
    writeFileSync(fakeCliJs, `var before=1;${READER_FN}var after=2;`);
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeNpmDir, { recursive: true, force: true });
  });

  it('patch --path patches a specified npm cli.js', () => {
    const { stdout, exitCode } = runCli(`patch --path "${fakeCliJs}" --auto`, { HOME: fakeHome });
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('Patched'));
    const content = readFileSync(fakeCliJs, 'utf8');
    assert.ok(content.includes('AGENTS'));
  });

  it('patch --path --dry-run does not modify file', () => {
    const original = readFileSync(fakeCliJs, 'utf8');
    const { stdout, exitCode } = runCli(`patch --path "${fakeCliJs}" --dry-run --auto`, { HOME: fakeHome });
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('Dry run'));
    assert.strictEqual(readFileSync(fakeCliJs, 'utf8'), original);
  });

  it('patch --path fails on already patched file', () => {
    runCli(`patch --path "${fakeCliJs}" --auto`, { HOME: fakeHome });
    const { stdout, exitCode } = runCli(`patch --path "${fakeCliJs}" --auto`, { HOME: fakeHome });
    assert.strictEqual(exitCode, 0); // --auto doesn't exit(1) on "already patched"
    assert.ok(stdout.includes('Already patched'));
  });

  it('patch --path fails on incompatible file', () => {
    writeFileSync(fakeCliJs, 'var incompatible = true;');
    const { stdout, exitCode } = runCli(`patch --path "${fakeCliJs}" --auto`, { HOME: fakeHome });
    // In --auto mode, it logs but does not exit(1)
    assert.ok(stdout.includes('Could not find'));
  });

  it('patch --path fails on nonexistent file', () => {
    const { exitCode } = runCli('patch --path /nonexistent/cli.js --auto', { HOME: fakeHome });
    assert.strictEqual(exitCode, 1);
  });

  it('patch --verbose shows extra details', () => {
    const { stdout } = runCli(`patch --path "${fakeCliJs}" --verbose --auto`, { HOME: fakeHome });
    assert.ok(stdout.includes('Patched') || stdout.includes('Patterns'));
  });
});

describe('CLI — unpatch command', () => {
  let fakeHome;
  let fakeNpmDir;
  let fakeCliJs;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-unpatch-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    fakeNpmDir = mkdtempSync(join(tmpdir(), 'agents-md-fake-npm-unpatch-'));
    fakeCliJs = join(fakeNpmDir, 'cli.js');
    writeFileSync(fakeCliJs, `var before=1;${READER_FN}var after=2;`);
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeNpmDir, { recursive: true, force: true });
  });

  it('unpatch --path restores from backup', () => {
    const original = readFileSync(fakeCliJs, 'utf8');
    runCli(`patch --path "${fakeCliJs}" --auto`, { HOME: fakeHome });
    const { stdout, exitCode } = runCli(`unpatch --path "${fakeCliJs}"`, { HOME: fakeHome });
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('Restored'));
    assert.strictEqual(readFileSync(fakeCliJs, 'utf8'), original);
  });

  it('unpatch --path reports not patched when clean', () => {
    const { stdout, exitCode } = runCli(`unpatch --path "${fakeCliJs}"`, { HOME: fakeHome });
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('Not patched'));
  });

  it('unpatch --path fails on nonexistent file', () => {
    const { exitCode } = runCli('unpatch --path /nonexistent/cli.js', { HOME: fakeHome });
    assert.strictEqual(exitCode, 1);
  });
});

describe('CLI — diff command', () => {
  let fakeHome;
  let fakeNpmDir;
  let fakeCliJs;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-diff-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    fakeNpmDir = mkdtempSync(join(tmpdir(), 'agents-md-fake-npm-diff-'));
    fakeCliJs = join(fakeNpmDir, 'cli.js');
    writeFileSync(fakeCliJs, `var before=1;${READER_FN}var after=2;`);
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeNpmDir, { recursive: true, force: true });
  });

  it('diff --path shows no backup when not patched', () => {
    const { stdout } = runCli(`diff --path "${fakeCliJs}"`, { HOME: fakeHome });
    assert.ok(stdout.includes('No backup') || stdout.includes('not patched'));
  });

  it('diff --path shows diff after patching', () => {
    runCli(`patch --path "${fakeCliJs}" --auto`, { HOME: fakeHome });
    const { stdout, exitCode } = runCli(`diff --path "${fakeCliJs}"`, { HOME: fakeHome });
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('npm') || stdout.includes('Current'));
  });

  it('diff --path --json outputs structured data', () => {
    runCli(`patch --path "${fakeCliJs}" --auto`, { HOME: fakeHome });
    const { stdout } = runCli(`diff --path "${fakeCliJs}" --json`, { HOME: fakeHome });
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.type, 'npm');
    assert.ok(parsed.path.includes('cli.js'));
    assert.ok(typeof parsed.backup === 'string');
  });
});

describe('CLI — patch/unpatch native binary path', () => {
  let fakeHome;
  let fakeDir;
  let fakeBinary;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-native-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    fakeDir = mkdtempSync(join(tmpdir(), 'agents-md-fake-native-'));
    fakeBinary = join(fakeDir, 'claude');
    // Write a file with Mach-O magic bytes so --path detects it as native
    const buf = Buffer.alloc(1024);
    buf[0] = 0xCF; buf[1] = 0xFA; buf[2] = 0xED; buf[3] = 0xFE;
    // Write some content so it is detected as native but won't have the reader function
    buf.write('some binary content', 4);
    writeFileSync(fakeBinary, buf);
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeDir, { recursive: true, force: true });
  });

  it('patch --path with native binary requires --force', () => {
    const { stdout, exitCode } = runCli(`patch --path "${fakeBinary}"`, { HOME: fakeHome });
    assert.strictEqual(exitCode, 1);
    assert.ok(stdout.includes('--force') || stdout.includes('native'));
  });

  it('patch --path --force on incompatible native binary fails gracefully', () => {
    // Use a non-Mach-O binary (plain text) so patchBun fails quickly with "Not a Bun"
    // and patchNative also fails since there's no reader function
    const plainBinary = join(fakeDir, 'claude-plain');
    // Write Mach-O magic + junk so it's detected as native but not a valid Bun binary
    const buf = Buffer.alloc(256);
    buf[0] = 0xCF; buf[1] = 0xFA; buf[2] = 0xED; buf[3] = 0xFE;
    buf.writeUInt32LE(0, 16); // ncmds = 0 (no load commands, so no __BUN)
    writeFileSync(plainBinary, buf);

    const { stdout, exitCode } = runCli(`patch --path "${plainBinary}" --force`, { HOME: fakeHome });
    assert.strictEqual(exitCode, 1);
    assert.ok(stdout.includes('native'));
  });

  it('unpatch --path on clean native binary reports not patched', () => {
    const { stdout, exitCode } = runCli(`unpatch --path "${fakeBinary}"`, { HOME: fakeHome });
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('Not patched') || stdout.includes('nothing to do'));
  });

  it('patch --path with ELF binary detects as native', () => {
    // Write ELF magic bytes
    const buf = Buffer.alloc(1024);
    buf[0] = 0x7F; buf[1] = 0x45; buf[2] = 0x4C; buf[3] = 0x46;
    buf.write('some binary content', 4);
    writeFileSync(fakeBinary, buf);

    const { stdout, exitCode } = runCli(`patch --path "${fakeBinary}" --force`, { HOME: fakeHome });
    assert.ok(stdout.includes('native'));
  });
});

describe('CLI — unpatch native binary paths', () => {
  let fakeHome;
  let fakeDir;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-unpatch-native-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    fakeDir = mkdtempSync(join(tmpdir(), 'agents-md-fake-native-unpatch-'));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeDir, { recursive: true, force: true });
  });

  it('unpatch --path on patched native binary with backup restores it', () => {
    const binary = join(fakeDir, 'claude');
    const backup = binary + '.cc-agents-md.bak';

    // Create a "patched" Mach-O binary
    const buf = Buffer.alloc(1024);
    buf[0] = 0xCF; buf[1] = 0xFA; buf[2] = 0xED; buf[3] = 0xFE;
    buf.write('patched content replace("CLAUDE","AGENTS")', 4);
    writeFileSync(binary, buf);

    // Create backup
    const origBuf = Buffer.alloc(1024);
    origBuf[0] = 0xCF; origBuf[1] = 0xFA; origBuf[2] = 0xED; origBuf[3] = 0xFE;
    origBuf.write('original content', 4);
    writeFileSync(backup, origBuf);

    const { stdout, exitCode } = runCli(`unpatch --path "${binary}"`, { HOME: fakeHome });
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('Restored') || stdout.includes('native'));
  });

  it('unpatch --path on native binary with both markers and no backup falls through gracefully', () => {
    const binary = join(fakeDir, 'claude');

    // Create a native binary that has BOTH the Bun patch marker and the PATCH_SENTINEL
    // unpatchBun fails (no backup) -> falls back to unpatchNative which also finds it patched
    const buf = Buffer.alloc(2048);
    buf[0] = 0xCF; buf[1] = 0xFA; buf[2] = 0xED; buf[3] = 0xFE;
    const content = '/*cc-agents-md-patch*/ replace("CLAUDE","AGENTS") patched';
    buf.write(content, 4);
    writeFileSync(binary, buf);

    const { stdout, exitCode } = runCli(`unpatch --path "${binary}"`, { HOME: fakeHome });
    // Both unpatchers report patched-but-no-backup, so exit code should be 1
    assert.strictEqual(exitCode, 1);
    assert.ok(stdout.includes('Reinstall') || stdout.includes('no backup'));
  });
});

describe('CLI — migrate with nested CLAUDE.md walking up', () => {
  let fakeHome;
  let projectDir;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-migrate-nested-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    projectDir = mkdtempSync(join(tmpdir(), 'agents-md-project-nested-'));
    execSync('git init', { cwd: projectDir, stdio: 'pipe' });
    execSync('git config user.name "test"', { cwd: projectDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: projectDir, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('migrate finds CLAUDE.md in parent directories', () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Root level');
    const subDir = join(projectDir, 'packages', 'app');
    mkdirSync(subDir, { recursive: true });

    const { stdout } = runCli('migrate', { HOME: fakeHome }, subDir);
    assert.ok(stdout.includes('migrated'));
    assert.ok(existsSync(join(projectDir, 'AGENTS.md')));
  });
});

describe('CLI — watch/unwatch commands', () => {
  let fakeHome;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-watch-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('watch command completes with exit code reflecting installation status', () => {
    const { stdout, exitCode } = runCli('watch', { HOME: fakeHome });
    // exitCode depends on whether Homebrew CC is installed
    assert.ok(exitCode === 0 || exitCode === 1);
    assert.ok(typeof stdout === 'string');
    if (exitCode === 0) {
      assert.ok(stdout.includes('watcher') || stdout.includes('LaunchAgent'));
    } else {
      assert.ok(stdout.includes('Homebrew') || stdout.includes('not supported'));
    }
  });

  it('unwatch returns a result', () => {
    const { stdout, exitCode } = runCli('unwatch', { HOME: fakeHome });
    assert.ok(typeof stdout === 'string');
    // unwatch is safe even when nothing is installed
    assert.strictEqual(exitCode, 0);
  });
});
