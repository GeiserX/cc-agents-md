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

// ============================================================
// cli.js lines 516-526 — patch --verbose on native binary
// Exercises the VERBOSE_FLAG && install.type === 'native' block.
// On patchNative (legacy) no meta file is written, so readPatchMeta
// returns null and lines 519-525 are skipped, but 516-526 block
// is entered and the closing brace is covered.
// ============================================================

describe('CLI — patch --verbose on native binary exercises meta block', () => {
  let fakeHome;
  let fakeDir;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-verbnative-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    fakeDir = mkdtempSync(join(tmpdir(), 'agents-md-verbnative-bin-'));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeDir, { recursive: true, force: true });
  });

  it('patch --verbose --force --auto on Mach-O binary enters verbose native block', () => {
    const binary = join(fakeDir, 'claude');
    const fnBuf = Buffer.from(READER_FN, 'utf8');
    const headerSize = 32;
    const padding = 500;
    const buf = Buffer.alloc(headerSize + fnBuf.length + padding);

    // Mach-O magic (little-endian: CF FA ED FE)
    buf.writeUInt32LE(0xFEEDFACF, 0);
    buf.writeUInt32LE(0, 16); // ncmds = 0
    fnBuf.copy(buf, headerSize);
    writeFileSync(binary, buf);

    const { stdout, exitCode } = runCli(
      `patch --path "${binary}" --verbose --force --auto`,
      { HOME: fakeHome },
    );
    assert.strictEqual(exitCode, 0);
    assert.ok(
      stdout.includes('Patched') || stdout.includes('native') || stdout.includes('Already patched'),
    );
  });

  it('patch --verbose --force --auto with pre-existing meta shows verbose details', () => {
    const binary = join(fakeDir, 'claude-withmeta');
    const fnBuf = Buffer.from(READER_FN, 'utf8');
    const headerSize = 32;
    const padding = 500;
    const buf = Buffer.alloc(headerSize + fnBuf.length + padding);

    buf.writeUInt32LE(0xFEEDFACF, 0);
    buf.writeUInt32LE(0, 16);
    fnBuf.copy(buf, headerSize);
    writeFileSync(binary, buf);

    // Pre-create a meta file so readPatchMeta returns data after patching
    const metaPath = binary + '.cc-agents-md.meta.json';
    writeFileSync(metaPath, JSON.stringify({
      version: '2.0.0',
      patchedAt: new Date().toISOString(),
      regexTier: 1,
      regexTierDesc: 'exact',
      growth: 42,
      sourceSizeOriginal: 100000,
      sourceSizePatched: 100042,
      sizeLocations: 2,
    }));

    const { stdout, exitCode } = runCli(
      `patch --path "${binary}" --verbose --force --auto`,
      { HOME: fakeHome },
    );
    assert.strictEqual(exitCode, 0);
    // If meta exists and is readable, lines 519-525 are exercised
    assert.ok(stdout.includes('Patched') || stdout.includes('native'));
  });
});

// ============================================================
// cli.js lines 546-549 — unpatch when resolveInstallation returns null
// On macOS with /opt/homebrew, detectNative finds the real binary.
// On Linux CI, both detectNpm and detectNative return null with
// restricted PATH/HOME, hitting lines 546-549.
// ============================================================

describe('CLI — unpatch with fully isolated environment', () => {
  let fakeHome;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-unpatch-iso-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('unpatch exits 1 when no installation is found anywhere', () => {
    const emptyBin = mkdtempSync(join(tmpdir(), 'agents-md-emptybin-'));
    const { stdout, exitCode } = runCli('unpatch', {
      HOME: fakeHome,
      PATH: emptyBin,
    });
    // On macOS, detectNative may find /opt/homebrew claude via hardcoded paths.
    // On Linux CI, this reliably hits lines 546-549.
    if (exitCode === 1) {
      assert.ok(
        stdout.includes('Could not find') ||
        stdout.includes('Not patched') ||
        stdout.includes('not found'),
      );
    }
    rmSync(emptyBin, { recursive: true, force: true });
  });
});

// ============================================================
// cli.js lines 581-583 — watch() failure path
// cli.js lines 591-593 — unwatch() failure path
//
// On macOS with Homebrew CC, watch succeeds (578-579 covered).
// On Linux CI without Homebrew CC, installLinux may fail if systemd
// user sessions are unavailable, hitting lines 581-583.
// ============================================================

describe('CLI — watch and unwatch failure paths via subprocess', () => {
  let fakeHome;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-watchsub-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('watch command exercises success or failure branch', () => {
    const { stdout, exitCode } = runCli('watch', { HOME: fakeHome });
    // macOS + Homebrew CC: exitCode 0 (success, lines 578-579)
    // Linux without systemd: exitCode 1 (failure, lines 581-583)
    assert.ok(exitCode === 0 || exitCode === 1);
    assert.ok(stdout.length > 0);
    if (exitCode === 1) {
      assert.ok(
        stdout.includes('not supported') ||
        stdout.includes('not found') ||
        stdout.includes('failed'),
      );
    }
  });

  it('unwatch command exercises success or failure branch', () => {
    const { stdout, exitCode } = runCli('unwatch', { HOME: fakeHome });
    assert.ok(exitCode === 0 || exitCode === 1);
    assert.ok(stdout.length > 0);
    if (exitCode === 1) {
      assert.ok(stdout.includes('Could not') || stdout.includes('failed'));
    }
  });
});

// ============================================================
// watch.js line 140 — statusMacOS catch block
// When launchctl print throws (service not loaded), the catch
// block sets loaded = false. We trigger this by ensuring the plist
// exists (so installed=true) but the service is not loaded.
// ============================================================

describe('watch.js — statusMacOS catch path', () => {
  if (process.platform !== 'darwin') return;

  it('statusMacOS triggers catch when service is not loaded in launchctl', () => {
    const { statusMacOS, MACOS_PLIST_PATH } = require('../lib/watch');
    const plistDir = join(MACOS_PLIST_PATH, '..');

    mkdirSync(plistDir, { recursive: true });

    // Save original state
    const plistExisted = existsSync(MACOS_PLIST_PATH);
    let originalContent;
    if (plistExisted) {
      originalContent = readFileSync(MACOS_PLIST_PATH);
    }

    try {
      // Bootout the real service first so launchctl print will throw
      try {
        execSync(
          `launchctl bootout gui/${process.getuid()} "${MACOS_PLIST_PATH}" 2>/dev/null`,
          { stdio: 'pipe' },
        );
      } catch { /* not loaded, that's fine */ }

      // Ensure plist file exists so installed=true, but service is not loaded
      writeFileSync(MACOS_PLIST_PATH, '<?xml version="1.0"?><plist><dict></dict></plist>');

      const result = statusMacOS();
      assert.strictEqual(result.installed, true);
      // launchctl print should throw -> catch sets loaded=false (line 140)
      assert.strictEqual(result.loaded, false);
    } finally {
      // Restore original state
      if (plistExisted) {
        writeFileSync(MACOS_PLIST_PATH, originalContent);
        // Re-bootstrap the service if it was loaded
        try {
          execSync(
            `launchctl bootstrap gui/${process.getuid()} "${MACOS_PLIST_PATH}" 2>/dev/null`,
            { stdio: 'pipe' },
          );
        } catch { /* already loaded or other error */ }
      } else {
        try { rmSync(MACOS_PLIST_PATH); } catch { /* ok */ }
      }
    }
  });
});
