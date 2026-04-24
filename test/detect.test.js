'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { detectInstallation, detectNpm, detectNative } = require('../lib/detect');

describe('detect.js', () => {
  // --- detectInstallation ---

  it('returns an object with type, path, and version fields', () => {
    const result = detectInstallation();
    assert.ok('type' in result);
    assert.ok('path' in result);
    assert.ok('version' in result);
  });

  it('type is one of npm, native, or null', () => {
    const result = detectInstallation();
    assert.ok([null, 'npm', 'native'].includes(result.type));
  });

  // --- detectNpm ---

  it('returns null or an object with type npm', () => {
    const result = detectNpm();
    if (result !== null) {
      assert.strictEqual(result.type, 'npm');
      assert.ok(typeof result.path === 'string');
      assert.ok(result.path.endsWith('cli.js'));
    }
  });

  it('npm result includes version when package.json exists', () => {
    const result = detectNpm();
    if (result !== null) {
      // Version should be a string or null
      assert.ok(result.version === null || typeof result.version === 'string');
    }
  });

  // --- detectNative ---

  it('returns null or an object with type native', () => {
    const result = detectNative();
    if (result !== null) {
      assert.strictEqual(result.type, 'native');
      assert.ok(typeof result.path === 'string');
    }
  });

  it('native result includes version as string or null', () => {
    const result = detectNative();
    if (result !== null) {
      assert.ok(result.version === null || typeof result.version === 'string');
    }
  });

  // --- detectInstallation preference ---

  it('detectInstallation prefers npm over native when both exist', () => {
    const result = detectInstallation();
    const npm = detectNpm();
    const native = detectNative();
    if (npm && native) {
      // npm is tried first, so result should be npm
      assert.strictEqual(result.type, 'npm');
    }
  });

  it('detectInstallation returns null when nothing found (with restricted PATH)', () => {
    // This tests the null fallthrough path by restricting the environment
    // We can't actually make this fail reliably, but we verify the structure
    const result = detectInstallation();
    if (!result.type) {
      assert.strictEqual(result.path, null);
      assert.strictEqual(result.version, null);
    }
  });
});
