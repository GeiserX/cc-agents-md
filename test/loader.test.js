'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
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

function createGitRepo() {
  const dir = mkdtempSync(join(tmpdir(), 'agents-md-test-'));
  execSync('git init', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.name "test"', { cwd: dir, stdio: 'pipe' });
  execSync('git config user.email "test@test.com"', { cwd: dir, stdio: 'pipe' });
  return dir;
}

describe('loader.sh', () => {
  let tmpDir;

  beforeEach(() => {
    tmpDir = createGitRepo();
  });

  afterEach(() => {
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
    writeFileSync(join(tmpDir, 'AGENTS.md'), '# Root instructions');
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
    writeFileSync(join(tmpDir, 'AGENTS.md'), '# Root instructions');
    const frontendDir = join(tmpDir, 'packages', 'frontend');
    mkdirSync(frontendDir, { recursive: true });
    writeFileSync(join(frontendDir, 'AGENTS.md'), '# Frontend rules');
    const backendDir = join(tmpDir, 'packages', 'backend');
    mkdirSync(backendDir, { recursive: true });
    writeFileSync(join(backendDir, 'AGENTS.md'), '# Backend rules');

    const output = runLoader(frontendDir);
    assert.ok(!output.includes('Backend rules'), 'Sibling AGENTS.md must NOT be loaded');
  });

  it('inlines small files fully (under threshold)', () => {
    const content = Array(50).fill('line of content').join('\n');
    writeFileSync(join(tmpDir, 'AGENTS.md'), content);

    const output = runLoader(tmpDir);
    assert.ok(!output.includes('Read full file'), 'Small file should NOT have read instruction');
    assert.strictEqual(output.split('line of content').length - 1, 50, 'All 50 lines should be present');
  });

  it('shows preview + read instruction for large files', () => {
    const content = Array(500).fill('line of content').join('\n') + '\n';
    writeFileSync(join(tmpDir, 'AGENTS.md'), content);

    const output = runLoader(tmpDir);
    assert.ok(output.includes('lines'), 'Should show line count');
    assert.ok(output.includes('Read full file:'), 'Should have read instruction');
    assert.ok(output.includes(join(tmpDir, 'AGENTS.md')), 'Should include absolute path');
    // Should have preview lines but NOT all 500
    const contentLines = output.split('line of content').length - 1;
    assert.ok(contentLines >= 50, 'Should have at least preview lines');
    assert.ok(contentLines < 500, 'Should NOT have all lines');
  });

  it('respects AGENTS_MD_INLINE_THRESHOLD', () => {
    const content = Array(100).fill('line of content').join('\n');
    writeFileSync(join(tmpDir, 'AGENTS.md'), content);

    // Default threshold is 200, so 100 lines should inline
    const inlined = runLoader(tmpDir);
    assert.ok(!inlined.includes('Read full file'), 'Should inline under default threshold');

    // Set threshold to 50, so 100 lines should trigger preview
    const previewed = runLoader(tmpDir, { AGENTS_MD_INLINE_THRESHOLD: '50' });
    assert.ok(previewed.includes('Read full file'), 'Should preview when over custom threshold');
  });

  it('respects AGENTS_MD_PREVIEW_LINES', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `line-${i + 1}`);
    writeFileSync(join(tmpDir, 'AGENTS.md'), lines.join('\n'));

    const output = runLoader(tmpDir, { AGENTS_MD_PREVIEW_LINES: '10' });
    assert.ok(output.includes('line-10'), 'Should include line 10');
    assert.ok(!output.includes('line-11'), 'Should NOT include line 11');
    assert.ok(output.includes('Read full file'), 'Should have read instruction');
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

  it('handles mixed small and large files', () => {
    // Small root AGENTS.md
    writeFileSync(join(tmpDir, 'AGENTS.md'), '# Root\nSmall root file.');
    // Large nested AGENTS.md
    const subDir = join(tmpDir, 'packages', 'app');
    mkdirSync(subDir, { recursive: true });
    const bigContent = Array(500).fill('big line').join('\n') + '\n';
    writeFileSync(join(subDir, 'AGENTS.md'), bigContent);

    const output = runLoader(subDir);
    // Root should be inlined
    assert.ok(output.includes('Small root file.'), 'Small root should be inlined');
    // Nested should have read instruction
    assert.ok(output.includes('Read full file:'), 'Large nested should have read instruction');
    assert.ok(output.includes('lines'), 'Should show line count for large file');
  });
});
