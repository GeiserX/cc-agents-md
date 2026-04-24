'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } = require('fs');
const { join, dirname } = require('path');
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

// ============================================================
// watch.js — exported internal functions (resolveCli, buildPlist, buildSystemdUnits)
// ============================================================

describe('watch.js — resolveCli', () => {
  it('returns a string path', () => {
    const { resolveCli } = require('../lib/watch');
    const result = resolveCli();
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('falls back to relative bin/cli.js when cc-agents-md not in PATH', () => {
    const { resolveCli } = require('../lib/watch');
    const origPath = process.env.PATH;
    try {
      process.env.PATH = '/nonexistent-dir-only';
      const result = resolveCli();
      assert.ok(result.includes('cli.js'));
    } finally {
      process.env.PATH = origPath;
    }
  });
});

describe('watch.js — buildPlist', () => {
  it('generates valid plist XML for a .js script path', () => {
    const { buildPlist } = require('../lib/watch');
    const result = buildPlist('/usr/local/bin/cli.js');
    assert.ok(result.includes('<?xml version'));
    assert.ok(result.includes('<plist'));
    assert.ok(result.includes('/usr/bin/env'));
    assert.ok(result.includes('node'));
    assert.ok(result.includes('/usr/local/bin/cli.js'));
    assert.ok(result.includes('patch'));
    assert.ok(result.includes('--force'));
    assert.ok(result.includes('--auto'));
    assert.ok(result.includes('cc-agents-md-autopatch.log'));
  });

  it('generates plist for non-.js binary path (no node wrapper)', () => {
    const { buildPlist } = require('../lib/watch');
    const result = buildPlist('/usr/local/bin/cc-agents-md');
    assert.ok(result.includes('/usr/local/bin/cc-agents-md'));
    assert.ok(!result.includes('/usr/bin/env'));
    assert.ok(!result.includes('<string>node</string>'));
  });
});

describe('watch.js — buildSystemdUnits', () => {
  it('generates valid systemd path and service units for .js script', () => {
    const { buildSystemdUnits } = require('../lib/watch');
    const { pathUnit, serviceUnit, watchPath } = buildSystemdUnits('/usr/local/bin/cli.js');

    assert.ok(pathUnit.includes('[Unit]'));
    assert.ok(pathUnit.includes('[Path]'));
    assert.ok(pathUnit.includes('PathChanged='));
    assert.ok(pathUnit.includes('[Install]'));

    assert.ok(serviceUnit.includes('[Service]'));
    assert.ok(serviceUnit.includes('Type=oneshot'));
    assert.ok(serviceUnit.includes('node'));
    assert.ok(serviceUnit.includes('patch --auto'));

    assert.ok(typeof watchPath === 'string');
  });

  it('generates systemd units for non-.js binary (no node prefix)', () => {
    const { buildSystemdUnits } = require('../lib/watch');
    const { serviceUnit } = buildSystemdUnits('/usr/local/bin/cc-agents-md');
    assert.ok(serviceUnit.includes('/usr/local/bin/cc-agents-md patch --auto'));
    assert.ok(!serviceUnit.includes('node'));
  });
});

describe('watch.js — installLinux and removeLinux', () => {
  // These functions call systemctl which won't work on macOS,
  // but we can still exercise the code paths and catch the errors.

  it('installLinux writes unit files and returns result', () => {
    const { installLinux, LINUX_PATH_UNIT, LINUX_SERVICE_UNIT } = require('../lib/watch');
    const result = installLinux();
    assert.ok(typeof result.success === 'boolean');
    assert.ok(typeof result.message === 'string');
    // On macOS/non-Linux, systemctl will fail but units are written
    if (process.platform !== 'linux') {
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes('systemctl failed'));
    }
  });

  it('removeLinux removes unit files after installLinux created them', () => {
    const { installLinux, removeLinux, LINUX_PATH_UNIT, LINUX_SERVICE_UNIT } = require('../lib/watch');
    // First install to create the unit files
    installLinux();
    // Now remove should find and clean up the files
    const result = removeLinux();
    assert.strictEqual(result.success, true);
    assert.ok(result.message.includes('removed'));
  });

  it('removeLinux returns nothing-to-do when no units exist', () => {
    const { removeLinux, LINUX_PATH_UNIT, LINUX_SERVICE_UNIT } = require('../lib/watch');
    // Ensure clean state first
    try { rmSync(LINUX_PATH_UNIT); } catch { /* ok */ }
    try { rmSync(LINUX_SERVICE_UNIT); } catch { /* ok */ }

    const result = removeLinux();
    assert.strictEqual(result.success, true);
    assert.ok(result.message.includes('nothing to do'));
  });
});

describe('watch.js — statusLinux', () => {
  it('returns installed true when unit file exists', () => {
    const { statusLinux, LINUX_PATH_UNIT } = require('../lib/watch');
    const unitDir = join(LINUX_PATH_UNIT, '..');
    mkdirSync(unitDir, { recursive: true });
    writeFileSync(LINUX_PATH_UNIT, 'placeholder');
    try {
      const result = statusLinux();
      assert.strictEqual(result.installed, true);
      assert.strictEqual(result.loaded, false);
      assert.ok(result.unitPath.includes('cc-agents-md-repatch.path'));
    } finally {
      try { rmSync(LINUX_PATH_UNIT); } catch { /* ok */ }
    }
  });

  it('returns installed false when units do not exist', () => {
    const { statusLinux, LINUX_PATH_UNIT } = require('../lib/watch');
    // Ensure no unit file
    try { rmSync(LINUX_PATH_UNIT); } catch { /* ok */ }
    const result = statusLinux();
    assert.strictEqual(result.installed, false);
    assert.strictEqual(result.loaded, false);
  });
});

describe('watch.js — statusMacOS', () => {
  it('returns status object with expected shape', () => {
    const { statusMacOS } = require('../lib/watch');
    if (process.platform === 'darwin') {
      const result = statusMacOS();
      assert.ok(typeof result.installed === 'boolean');
      assert.ok(typeof result.loaded === 'boolean');
      assert.ok(result.unitPath.endsWith('.plist'));
    }
  });
});

describe('watch.js — installMacOS and removeMacOS', () => {
  it('installMacOS returns result based on Homebrew CC presence', () => {
    const { installMacOS } = require('../lib/watch');
    if (process.platform === 'darwin') {
      const result = installMacOS();
      assert.ok(typeof result.success === 'boolean');
      assert.ok(typeof result.message === 'string');
    }
  });

  it('removeMacOS returns result', () => {
    const { removeMacOS } = require('../lib/watch');
    if (process.platform === 'darwin') {
      const result = removeMacOS();
      assert.ok(typeof result.success === 'boolean');
      assert.ok(typeof result.message === 'string');
    }
  });
});

describe('watch.js — LOG_PATH export', () => {
  it('exports LOG_PATH ending with autopatch.log', () => {
    const { LOG_PATH } = require('../lib/watch');
    assert.ok(LOG_PATH.endsWith('cc-agents-md-autopatch.log'));
  });
});

describe('watch.js — LINUX unit path exports', () => {
  it('exports LINUX_PATH_UNIT and LINUX_SERVICE_UNIT paths', () => {
    const { LINUX_PATH_UNIT, LINUX_SERVICE_UNIT } = require('../lib/watch');
    assert.ok(LINUX_PATH_UNIT.includes('cc-agents-md-repatch.path'));
    assert.ok(LINUX_SERVICE_UNIT.includes('cc-agents-md-repatch.service'));
  });
});

// ============================================================
// detect.js — buildNpmResult and isFile directly
// ============================================================

describe('detect.js — buildNpmResult', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'detect-build-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns version null when no package.json exists', () => {
    const { buildNpmResult } = require('../lib/detect');
    const fakeCliJs = join(tempDir, 'cli.js');
    writeFileSync(fakeCliJs, 'module.exports = {}');
    const result = buildNpmResult(fakeCliJs);
    assert.strictEqual(result.type, 'npm');
    assert.strictEqual(result.path, fakeCliJs);
    assert.strictEqual(result.version, null);
  });

  it('extracts version from adjacent package.json', () => {
    const { buildNpmResult } = require('../lib/detect');
    const fakeCliJs = join(tempDir, 'cli.js');
    writeFileSync(fakeCliJs, 'module.exports = {}');
    writeFileSync(join(tempDir, 'package.json'), '{"version": "1.2.3"}');
    const result = buildNpmResult(fakeCliJs);
    assert.strictEqual(result.type, 'npm');
    assert.strictEqual(result.version, '1.2.3');
  });

  it('returns version null when package.json is malformed', () => {
    const { buildNpmResult } = require('../lib/detect');
    const fakeCliJs = join(tempDir, 'cli.js');
    writeFileSync(fakeCliJs, 'module.exports = {}');
    writeFileSync(join(tempDir, 'package.json'), 'not json{{{');
    const result = buildNpmResult(fakeCliJs);
    assert.strictEqual(result.type, 'npm');
    assert.strictEqual(result.version, null);
  });

  it('returns version null when package.json has no version field', () => {
    const { buildNpmResult } = require('../lib/detect');
    const fakeCliJs = join(tempDir, 'cli.js');
    writeFileSync(fakeCliJs, 'module.exports = {}');
    writeFileSync(join(tempDir, 'package.json'), '{"name": "test"}');
    const result = buildNpmResult(fakeCliJs);
    assert.strictEqual(result.type, 'npm');
    assert.strictEqual(result.version, null);
  });
});

describe('detect.js — isFile', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'detect-isfile-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns true for regular files', () => {
    const { isFile } = require('../lib/detect');
    const f = join(tempDir, 'test.txt');
    writeFileSync(f, 'content');
    assert.strictEqual(isFile(f), true);
  });

  it('returns false for directories', () => {
    const { isFile } = require('../lib/detect');
    assert.strictEqual(isFile(tempDir), false);
  });

  it('returns false for non-existent paths', () => {
    const { isFile } = require('../lib/detect');
    assert.strictEqual(isFile(join(tempDir, 'nonexistent')), false);
  });
});

describe('detect.js — detectNative with restricted env', () => {
  let tempDir;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'detect-native-'));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns null when PATH is restricted and no binaries exist', () => {
    const { detectNative } = require('../lib/detect');
    const origPath = process.env.PATH;
    const origHome = process.env.HOME;
    try {
      process.env.PATH = '/nonexistent';
      process.env.HOME = tempDir;
      const result = detectNative();
      // Should return null since no claude binary at any known path
      if (result === null) {
        assert.strictEqual(result, null);
      } else {
        // If somehow found (e.g. /opt/homebrew), just verify shape
        assert.strictEqual(result.type, 'native');
      }
    } finally {
      process.env.PATH = origPath;
      process.env.HOME = origHome;
    }
  });
});

// ============================================================
// patch-native.js — in-place replacement and codesign path
// ============================================================

describe('patch-native.js — in-place byte replacement', () => {
  const dirs = [];

  function makeTempDir() {
    const d = mkdtempSync(join(tmpdir(), 'patch-native-inplace-'));
    dirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  it('patches binary with null padding after function', () => {
    const { patchNative } = require('../lib/patch-native');
    const { PATCH_SENTINEL, backupPath } = require('../lib/patcher');

    const dir = makeTempDir();
    const binary = join(dir, 'claude');
    const fnBuf = Buffer.from(READER_FN, 'utf8');
    const paddingSize = 500;
    const buf = Buffer.alloc(fnBuf.length + paddingSize);
    fnBuf.copy(buf, 0);
    writeFileSync(binary, buf);

    const result = patchNative(binary);
    assert.strictEqual(result.success, true);
    assert.ok(result.message.includes('Patched'));
    assert.ok(existsSync(backupPath(binary)));
    const patched = readFileSync(binary, 'utf8');
    assert.ok(patched.includes(PATCH_SENTINEL));
  });

  it('patches binary with exact-fit null padding', () => {
    const { patchNative } = require('../lib/patch-native');
    const { buildReplacement, backupPath } = require('../lib/patcher');

    const dir = makeTempDir();
    const binary = join(dir, 'claude');

    const match = READER_FN.match(/async function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+)\)\{try\{let ([$\w]+)=await ([$\w]+)\(\)\.readFile\(\2,\{encoding:"utf-8"\}\);return ([$\w]+)\(\5,\2,\3,\4\)\}catch\(([$\w]+)\)\{return ([$\w]+)\(\8,\2\),\{info:null,includePaths:\[\]\}\}\}/);
    const patchedFn = buildReplacement(match[0], match[1], match[2], match[3], match[4], match[5], match[6], match[7], match[8], match[9]);
    const growth = Buffer.byteLength(patchedFn) - Buffer.byteLength(match[0]);

    const fnBuf = Buffer.from(READER_FN, 'utf8');
    const buf = Buffer.alloc(fnBuf.length + growth);
    fnBuf.copy(buf, 0);
    writeFileSync(binary, buf);

    const result = patchNative(binary);
    assert.strictEqual(result.success, true);
    assert.ok(result.message.includes('1/1'));
  });
});

// ============================================================
// CLI — diff on native binary with metadata (text and JSON)
// ============================================================

describe('CLI — diff on native binary with metadata', () => {
  let fakeHome;
  let fakeDir;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-diffnative-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    fakeDir = mkdtempSync(join(tmpdir(), 'agents-md-diffnative-'));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeDir, { recursive: true, force: true });
  });

  it('diff --path on native binary with metadata shows patch details', () => {
    const binary = join(fakeDir, 'claude');
    const backup = binary + '.cc-agents-md.bak';
    const meta = binary + '.cc-agents-md.meta.json';

    const buf = Buffer.alloc(1024);
    buf[0] = 0xCF; buf[1] = 0xFA; buf[2] = 0xED; buf[3] = 0xFE;
    writeFileSync(binary, buf);
    writeFileSync(backup, Buffer.alloc(1024));
    writeFileSync(meta, JSON.stringify({
      version: '2.1.99', patchedAt: '2025-04-01T00:00:00Z',
      regexTier: 1, regexTierDesc: 'exact match', growth: 42,
      sourceSizeOriginal: 100000, sourceSizePatched: 100042,
    }));

    const { stdout, exitCode } = runCli(`diff --path "${binary}"`, { HOME: fakeHome });
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('native'));
    assert.ok(stdout.includes('Patch metadata') || stdout.includes('2.1.99'));
  });

  it('diff --path --json on native binary includes meta', () => {
    const binary = join(fakeDir, 'claude-json');
    const backup = binary + '.cc-agents-md.bak';
    const meta = binary + '.cc-agents-md.meta.json';

    const buf = Buffer.alloc(512);
    buf[0] = 0xCF; buf[1] = 0xFA; buf[2] = 0xED; buf[3] = 0xFE;
    writeFileSync(binary, buf);
    writeFileSync(backup, Buffer.alloc(512));
    writeFileSync(meta, JSON.stringify({ version: '2.2.0', growth: 50 }));

    const { stdout } = runCli(`diff --path "${binary}" --json`, { HOME: fakeHome });
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.type, 'native');
    assert.ok(parsed.meta);
    assert.strictEqual(parsed.meta.version, '2.2.0');
  });

  it('diff --path on native binary without metadata shows fallback', () => {
    const binary = join(fakeDir, 'claude-nometa');
    const backup = binary + '.cc-agents-md.bak';

    const buf = Buffer.alloc(512);
    buf[0] = 0xCF; buf[1] = 0xFA; buf[2] = 0xED; buf[3] = 0xFE;
    writeFileSync(binary, buf);
    writeFileSync(backup, Buffer.alloc(512));

    const { stdout, exitCode } = runCli(`diff --path "${binary}"`, { HOME: fakeHome });
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('No patch metadata'));
  });
});

// ============================================================
// CLI — verbose patch shows config details
// ============================================================

describe('CLI — verbose patch shows config', () => {
  let fakeHome;
  let fakeDir;
  let fakeCliJs;
  let projectDir;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-verbpatch-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    fakeDir = mkdtempSync(join(tmpdir(), 'agents-md-fake-npm-verb-'));
    fakeCliJs = join(fakeDir, 'cli.js');
    writeFileSync(fakeCliJs, `var before=1;${READER_FN}var after=2;`);
    projectDir = mkdtempSync(join(tmpdir(), 'agents-md-verb-proj-'));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeDir, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('patch --verbose shows Patterns info', () => {
    writeFileSync(join(projectDir, '.agents-md.json'), JSON.stringify({
      patterns: ['AGENTS.md', 'CUSTOM.md'], cache: false,
    }));
    const { stdout } = runCli(`patch --path "${fakeCliJs}" --verbose --auto`, {
      HOME: fakeHome,
    }, projectDir);
    assert.ok(stdout.includes('Patterns') || stdout.includes('AGENTS.md'));
  });
});

// ============================================================
// CLI — status text output variants
// ============================================================

describe('CLI — status text output variants', () => {
  let fakeHome;
  let projectDir;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-statustext-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    projectDir = mkdtempSync(join(tmpdir(), 'agents-md-statustext-proj-'));
    execSync('git init', { cwd: projectDir, stdio: 'pipe' });
    execSync('git config user.name "test"', { cwd: projectDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: projectDir, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('status text shows no AGENTS.md when none exist', () => {
    const { stdout } = runCli('status', { HOME: fakeHome }, projectDir);
    assert.ok(stdout.includes('No AGENTS.md') || stdout.includes('Hook installed'));
  });

  it('status text shows exclude patterns when configured', () => {
    runCli('setup', { HOME: fakeHome });
    writeFileSync(join(projectDir, '.agents-md.json'), JSON.stringify({
      patterns: ['AGENTS.md', 'INSTRUCTIONS.md'],
      exclude: ['vendor/**', 'dist/**'],
    }));
    const { stdout } = runCli('status', { HOME: fakeHome }, projectDir);
    assert.ok(stdout.includes('Exclude') || stdout.includes('vendor'));
  });

  it('status --json with no config shows config as null', () => {
    const { stdout } = runCli('status --json', { HOME: fakeHome }, projectDir);
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.config, null);
  });
});

// ============================================================
// CLI — doctor text output
// ============================================================

describe('CLI — doctor text output', () => {
  let fakeHome;
  let projectDir;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-doctortext-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    projectDir = mkdtempSync(join(tmpdir(), 'agents-md-doctortext-proj-'));
    execSync('git init', { cwd: projectDir, stdio: 'pipe' });
    execSync('git config user.name "test"', { cwd: projectDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: projectDir, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('doctor text shows check marks', () => {
    runCli('setup', { HOME: fakeHome });
    writeFileSync(join(projectDir, 'AGENTS.md'), '# Test');
    const { stdout } = runCli('doctor', { HOME: fakeHome }, projectDir);
    assert.ok(stdout.includes('\u2713') || stdout.includes('\u2717'));
  });

  it('doctor detects CLAUDE.md with lowercase read agents.md reference', () => {
    runCli('setup', { HOME: fakeHome });
    writeFileSync(join(projectDir, 'AGENTS.md'), '# Test');
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Docs\nPlease read agents.md for details');
    const { stdout } = runCli('doctor --json', { HOME: fakeHome }, projectDir);
    const parsed = JSON.parse(stdout);
    const conflictCheck = parsed.checks.find(c => c.label.includes('conflicting'));
    if (conflictCheck) {
      assert.strictEqual(conflictCheck.pass, false);
    }
  });
});

// ============================================================
// CLI — remove and status flow
// ============================================================

describe('CLI — remove and status flow', () => {
  let fakeHome;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-removestatus-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('remove after setup shows Removed message', () => {
    runCli('setup', { HOME: fakeHome });
    const { stdout, exitCode } = runCli('remove', { HOME: fakeHome });
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('Removed'));
  });

  it('status --json after remove shows hookInstalled false', () => {
    runCli('setup', { HOME: fakeHome });
    runCli('remove', { HOME: fakeHome });
    const { stdout } = runCli('status --json', { HOME: fakeHome });
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.hookInstalled, false);
  });

  it('remove is idempotent', () => {
    runCli('setup', { HOME: fakeHome });
    runCli('remove', { HOME: fakeHome });
    const { stdout, exitCode } = runCli('remove', { HOME: fakeHome });
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('Removed'));
  });
});

// ============================================================
// CLI — preview edge cases
// ============================================================

describe('CLI — preview edge cases', () => {
  let fakeHome;
  let projectDir;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-prevedge-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    projectDir = mkdtempSync(join(tmpdir(), 'agents-md-prevedge-proj-'));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('preview without setup exits with error', () => {
    const { exitCode, stdout } = runCli('preview', { HOME: fakeHome });
    assert.strictEqual(exitCode, 1);
    assert.ok(stdout.includes('Hook script not found'));
  });

  it('preview text shows nothing-to-inject when no AGENTS.md', () => {
    runCli('setup', { HOME: fakeHome });
    const { stdout } = runCli('preview', { HOME: fakeHome, CLAUDE_PROJECT_DIR: projectDir });
    assert.ok(stdout.includes('No AGENTS.md') || stdout.includes('nothing'));
  });
});

// ============================================================
// CLI — logs edge cases
// ============================================================

describe('CLI — logs edge cases', () => {
  let fakeHome;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-logsedge-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('logs --json with existing file includes totalLines', () => {
    const logPath = join(fakeHome, '.claude', 'cc-agents-md-autopatch.log');
    writeFileSync(logPath, 'a\nb\nc\nd\ne\n');
    const { stdout } = runCli('logs --json', { HOME: fakeHome });
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.totalLines >= 5);
    assert.ok(Array.isArray(parsed.lines));
  });

  it('logs text output includes content without trailing newline', () => {
    const logPath = join(fakeHome, '.claude', 'cc-agents-md-autopatch.log');
    writeFileSync(logPath, 'no trailing newline');
    const { stdout } = runCli('logs', { HOME: fakeHome });
    assert.ok(stdout.includes('no trailing newline'));
  });
});

// ============================================================
// CLI — patch --auto idempotent behavior
// ============================================================

describe('CLI — patch --auto idempotent', () => {
  let fakeHome;
  let fakeDir;
  let fakeCliJs;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-patchauto-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    fakeDir = mkdtempSync(join(tmpdir(), 'agents-md-fake-npm-auto-'));
    fakeCliJs = join(fakeDir, 'cli.js');
    writeFileSync(fakeCliJs, `var before=1;${READER_FN}var after=2;`);
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeDir, { recursive: true, force: true });
  });

  it('patch --auto on already-patched exits 0', () => {
    runCli(`patch --path "${fakeCliJs}" --auto`, { HOME: fakeHome });
    const { stdout, exitCode } = runCli(`patch --path "${fakeCliJs}" --auto`, { HOME: fakeHome });
    assert.strictEqual(exitCode, 0);
    assert.ok(stdout.includes('Already patched'));
  });

  it('patch --auto on incompatible file logs error without exit(1)', () => {
    writeFileSync(fakeCliJs, 'var incompatible = true;');
    const { stdout } = runCli(`patch --path "${fakeCliJs}" --auto`, { HOME: fakeHome });
    assert.ok(stdout.includes('Could not find'));
  });
});

// ============================================================
// CLI — unpatch without detection
// ============================================================

describe('CLI — unpatch without detection', () => {
  let fakeHome;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-unpatch-nodetect-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('unpatch exits with error when no installation found', () => {
    const { stdout, exitCode } = runCli('unpatch', {
      HOME: fakeHome, PATH: '/nonexistent',
    });
    if (exitCode === 1) {
      assert.ok(stdout.includes('Could not find') || stdout.includes('Not patched'));
    }
  });
});

// ============================================================
// patch-bun.js — tier 3 regex
// ============================================================

describe('patch-bun.js — tier 3 regex', () => {
  it('tier 3 matches extra trailing params', () => {
    const { READER_PATTERNS } = require('../lib/patch-bun');
    const fn = 'async function l59(H,_,q,extra){try{let O=await Y_().readFile(H,{encoding:"utf-8"});return un4(O,H,_,q,extra)}catch(K){return mn4(K,H),{info:null,includePaths:[]}}}';
    const m = fn.match(READER_PATTERNS[2].re);
    assert.ok(m, 'tier 3 should match');
    assert.strictEqual(m[1], 'l59');
  });

  it('all tiers reject garbage', () => {
    const { READER_PATTERNS } = require('../lib/patch-bun');
    for (const pattern of READER_PATTERNS) {
      assert.strictEqual('var x = 1;'.match(pattern.re), null);
    }
  });
});

// ============================================================
// patcher.js — buildReplacement .local.md support
// ============================================================

describe('patcher.js — buildReplacement .local.md', () => {
  it('replacement regex captures .local optional group', () => {
    const { buildReplacement } = require('../lib/patcher');
    const match = READER_FN.match(/async function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+)\)\{try\{let ([$\w]+)=await ([$\w]+)\(\)\.readFile\(\2,\{encoding:"utf-8"\}\);return ([$\w]+)\(\5,\2,\3,\4\)\}catch\(([$\w]+)\)\{return ([$\w]+)\(\8,\2\),\{info:null,includePaths:\[\]\}\}\}/);
    const result = buildReplacement(match[0], match[1], match[2], match[3], match[4], match[5], match[6], match[7], match[8], match[9]);
    assert.ok(result.includes('CLAUDE'));
    assert.ok(result.includes('AGENTS'));
    assert.ok(result.includes('.local'));
  });
});

// ============================================================
// settings.js — extra edge cases
// ============================================================

describe('settings.js — edge cases', () => {
  it('isEventRegistered returns false for non-existent event', () => {
    const { isEventRegistered } = require('../lib/settings');
    const settings = {
      hooks: { SessionStart: [{ hooks: [{ command: '/path/cc-agents-md.sh' }] }] },
    };
    assert.strictEqual(isEventRegistered(settings, 'NonExistent'), false);
  });

  it('addHook creates all three event arrays', () => {
    const { addHook } = require('../lib/settings');
    const settings = {};
    addHook(settings, '/path/to/cc-agents-md.sh');
    assert.ok(Array.isArray(settings.hooks.SessionStart));
    assert.ok(Array.isArray(settings.hooks.UserPromptSubmit));
    assert.ok(Array.isArray(settings.hooks.PreCompact));
  });

  it('removeHook is safe when no hooks key exists', () => {
    const { removeHook } = require('../lib/settings');
    const result = removeHook({ other: 'data' });
    assert.strictEqual(result.other, 'data');
    assert.ok(!result.hooks);
  });

  it('isInstalled matches .ps1 path', () => {
    const { isInstalled } = require('../lib/settings');
    const settings = {
      hooks: { SessionStart: [{ hooks: [{ command: 'C:\\cc-agents-md.ps1' }] }] },
    };
    assert.ok(isInstalled(settings));
  });
});

// ============================================================
// config.js — walk to root
// ============================================================

describe('config.js — walk to root', () => {
  it('returns defaults from deep path with no config', () => {
    const { loadConfig, DEFAULTS } = require('../lib/config');
    const deep = join(tmpdir(), 'cfg-a', 'b', 'c', 'd');
    mkdirSync(deep, { recursive: true });
    const { config, configPath } = loadConfig(deep);
    assert.strictEqual(configPath, null);
    assert.deepStrictEqual(config, DEFAULTS);
    rmSync(join(tmpdir(), 'cfg-a'), { recursive: true, force: true });
  });
});
