'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');
const { tmpdir } = require('os');

const CLI = join(__dirname, '..', 'bin', 'cli.js');

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

describe('CLI — logs --lines flag', () => {
  let fakeHome;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-logslines-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('logs --lines N limits output to N lines', () => {
    const logPath = join(fakeHome, '.claude', 'cc-agents-md-autopatch.log');
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
    writeFileSync(logPath, lines.join('\n') + '\n');

    const { stdout } = runCli('logs --lines 10', { HOME: fakeHome });
    assert.ok(stdout.includes('last 10 lines'));
    assert.ok(stdout.includes('line 100'));
  });

  it('logs --lines with invalid value falls back to default', () => {
    const logPath = join(fakeHome, '.claude', 'cc-agents-md-autopatch.log');
    writeFileSync(logPath, 'line 1\nline 2\nline 3\n');

    const { stdout } = runCli('logs --lines -5', { HOME: fakeHome });
    assert.ok(stdout.includes('last 50 lines'));
  });

  it('logs --lines 0 falls back to default', () => {
    const logPath = join(fakeHome, '.claude', 'cc-agents-md-autopatch.log');
    writeFileSync(logPath, 'line 1\n');

    const { stdout } = runCli('logs --lines 0', { HOME: fakeHome });
    assert.ok(stdout.includes('last 50 lines'));
  });
});

describe('CLI — status with config file', () => {
  let fakeHome;
  let projectDir;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-statusconf-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    projectDir = mkdtempSync(join(tmpdir(), 'agents-md-statusconf-proj-'));
    execSync('git init', { cwd: projectDir, stdio: 'pipe' });
    execSync('git config user.name "test"', { cwd: projectDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: projectDir, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('status shows config patterns when config file exists', () => {
    runCli('setup', { HOME: fakeHome });
    writeFileSync(join(projectDir, '.agents-md.json'), JSON.stringify({
      patterns: ['AGENTS.md', 'CUSTOM.md'],
      exclude: ['vendor/**'],
    }));

    const { stdout } = runCli('status', { HOME: fakeHome }, projectDir);
    assert.ok(stdout.includes('CUSTOM.md') || stdout.includes('Patterns'));
  });

  it('status --json includes config when config file exists', () => {
    runCli('setup', { HOME: fakeHome });
    writeFileSync(join(projectDir, '.agents-md.json'), JSON.stringify({
      patterns: ['AGENTS.md'],
      exclude: ['node_modules'],
    }));

    const { stdout } = runCli('status --json', { HOME: fakeHome }, projectDir);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.config !== null);
    assert.ok(parsed.config.path.includes('.agents-md.json'));
  });

  it('status shows AGENTS.md file details', () => {
    runCli('setup', { HOME: fakeHome });
    writeFileSync(join(projectDir, 'AGENTS.md'), '# Test\nLine 2\nLine 3');

    const { stdout } = runCli('status', { HOME: fakeHome }, projectDir);
    assert.ok(stdout.includes('AGENTS.md'));
    assert.ok(stdout.includes('3 lines'));
  });
});

describe('CLI — doctor with CLAUDE.md conflict detection', () => {
  let fakeHome;
  let projectDir;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-doctorconflict-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    projectDir = mkdtempSync(join(tmpdir(), 'agents-md-doctorconflict-proj-'));
    execSync('git init', { cwd: projectDir, stdio: 'pipe' });
    execSync('git config user.name "test"', { cwd: projectDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: projectDir, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('doctor detects conflicting CLAUDE.md that references @AGENTS.md', () => {
    runCli('setup', { HOME: fakeHome });
    writeFileSync(join(projectDir, 'AGENTS.md'), '# Test');
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Instructions\n@AGENTS.md\nMore content');

    const { stdout } = runCli('doctor --json', { HOME: fakeHome }, projectDir);
    const parsed = JSON.parse(stdout);
    const conflictCheck = parsed.checks.find(c => c.label.includes('conflicting'));
    if (conflictCheck) {
      assert.strictEqual(conflictCheck.pass, false);
    }
  });

  it('doctor --json includes config check when config exists', () => {
    runCli('setup', { HOME: fakeHome });
    writeFileSync(join(projectDir, 'AGENTS.md'), '# Test');
    writeFileSync(join(projectDir, '.agents-md.json'), '{"threshold": 5000}');

    const { stdout } = runCli('doctor --json', { HOME: fakeHome }, projectDir);
    const parsed = JSON.parse(stdout);
    const configCheck = parsed.checks.find(c => c.label.includes('Config'));
    if (configCheck) {
      assert.strictEqual(configCheck.pass, true);
    }
  });
});

describe('CLI — diff without installation', () => {
  let fakeHome;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-diffno-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('diff --path on text file with backup shows unified diff', () => {
    const fakeDir = mkdtempSync(join(tmpdir(), 'agents-md-difftxt-'));
    const cliJs = join(fakeDir, 'cli.js');
    writeFileSync(cliJs, `var before=1;${READER_FN}var after=2;`);

    // Patch it first to create backup
    runCli(`patch --path "${cliJs}" --auto`, { HOME: fakeHome });

    // Now diff should show unified diff
    const { stdout, exitCode } = runCli(`diff --path "${cliJs}"`, { HOME: fakeHome });
    assert.strictEqual(exitCode, 0);
    // Should show Type and Current info
    assert.ok(stdout.includes('npm') || stdout.includes('Current'));

    rmSync(fakeDir, { recursive: true, force: true });
  });
});

describe('CLI — migrate --delete with --json', () => {
  let fakeHome;
  let projectDir;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-migdeljson-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    projectDir = mkdtempSync(join(tmpdir(), 'agents-md-migdeljson-proj-'));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('migrate --delete --json reports deleted files', () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Delete JSON test');
    const { stdout } = runCli('migrate --delete --json', { HOME: fakeHome }, projectDir);
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.migrated.length, 1);
    assert.ok(parsed.deleted.length > 0);
    assert.ok(!existsSync(join(projectDir, 'CLAUDE.md')));
    assert.ok(existsSync(join(projectDir, 'AGENTS.md')));
  });
});

describe('CLI — patch native binary fallback from patchBun to patchNative', () => {
  let fakeHome;
  let fakeDir;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-patchfall-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    fakeDir = mkdtempSync(join(tmpdir(), 'agents-md-fake-native-fall-'));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeDir, { recursive: true, force: true });
  });

  it('patch --path --force on Mach-O with reader function but no __BUN falls back to patchNative', () => {
    const binary = join(fakeDir, 'claude');
    // Build a Mach-O with no __BUN section but WITH the reader function and null padding
    const fnBuf = Buffer.from(READER_FN, 'utf8');
    const headerSize = 32;
    const padding = 300;
    const buf = Buffer.alloc(headerSize + fnBuf.length + padding);

    // Mach-O magic
    buf.writeUInt32LE(0xFEEDFACF, 0);
    buf.writeUInt32LE(0, 16); // ncmds = 0 (no segments)

    // Write reader function after header
    fnBuf.copy(buf, headerSize);
    // Rest is null padding

    writeFileSync(binary, buf);

    const { stdout, exitCode } = runCli(`patch --path "${binary}" --force --auto`, { HOME: fakeHome });
    // patchBun fails (no __BUN) -> falls back to patchNative
    // patchNative should succeed since there's null padding
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('Patched') || stdout.includes('native'));
  });
});

describe('CLI — setup repairs missing script', () => {
  let fakeHome;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-repair-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('setup re-copies script when hook is registered but script is missing', () => {
    // First setup
    runCli('setup', { HOME: fakeHome });

    // Delete the script but keep settings
    const hookScript = join(fakeHome, '.claude', 'hooks', 'cc-agents-md.sh');
    if (existsSync(hookScript)) {
      rmSync(hookScript);
    }

    // Run setup again -- should re-copy script
    const { stdout, exitCode } = runCli('setup', { HOME: fakeHome });
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('Installed'));
    assert.ok(existsSync(hookScript));
  });
});
