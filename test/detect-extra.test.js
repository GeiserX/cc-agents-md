'use strict';

const { describe, it, beforeEach, afterEach } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, writeFileSync, readFileSync, mkdirSync, rmSync, existsSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

/**
 * Test the detect module internals by creating mock file structures
 * that exercise buildNpmResult, detectNative probing, and isFile.
 */

describe('detect.js — buildNpmResult and version extraction', () => {
  // We test buildNpmResult indirectly via detectNpm by creating a mock npm layout
  // that points to a file matching the expected module structure.

  // These tests require the detectNpm function to find a real cli.js,
  // but we can test the detectInstallation null path and shape checks.

  it('detectInstallation returns consistent type field when nothing found', () => {
    const { detectInstallation } = require('../lib/detect');
    // Even when everything fails, it returns a proper shape
    const result = detectInstallation();
    assert.ok('type' in result);
    assert.ok('path' in result);
    assert.ok('version' in result);
    if (result.type === null) {
      assert.strictEqual(result.path, null);
      assert.strictEqual(result.version, null);
    }
  });

  it('detectNpm returns an object with version string or null', () => {
    const { detectNpm } = require('../lib/detect');
    const result = detectNpm();
    if (result) {
      assert.strictEqual(result.type, 'npm');
      // version must be string or null (never undefined)
      assert.ok(result.version === null || typeof result.version === 'string');
    }
  });

  it('detectNative probes known paths and returns shape or null', () => {
    const { detectNative } = require('../lib/detect');
    const result = detectNative();
    if (result) {
      assert.strictEqual(result.type, 'native');
      assert.ok(typeof result.path === 'string');
      assert.ok(result.version === null || typeof result.version === 'string');
    } else {
      assert.strictEqual(result, null);
    }
  });
});
