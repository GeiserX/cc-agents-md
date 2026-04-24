'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, copyFileSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const { patchNative, unpatchNative } = require('../lib/patch-native');
const { PATCH_SENTINEL, backupPath } = require('../lib/patcher');

// Realistic reader function
const READER_FN = 'async function l59(H,_,q){try{let O=await Y_().readFile(H,{encoding:"utf-8"});return un4(O,H,_,q)}catch(K){return mn4(K,H),{info:null,includePaths:[]}}}';

describe('patch-native.js', () => {
  const dirs = [];

  function makeTempDir() {
    const d = mkdtempSync(join(tmpdir(), 'patch-native-test-'));
    dirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  // --- patchNative ---

  it('returns failure for non-existent binary', () => {
    const result = patchNative('/nonexistent/binary');
    assert.strictEqual(result.success, false);
    assert.ok(result.message.includes('not found'));
  });

  it('returns failure when already patched', () => {
    const dir = makeTempDir();
    const binary = join(dir, 'claude');
    writeFileSync(binary, PATCH_SENTINEL + 'other content');
    const result = patchNative(binary);
    assert.strictEqual(result.success, false);
    assert.ok(result.message.includes('Already patched'));
  });

  it('returns failure when no reader function found', () => {
    const dir = makeTempDir();
    const binary = join(dir, 'claude');
    writeFileSync(binary, 'var x = 1; function unrelated() {}');
    const result = patchNative(binary);
    assert.strictEqual(result.success, false);
    assert.ok(result.message.includes('Could not find'));
  });

  it('dry run reports matches without modifying file', () => {
    const dir = makeTempDir();
    const binary = join(dir, 'claude');
    const content = 'prefix' + READER_FN + 'suffix';
    writeFileSync(binary, content);

    const result = patchNative(binary, { dryRun: true });
    assert.strictEqual(result.success, true);
    assert.ok(result.message.includes('Dry run'));
    assert.ok(result.message.includes('1 location'));

    // File should be unchanged
    assert.strictEqual(readFileSync(binary, 'utf8'), content);
  });

  it('patches binary with null padding after function', () => {
    const dir = makeTempDir();
    const binary = join(dir, 'claude');

    // Build binary content: reader function followed by enough null bytes for growth
    const fnBuf = Buffer.from(READER_FN, 'utf8');
    const paddingSize = 200; // enough for the patch growth
    const buf = Buffer.alloc(fnBuf.length + paddingSize);
    fnBuf.copy(buf, 0);
    // rest is already zero

    writeFileSync(binary, buf);

    const result = patchNative(binary, { dryRun: false });
    assert.strictEqual(result.success, true);
    assert.ok(result.message.includes('Patched'));
    assert.ok(result.message.includes('1/1'));

    // Backup should exist
    const backup = backupPath(binary);
    assert.ok(existsSync(backup), 'backup should be created');

    // Patched content should include the sentinel
    const patched = readFileSync(binary, 'utf8');
    assert.ok(patched.includes(PATCH_SENTINEL));
  });

  it('skips functions without enough room and fails if none fit', () => {
    const dir = makeTempDir();
    const binary = join(dir, 'claude');

    // Reader function immediately followed by non-null data (no room)
    const content = READER_FN + 'more_code_no_nulls_here_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    writeFileSync(binary, content);

    const result = patchNative(binary);
    // The patch is longer than original, and there are no null bytes after, so it should fail
    assert.strictEqual(result.success, false);
    assert.ok(result.message.includes('none had room'));
  });

  it('patches multiple reader functions', () => {
    const dir = makeTempDir();
    const binary = join(dir, 'claude');

    const fn2 = 'async function xQ3(a,b,c){try{let d=await fS().readFile(a,{encoding:"utf-8"});return pR7(d,a,b,c)}catch(e){return hE2(e,a),{info:null,includePaths:[]}}}';

    const fnBuf1 = Buffer.from(READER_FN, 'utf8');
    const fnBuf2 = Buffer.from(fn2, 'utf8');
    const padding = 200;

    const buf = Buffer.alloc(fnBuf1.length + padding + fnBuf2.length + padding);
    fnBuf1.copy(buf, 0);
    fnBuf2.copy(buf, fnBuf1.length + padding);

    writeFileSync(binary, buf);

    const result = patchNative(binary, { dryRun: true });
    assert.strictEqual(result.success, true);
    assert.ok(result.message.includes('2 location'));
  });

  // --- unpatchNative ---

  it('restores from backup when backup exists', () => {
    const dir = makeTempDir();
    const binary = join(dir, 'claude');
    const backup = backupPath(binary);
    const original = 'original binary content';
    const patched = PATCH_SENTINEL + 'patched content';

    writeFileSync(binary, patched);
    writeFileSync(backup, original);

    const result = unpatchNative(binary);
    assert.strictEqual(result.success, true);
    assert.ok(result.message.includes('Restored'));
    assert.ok(!existsSync(backup), 'backup should be removed');
    assert.strictEqual(readFileSync(binary, 'utf8'), original);
  });

  it('reports not patched when binary lacks sentinel and no backup', () => {
    const dir = makeTempDir();
    const binary = join(dir, 'claude');
    writeFileSync(binary, 'clean binary');
    const result = unpatchNative(binary);
    assert.strictEqual(result.success, true);
    assert.ok(result.message.includes('Not patched'));
  });

  it('reports failure when patched but no backup exists', () => {
    const dir = makeTempDir();
    const binary = join(dir, 'claude');
    writeFileSync(binary, PATCH_SENTINEL + 'patched content');
    const result = unpatchNative(binary);
    assert.strictEqual(result.success, false);
    assert.ok(result.message.includes('no backup'));
  });

  it('returns failure for non-existent binary on unpatch', () => {
    const result = unpatchNative('/nonexistent/binary');
    assert.strictEqual(result.success, false);
    assert.ok(result.message.includes('not found'));
  });

  it('findAllReaderFunctions skips non-matching async function markers', () => {
    const dir = makeTempDir();
    const binary = join(dir, 'claude');
    // Content with "async function " prefix but NOT matching reader regex,
    // followed by the actual reader function
    const nonMatchingFn = 'async function unrelated(a,b,c){return await bar()}';
    const fnBuf = Buffer.from(nonMatchingFn + READER_FN, 'utf8');
    const padding = 200;
    const buf = Buffer.alloc(fnBuf.length + padding);
    fnBuf.copy(buf, 0);
    writeFileSync(binary, buf);

    // Should find only the real reader, skipping the non-matching async function
    const result = patchNative(binary, { dryRun: true });
    assert.strictEqual(result.success, true);
    assert.ok(result.message.includes('1 location'));
  });
});
