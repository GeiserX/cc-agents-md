'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { installWatch, removeWatch, watchStatus, MACOS_PLIST_PATH, MACOS_LABEL } = require('../lib/watch');

describe('watch.js', () => {
  // --- exports ---

  it('exports MACOS_LABEL constant', () => {
    assert.strictEqual(MACOS_LABEL, 'com.cc-agents-md.repatch');
  });

  it('exports MACOS_PLIST_PATH containing the label', () => {
    assert.ok(MACOS_PLIST_PATH.includes(MACOS_LABEL));
    assert.ok(MACOS_PLIST_PATH.endsWith('.plist'));
  });

  // --- installWatch platform dispatch ---

  it('installWatch returns a result object with success and message', () => {
    const result = installWatch();
    assert.ok(typeof result.success === 'boolean');
    assert.ok(typeof result.message === 'string');
  });

  // --- removeWatch platform dispatch ---

  it('removeWatch returns a result object with success and message', () => {
    const result = removeWatch();
    assert.ok(typeof result.success === 'boolean');
    assert.ok(typeof result.message === 'string');
  });

  // --- watchStatus platform dispatch ---

  it('watchStatus returns status object with installed and loaded', () => {
    const result = watchStatus();
    assert.ok(typeof result.installed === 'boolean');
    assert.ok(typeof result.loaded === 'boolean');
  });

  // --- platform-specific behavior ---

  if (process.platform === 'darwin') {
    it('watchStatus on macOS includes unitPath ending in .plist', () => {
      const result = watchStatus();
      assert.ok(result.unitPath.endsWith('.plist'));
    });
  }

  if (process.platform === 'linux') {
    it('watchStatus on linux includes unitPath ending in .path', () => {
      const result = watchStatus();
      assert.ok(result.unitPath.endsWith('.path'));
    });
  }

  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    it('installWatch returns failure on unsupported platform', () => {
      const result = installWatch();
      assert.strictEqual(result.success, false);
      assert.ok(result.message.includes('not supported'));
    });

    it('watchStatus returns null unitPath on unsupported platform', () => {
      const result = watchStatus();
      assert.strictEqual(result.unitPath, null);
    });
  }
});
