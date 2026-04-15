'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('fs');
const { join } = require('path');
const { execSync } = require('child_process');
const { tmpdir } = require('os');

const LOADER = join(__dirname, '..', 'bin', 'loader.sh');

function runLoader(projectDir, env = {}) {
  try {
    return execSync(`bash "${LOADER}"`, {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_PROJECT_DIR: projectDir, ...env },
      timeout: 5000
    });
  } catch (err) {
    return err.stdout || '';
  }
}

describe('loader.sh', () => {
  let tmpDir;

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'agents-md-test-'));
    execSync('git init', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.name "test"', { cwd: tmpDir, stdio: 'pipe' });
    execSync('git config user.email "test@test.com"', { cwd: tmpDir, stdio: 'pipe' });
  });

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it('outputs nothing when no AGENTS.md exists', () => {
    const output = runLoader(tmpDir);
    assert.strictEqual(output.trim(), '');
  });

  it('loads root AGENTS.md', () => {
    writeFileSync(join(tmpDir, 'AGENTS.md'), '# Root instructions\nDo things.');
    const output = runLoader(tmpDir);
    assert.ok(output.includes('# AGENTS.md'), 'Should have header');
    assert.ok(output.includes('Root instructions'), 'Should include content');
    assert.ok(output.includes('Do things.'), 'Should include full content');
  });

  it('loads nested AGENTS.md files root-first', () => {
    const subDir = join(tmpDir, 'packages', 'frontend');
    mkdirSync(subDir, { recursive: true });
    writeFileSync(join(subDir, 'AGENTS.md'), '# Frontend rules');

    const output = runLoader(subDir);
    const rootIdx = output.indexOf('Root instructions');
    const frontendIdx = output.indexOf('Frontend rules');
    assert.ok(rootIdx >= 0, 'Root AGENTS.md should be present');
    assert.ok(frontendIdx >= 0, 'Frontend AGENTS.md should be present');
    assert.ok(rootIdx < frontendIdx, 'Root should come before nested');
  });

  it('does not load sibling directory AGENTS.md', () => {
    const backendDir = join(tmpDir, 'packages', 'backend');
    mkdirSync(backendDir, { recursive: true });
    writeFileSync(join(backendDir, 'AGENTS.md'), '# Backend rules');

    const frontendDir = join(tmpDir, 'packages', 'frontend');
    const output = runLoader(frontendDir);
    assert.ok(!output.includes('Backend rules'), 'Sibling AGENTS.md must NOT be loaded');
  });

  it('respects AGENTS_MD_MAX_LINES', () => {
    const bigContent = Array(100).fill('line of content').join('\n');
    writeFileSync(join(tmpDir, 'AGENTS.md'), bigContent);

    const output = runLoader(tmpDir, { AGENTS_MD_MAX_LINES: '10' });
    assert.ok(output.includes('TRUNCATED'), 'Should indicate truncation');
  });

  it('works without a git repo', () => {
    const noGitDir = mkdtempSync(join(tmpdir(), 'agents-md-nogit-'));
    writeFileSync(join(noGitDir, 'AGENTS.md'), '# No git here');

    const output = runLoader(noGitDir);
    assert.ok(output.includes('No git here'), 'Should load AGENTS.md without git');

    rmSync(noGitDir, { recursive: true, force: true });
  });

  it('exits silently on invalid project dir', () => {
    const output = runLoader('/nonexistent/path/that/does/not/exist');
    assert.strictEqual(output.trim(), '');
  });
});
