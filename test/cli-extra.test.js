'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');
const { tmpdir } = require('os');

const CLI = join(__dirname, '..', 'bin', 'cli.js');

function runCli(args, env = {}, cwd) {
  const opts = {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 10000,
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

describe('CLI — migrate command', () => {
  let fakeHome;
  let projectDir;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-migrate-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    projectDir = mkdtempSync(join(tmpdir(), 'agents-md-project-'));
    execSync('git init', { cwd: projectDir, stdio: 'pipe' });
    execSync('git config user.name "test"', { cwd: projectDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: projectDir, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('migrate reports no files when no CLAUDE.md exists', () => {
    const { stdout } = runCli('migrate', { HOME: fakeHome }, projectDir);
    assert.ok(stdout.includes('No CLAUDE.md'));
  });

  it('migrate converts CLAUDE.md to AGENTS.md', () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# My instructions');
    const { stdout } = runCli('migrate', { HOME: fakeHome }, projectDir);
    assert.ok(stdout.includes('migrated'));
    assert.ok(existsSync(join(projectDir, 'AGENTS.md')));
    const content = readFileSync(join(projectDir, 'AGENTS.md'), 'utf8');
    assert.ok(content.includes('My instructions'));
  });

  it('migrate dry-run does not create files', () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Dry run test');
    const { stdout } = runCli('migrate --dry-run', { HOME: fakeHome }, projectDir);
    assert.ok(stdout.includes('would migrate'));
    assert.ok(stdout.includes('dry run'));
    assert.ok(!existsSync(join(projectDir, 'AGENTS.md')), 'should not create AGENTS.md');
  });

  it('migrate skips when AGENTS.md already exists', () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Source');
    writeFileSync(join(projectDir, 'AGENTS.md'), '# Already here');
    const { stdout } = runCli('migrate', { HOME: fakeHome }, projectDir);
    assert.ok(stdout.includes('skip'));
    assert.ok(stdout.includes('already exists'));
  });

  it('migrate removes @AGENTS.md references from content', () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Instructions\n@AGENTS.md\nMore content');
    runCli('migrate', { HOME: fakeHome }, projectDir);
    const content = readFileSync(join(projectDir, 'AGENTS.md'), 'utf8');
    assert.ok(!content.includes('@AGENTS.md'), 'should remove self-referential import');
    assert.ok(content.includes('More content'));
  });

  it('migrate --delete removes original CLAUDE.md', () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# Delete me');
    const { stdout } = runCli('migrate --delete', { HOME: fakeHome }, projectDir);
    assert.ok(stdout.includes('deleted'));
    assert.ok(!existsSync(join(projectDir, 'CLAUDE.md')), 'original should be deleted');
    assert.ok(existsSync(join(projectDir, 'AGENTS.md')));
  });

  it('migrate handles CLAUDE.local.md', () => {
    writeFileSync(join(projectDir, 'CLAUDE.local.md'), '# Local config');
    runCli('migrate', { HOME: fakeHome }, projectDir);
    assert.ok(existsSync(join(projectDir, 'AGENTS.local.md')));
    const content = readFileSync(join(projectDir, 'AGENTS.local.md'), 'utf8');
    assert.ok(content.includes('Local config'));
  });

  it('migrate handles .claude/CLAUDE.md', () => {
    mkdirSync(join(projectDir, '.claude'), { recursive: true });
    writeFileSync(join(projectDir, '.claude', 'CLAUDE.md'), '# Dot claude');
    runCli('migrate', { HOME: fakeHome }, projectDir);
    assert.ok(existsSync(join(projectDir, '.claude', 'AGENTS.md')));
  });

  it('migrate --json outputs machine-readable format', () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# JSON test');
    const { stdout } = runCli('migrate --json', { HOME: fakeHome }, projectDir);
    const parsed = JSON.parse(stdout);
    assert.ok(Array.isArray(parsed.migrated));
    assert.ok(Array.isArray(parsed.skipped));
    assert.ok(Array.isArray(parsed.deleted));
    assert.strictEqual(parsed.migrated.length, 1);
  });

  it('migrate --json --dry-run reports what would happen', () => {
    writeFileSync(join(projectDir, 'CLAUDE.md'), '# JSON dry');
    const { stdout } = runCli('migrate --json --dry-run', { HOME: fakeHome }, projectDir);
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.migrated.length, 1);
    assert.ok(!existsSync(join(projectDir, 'AGENTS.md')));
  });

  it('migrate --json with no files outputs empty arrays', () => {
    const { stdout } = runCli('migrate --json', { HOME: fakeHome }, projectDir);
    const parsed = JSON.parse(stdout);
    assert.deepStrictEqual(parsed, { migrated: [], skipped: [], deleted: [] });
  });
});

describe('CLI — logs command', () => {
  let fakeHome;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-logs-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('logs reports no file when log does not exist', () => {
    const { stdout } = runCli('logs', { HOME: fakeHome });
    assert.ok(stdout.includes('No log file'));
  });

  it('logs shows content when log file exists', () => {
    const logPath = join(fakeHome, '.claude', 'cc-agents-md-autopatch.log');
    const lines = Array.from({ length: 100 }, (_, i) => `log line ${i + 1}`);
    writeFileSync(logPath, lines.join('\n') + '\n');

    const { stdout } = runCli('logs', { HOME: fakeHome });
    assert.ok(stdout.includes('last 50 lines'));
    assert.ok(stdout.includes('log line 100'));
    // Should NOT contain very early lines
    assert.ok(!stdout.includes('log line 1\n'), 'should not contain earliest lines');
  });

  it('logs --json outputs structured data', () => {
    const logPath = join(fakeHome, '.claude', 'cc-agents-md-autopatch.log');
    writeFileSync(logPath, 'line 1\nline 2\nline 3\n');

    const { stdout } = runCli('logs --json', { HOME: fakeHome });
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.path.includes('autopatch.log'));
    assert.ok(typeof parsed.totalLines === 'number');
    assert.ok(Array.isArray(parsed.lines));
  });

  it('logs --json reports error when no file', () => {
    const { stdout } = runCli('logs --json', { HOME: fakeHome });
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.error.includes('No log file'));
  });
});

describe('CLI — status --json', () => {
  let fakeHome;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-status-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('status --json outputs valid JSON', () => {
    const { stdout } = runCli('status --json', { HOME: fakeHome });
    const parsed = JSON.parse(stdout);
    assert.ok(typeof parsed.hookInstalled === 'boolean');
    assert.ok(typeof parsed.project === 'string');
    assert.ok(Array.isArray(parsed.files));
  });

  it('status --json reflects installed state', () => {
    runCli('setup', { HOME: fakeHome });
    const { stdout } = runCli('status --json', { HOME: fakeHome });
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.hookInstalled, true);
    assert.ok(parsed.hookScript !== null);
  });
});

describe('CLI — doctor --json', () => {
  let fakeHome;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-doctor-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
  });

  it('doctor --json outputs valid JSON with checks array', () => {
    runCli('setup', { HOME: fakeHome });
    const { stdout } = runCli('doctor --json', { HOME: fakeHome });
    const parsed = JSON.parse(stdout);
    assert.ok(typeof parsed.ok === 'boolean');
    assert.ok(Array.isArray(parsed.checks));
    assert.ok(parsed.checks.length > 0);
    for (const c of parsed.checks) {
      assert.ok(typeof c.label === 'string');
      assert.ok(typeof c.pass === 'boolean');
    }
  });
});

describe('CLI — preview --json', () => {
  let fakeHome;
  let projectDir;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-preview-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    projectDir = mkdtempSync(join(tmpdir(), 'agents-md-preview-proj-'));
    execSync('git init', { cwd: projectDir, stdio: 'pipe' });
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(projectDir, { recursive: true, force: true });
  });

  it('preview --json outputs null when no AGENTS.md', () => {
    runCli('setup', { HOME: fakeHome });
    const { stdout } = runCli('preview --json', { HOME: fakeHome, CLAUDE_PROJECT_DIR: projectDir });
    const parsed = JSON.parse(stdout);
    assert.strictEqual(parsed.output, null);
  });

  it('preview --json outputs content when AGENTS.md exists', () => {
    runCli('setup', { HOME: fakeHome });
    writeFileSync(join(projectDir, 'AGENTS.md'), '# JSON preview test');
    const { stdout } = runCli('preview --json', { HOME: fakeHome, CLAUDE_PROJECT_DIR: projectDir });
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.output.includes('JSON preview test'));
  });
});

describe('CLI — migrate in non-git directory', () => {
  let fakeHome;
  let noGitDir;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-migrate-nogit-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    noGitDir = mkdtempSync(join(tmpdir(), 'agents-md-nogit-'));
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(noGitDir, { recursive: true, force: true });
  });

  it('migrate works in non-git directory', () => {
    writeFileSync(join(noGitDir, 'CLAUDE.md'), '# No git');
    const { stdout } = runCli('migrate', { HOME: fakeHome }, noGitDir);
    assert.ok(stdout.includes('migrated'));
    assert.ok(existsSync(join(noGitDir, 'AGENTS.md')));
  });

  it('migrate --dry-run --delete reports what would be deleted', () => {
    writeFileSync(join(noGitDir, 'CLAUDE.md'), '# Delete dry');
    const { stdout } = runCli('migrate --dry-run --delete', { HOME: fakeHome }, noGitDir);
    assert.ok(stdout.includes('would migrate'));
    assert.ok(stdout.includes('would delete'));
    assert.ok(existsSync(join(noGitDir, 'CLAUDE.md')), 'original should still exist');
  });

  it('migrate --json --dry-run --delete includes deleted array', () => {
    writeFileSync(join(noGitDir, 'CLAUDE.md'), '# Delete dry json');
    const { stdout } = runCli('migrate --json --dry-run --delete', { HOME: fakeHome }, noGitDir);
    const parsed = JSON.parse(stdout);
    assert.ok(parsed.deleted.length > 0);
  });
});

describe('CLI — patch without --auto shows warning', () => {
  let fakeHome;
  let fakeNpmDir;
  let fakeCliJs;

  beforeEach(() => {
    fakeHome = mkdtempSync(join(tmpdir(), 'agents-md-cli-patchwarn-'));
    mkdirSync(join(fakeHome, '.claude'), { recursive: true });
    fakeNpmDir = mkdtempSync(join(tmpdir(), 'agents-md-fake-npm-warn-'));
    fakeCliJs = join(fakeNpmDir, 'cli.js');
    const READER_FN = 'async function l59(H,_,q){try{let O=await Y_().readFile(H,{encoding:"utf-8"});return un4(O,H,_,q)}catch(K){return mn4(K,H),{info:null,includePaths:[]}}}';
    writeFileSync(fakeCliJs, `var before=1;${READER_FN}var after=2;`);
  });

  afterEach(() => {
    rmSync(fakeHome, { recursive: true, force: true });
    rmSync(fakeNpmDir, { recursive: true, force: true });
  });

  it('patch without --auto shows experimental warning', () => {
    const { stdout } = runCli(`patch --path "${fakeCliJs}"`, { HOME: fakeHome });
    assert.ok(stdout.includes('EXPERIMENTAL'));
    assert.ok(stdout.includes('Restart Claude Code'));
  });

  it('unpatch without --auto shows detected info', () => {
    runCli(`patch --path "${fakeCliJs}" --auto`, { HOME: fakeHome });
    const { stdout } = runCli(`unpatch --path "${fakeCliJs}"`, { HOME: fakeHome });
    assert.ok(stdout.includes('Detected'));
    assert.ok(stdout.includes('npm'));
  });
});

describe('CLI — version aliases', () => {
  it('shows version with -v', () => {
    const { stdout } = runCli('-v');
    const pkg = require('../package.json');
    assert.strictEqual(stdout.trim(), pkg.version);
  });

  it('shows help with -h', () => {
    const { stdout } = runCli('-h');
    assert.ok(stdout.includes('cc-agents-md'));
    assert.ok(stdout.includes('setup'));
  });
});
