'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, writeFileSync, readFileSync, rmSync, copyFileSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const {
  ASYNC_READER_RE,
  PATCH_SENTINEL,
  isPatched,
  patchSource,
  unpatchSource,
  patchNpm,
  unpatchNpm,
  backupPath,
} = require('../lib/patcher');

// Realistic minified reader function (matches CC 2.1.92 pattern)
const READER_FN = 'async function l59(H,_,q){try{let O=await Y_().readFile(H,{encoding:"utf-8"});return un4(O,H,_,q)}catch(K){return mn4(K,H),{info:null,includePaths:[]}}}';

// Same pattern with different variable names (simulates different CC version)
const READER_FN_V2 = 'async function xQ3(a,b,c){try{let d=await fS().readFile(a,{encoding:"utf-8"});return pR7(d,a,b,c)}catch(e){return hE2(e,a),{info:null,includePaths:[]}}}';

// Source with surrounding code
const MOCK_SOURCE = `var before=1;${READER_FN}var after=2;`;
const MOCK_SOURCE_TWO = `var before=1;${READER_FN}var middle;${READER_FN_V2}var after=2;`;

describe('patcher.js', () => {
  // --- ASYNC_READER_RE ---

  it('regex matches the CC 2.1.92 reader function', () => {
    const matches = [...READER_FN.matchAll(ASYNC_READER_RE)];
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0][1], 'l59'); // function name
    assert.strictEqual(matches[0][2], 'H');   // path arg
    assert.strictEqual(matches[0][6], 'Y_');  // fs accessor
    assert.strictEqual(matches[0][7], 'un4'); // processor
    assert.strictEqual(matches[0][9], 'mn4'); // error handler
  });

  it('regex matches different variable names', () => {
    const matches = [...READER_FN_V2.matchAll(ASYNC_READER_RE)];
    assert.strictEqual(matches.length, 1);
    assert.strictEqual(matches[0][1], 'xQ3');
  });

  it('regex does not match unrelated async functions', () => {
    const unrelated = 'async function foo(a,b,c){return await bar()}';
    const matches = [...unrelated.matchAll(ASYNC_READER_RE)];
    assert.strictEqual(matches.length, 0);
  });

  // --- isPatched ---

  it('isPatched returns false for unpatched source', () => {
    assert.strictEqual(isPatched(MOCK_SOURCE), false);
  });

  it('isPatched returns true for patched source', () => {
    const { patched } = patchSource(MOCK_SOURCE);
    assert.strictEqual(isPatched(patched), true);
  });

  // --- patchSource ---

  it('patchSource patches one function', () => {
    const { patched, matchCount } = patchSource(MOCK_SOURCE);
    assert.strictEqual(matchCount, 1);
    assert.ok(patched.includes(PATCH_SENTINEL));
    assert.ok(patched.includes('AGENTS.md'));
    assert.ok(patched.includes('_ccamd_didReroute'));
  });

  it('patchSource patches multiple functions', () => {
    const { patched, matchCount } = patchSource(MOCK_SOURCE_TWO);
    assert.strictEqual(matchCount, 2);
  });

  it('patchSource preserves surrounding code', () => {
    const { patched } = patchSource(MOCK_SOURCE);
    assert.ok(patched.startsWith('var before=1;'));
    assert.ok(patched.endsWith('var after=2;'));
  });

  it('patchSource returns -1 for already-patched source', () => {
    const { patched } = patchSource(MOCK_SOURCE);
    const { matchCount } = patchSource(patched);
    assert.strictEqual(matchCount, -1);
  });

  it('patchSource returns 0 for source without reader function', () => {
    const { matchCount } = patchSource('var x = 1;');
    assert.strictEqual(matchCount, 0);
  });

  it('patched code has AGENTS.md fallback for CLAUDE.md', () => {
    const { patched } = patchSource(MOCK_SOURCE);
    assert.ok(patched.includes('endsWith("/CLAUDE.md")'));
    assert.ok(patched.includes('"AGENTS.md"'));
  });

  it('patched code has AGENTS.local.md fallback for CLAUDE.local.md', () => {
    const { patched } = patchSource(MOCK_SOURCE);
    assert.ok(patched.includes('endsWith("/CLAUDE.local.md")'));
    assert.ok(patched.includes('"AGENTS.local.md"'));
  });

  it('patched code has .claude/AGENTS.md fallback', () => {
    const { patched } = patchSource(MOCK_SOURCE);
    assert.ok(patched.includes('/.claude/AGENTS.md'));
  });

  it('patched code prevents infinite recursion via didReroute flag', () => {
    const { patched } = patchSource(MOCK_SOURCE);
    // The recursive call passes true as the didReroute parameter
    assert.ok(patched.includes(',true)'));
    // The guard checks !_ccamd_didReroute
    assert.ok(patched.includes('if(!_ccamd_didReroute)'));
  });

  // --- unpatchSource ---

  it('unpatchSource detects patched source', () => {
    const { patched } = patchSource(MOCK_SOURCE);
    const { wasPatched } = unpatchSource(patched);
    assert.strictEqual(wasPatched, true);
  });

  it('unpatchSource reports unpatched source', () => {
    const { wasPatched } = unpatchSource(MOCK_SOURCE);
    assert.strictEqual(wasPatched, false);
  });

  // --- patchNpm / unpatchNpm (file-level) ---

  it('patchNpm patches a mock cli.js file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patcher-test-'));
    const cliJs = join(dir, 'cli.js');
    writeFileSync(cliJs, MOCK_SOURCE);

    const result = patchNpm(cliJs);
    assert.strictEqual(result.success, true);
    assert.strictEqual(result.matchCount, 1);

    const content = readFileSync(cliJs, 'utf8');
    assert.ok(content.includes(PATCH_SENTINEL));
    assert.ok(content.includes('AGENTS.md'));

    // Backup was created
    assert.ok(readFileSync(backupPath(cliJs), 'utf8') === MOCK_SOURCE);

    rmSync(dir, { recursive: true, force: true });
  });

  it('patchNpm is idempotent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patcher-test-'));
    const cliJs = join(dir, 'cli.js');
    writeFileSync(cliJs, MOCK_SOURCE);

    patchNpm(cliJs);
    const result = patchNpm(cliJs);
    assert.strictEqual(result.success, false);
    assert.ok(result.message.includes('Already patched'));

    rmSync(dir, { recursive: true, force: true });
  });

  it('patchNpm dry-run does not modify file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patcher-test-'));
    const cliJs = join(dir, 'cli.js');
    writeFileSync(cliJs, MOCK_SOURCE);

    const result = patchNpm(cliJs, { dryRun: true });
    assert.strictEqual(result.success, true);
    assert.ok(result.message.includes('Dry run'));

    const content = readFileSync(cliJs, 'utf8');
    assert.strictEqual(content, MOCK_SOURCE); // Unchanged

    rmSync(dir, { recursive: true, force: true });
  });

  it('patchNpm fails on missing file', () => {
    const result = patchNpm('/nonexistent/cli.js');
    assert.strictEqual(result.success, false);
  });

  it('patchNpm fails on incompatible source', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patcher-test-'));
    const cliJs = join(dir, 'cli.js');
    writeFileSync(cliJs, 'var x = 1;');

    const result = patchNpm(cliJs);
    assert.strictEqual(result.success, false);
    assert.ok(result.message.includes('Could not find'));

    rmSync(dir, { recursive: true, force: true });
  });

  it('unpatchNpm restores from backup', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patcher-test-'));
    const cliJs = join(dir, 'cli.js');
    writeFileSync(cliJs, MOCK_SOURCE);

    patchNpm(cliJs);
    const result = unpatchNpm(cliJs);
    assert.strictEqual(result.success, true);

    const content = readFileSync(cliJs, 'utf8');
    assert.strictEqual(content, MOCK_SOURCE); // Restored

    rmSync(dir, { recursive: true, force: true });
  });

  it('unpatchNpm is safe when not patched', () => {
    const dir = mkdtempSync(join(tmpdir(), 'patcher-test-'));
    const cliJs = join(dir, 'cli.js');
    writeFileSync(cliJs, MOCK_SOURCE);

    const result = unpatchNpm(cliJs);
    assert.strictEqual(result.success, true);
    assert.ok(result.message.includes('Not patched'));

    rmSync(dir, { recursive: true, force: true });
  });
});
