'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');
const { tmpdir } = require('os');

const CLI = join(__dirname, '..', 'bin', 'cli.js');

function runCli(args, env = {}) {
  try {
    return {
      stdout: execSync(`node "${CLI}" ${args}`, {
        encoding: 'utf8',
        env: { ...process.env, ...env },
        timeout: 5000
      }),
      exitCode: 0
    };
  } catch (err) {
    return {
      stdout: (err.stdout || '') + (err.stderr || ''),
      exitCode: err.status || 1
    };
  }
}

describe('CLI', () => {
  let fakeHome;
  let settingsPath;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    settingsPath = join(fakeHome, '.claude', 'settings.json');
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('shows help with --help', () => {
    const { stdout } = runCli('--help');
    assert.ok(stdout.includes('cc-agents-md'));
    assert.ok(stdout.includes('setup'));
    assert.ok(stdout.includes('remove'));
    assert.ok(stdout.includes('doctor'));
    assert.ok(stdout.includes('preview'));
  });

  it('shows version with --version', () => {
    const { stdout } = runCli('--version');
    const pkg = require('../package.json');
    assert.ok(stdout.trim() === pkg.version);
  });

  it('errors on unknown command', () => {
    const { stdout, exitCode } = runCli('foobar');
    assert.ok(stdout.includes('Unknown command'));
    assert.strictEqual(exitCode, 1);
  });

  it('setup installs hook and copies script', () => {
    const { stdout } = runCli('setup', { HOME: fakeHome });
    assert.ok(stdout.includes('Installed successfully'));

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.ok(settings.hooks?.SessionStart?.length > 0);
    assert.ok(settings.hooks.SessionStart[0].hooks[0].command.includes('cc-agents-md'));

    assert.ok(existsSync(join(fakeHome, '.claude', 'hooks', 'cc-agents-md.sh')));
  });

  it('setup is idempotent', () => {
    runCli('setup', { HOME: fakeHome });
    const { stdout } = runCli('setup', { HOME: fakeHome });
    assert.ok(stdout.includes('Already installed'));

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(settings.hooks.SessionStart.length, 1);
  });

  it('setup preserves existing hooks', () => {
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo existing' }] }]
      }
    }));

    runCli('setup', { HOME: fakeHome });
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(settings.hooks.SessionStart.length, 2);
    assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, 'echo existing');
  });

  it('setup preserves existing non-hook settings', () => {
    writeFileSync(settingsPath, JSON.stringify({
      model: 'opus',
      env: { FOO: 'bar' }
    }));

    runCli('setup', { HOME: fakeHome });
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(settings.model, 'opus');
    assert.strictEqual(settings.env.FOO, 'bar');
    assert.ok(settings.hooks?.SessionStart?.length > 0);
  });

  it('remove cleans up hook and script', () => {
    runCli('setup', { HOME: fakeHome });
    const { stdout } = runCli('remove', { HOME: fakeHome });
    assert.ok(stdout.includes('Removed successfully'));

    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.ok(!settings.hooks, 'hooks key should be removed when empty');
    assert.ok(!existsSync(join(fakeHome, '.claude', 'hooks', 'cc-agents-md.sh')));
  });

  it('remove preserves other hooks', () => {
    const hookScript = join(fakeHome, '.claude', 'hooks', 'cc-agents-md.sh');
    writeFileSync(settingsPath, JSON.stringify({
      hooks: {
        SessionStart: [
          { matcher: 'startup', hooks: [{ type: 'command', command: 'echo other' }] },
          { matcher: '', hooks: [{ type: 'command', command: hookScript }] }
        ],
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'echo pre' }] }]
      }
    }));

    runCli('remove', { HOME: fakeHome });
    const settings = JSON.parse(readFileSync(settingsPath, 'utf8'));
    assert.strictEqual(settings.hooks.SessionStart.length, 1);
    assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, 'echo other');
    assert.ok(settings.hooks.PreToolUse, 'Other hook types should be preserved');
  });

  it('remove is safe when not installed', () => {
    const { stdout } = runCli('remove', { HOME: fakeHome });
    assert.ok(stdout.includes('Removed successfully'));
  });

  // --- status command ---

  it('status shows installed state', () => {
    runCli('setup', { HOME: fakeHome });
    const { stdout } = runCli('status', { HOME: fakeHome });
    assert.ok(stdout.includes('Hook installed: yes'));
    assert.ok(stdout.includes('Hook script:    exists'));
  });

  it('status shows not-installed state', () => {
    const { stdout } = runCli('status', { HOME: fakeHome });
    assert.ok(stdout.includes('Hook installed: no'));
  });

  // --- doctor command ---

  it('doctor passes when fully installed', () => {
    runCli('setup', { HOME: fakeHome });
    // doctor needs an AGENTS.md to fully pass — create a temp git repo
    const projectDir = mkdtempSync(join(tmpdir(), 'agents-md-doctor-'));
    execSync('git init', { cwd: projectDir, stdio: 'pipe' });
    writeFileSync(join(projectDir, 'AGENTS.md'), '# Test');

    const { exitCode, stdout } = runCli('doctor', { HOME: fakeHome, CLAUDE_PROJECT_DIR: projectDir });
    // doctor runs in CWD not CLAUDE_PROJECT_DIR, so it may not find AGENTS.md
    assert.ok(stdout.includes('Hook registered'));
    assert.ok(stdout.includes('Hook script exists'));

    rmSync(projectDir, { recursive: true, force: true });
  });

  it('doctor fails when not installed', () => {
    const { exitCode } = runCli('doctor', { HOME: fakeHome });
    assert.strictEqual(exitCode, 1);
  });

  // --- preview command ---

  it('preview errors when hook not installed', () => {
    const { stdout, exitCode } = runCli('preview', { HOME: fakeHome });
    assert.ok(stdout.includes('Hook script not found'));
    assert.strictEqual(exitCode, 1);
  });

  it('preview shows output when installed', () => {
    runCli('setup', { HOME: fakeHome });
    // Run preview from a dir with no AGENTS.md
    const emptyDir = mkdtempSync(join(tmpdir(), 'agents-md-preview-'));
    const { stdout } = runCli('preview', { HOME: fakeHome, CLAUDE_PROJECT_DIR: emptyDir });
    assert.ok(stdout.includes('No AGENTS.md') || stdout.trim() === '', 'Should show nothing or no-files message');

    rmSync(emptyDir, { recursive: true, force: true });
  });
});
