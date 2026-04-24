'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, writeFileSync, mkdirSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const { loadConfig, CONFIG_FILE, DEFAULTS } = require('../lib/config');

describe('config.js', () => {
  const dirs = [];

  function makeTempDir() {
    const d = mkdtempSync(join(tmpdir(), 'config-test-'));
    dirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  // --- DEFAULTS ---

  it('exports expected default values', () => {
    assert.strictEqual(DEFAULTS.threshold, 200);
    assert.deepStrictEqual(DEFAULTS.patterns, ['AGENTS.md']);
    assert.deepStrictEqual(DEFAULTS.exclude, []);
    assert.strictEqual(DEFAULTS.cache, true);
  });

  it('exports CONFIG_FILE constant', () => {
    assert.strictEqual(CONFIG_FILE, '.agents-md.json');
  });

  // --- loadConfig: no config file ---

  it('returns defaults when no config file exists', () => {
    const dir = makeTempDir();
    const { config, configPath } = loadConfig(dir);
    assert.strictEqual(configPath, null);
    assert.deepStrictEqual(config, { ...DEFAULTS });
  });

  // --- loadConfig: finds config in current directory ---

  it('finds config in the start directory', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ threshold: 500 }));
    const { config, configPath } = loadConfig(dir);
    assert.strictEqual(configPath, join(dir, CONFIG_FILE));
    assert.strictEqual(config.threshold, 500);
  });

  // --- loadConfig: walks up to find config ---

  it('walks up directories to find config file', () => {
    const root = makeTempDir();
    const child = join(root, 'a', 'b', 'c');
    mkdirSync(child, { recursive: true });
    writeFileSync(join(root, CONFIG_FILE), JSON.stringify({ cache: false }));

    const { config, configPath } = loadConfig(child);
    assert.strictEqual(configPath, join(root, CONFIG_FILE));
    assert.strictEqual(config.cache, false);
  });

  it('returns first config found when walking up', () => {
    const root = makeTempDir();
    const mid = join(root, 'mid');
    const child = join(mid, 'child');
    mkdirSync(child, { recursive: true });

    writeFileSync(join(root, CONFIG_FILE), JSON.stringify({ threshold: 100 }));
    writeFileSync(join(mid, CONFIG_FILE), JSON.stringify({ threshold: 300 }));

    const { config, configPath } = loadConfig(child);
    assert.strictEqual(configPath, join(mid, CONFIG_FILE));
    assert.strictEqual(config.threshold, 300);
  });

  // --- loadConfig: malformed JSON ---

  it('returns defaults with parseError for malformed JSON', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), 'not valid json{{{');

    const { config, configPath, parseError } = loadConfig(dir);
    assert.strictEqual(configPath, join(dir, CONFIG_FILE));
    assert.ok(parseError, 'should have parseError');
    assert.deepStrictEqual(config, { ...DEFAULTS });
  });

  // --- mergeConfig: threshold validation ---

  it('ignores non-number threshold', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ threshold: 'big' }));
    const { config } = loadConfig(dir);
    assert.strictEqual(config.threshold, DEFAULTS.threshold);
  });

  it('ignores zero threshold', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ threshold: 0 }));
    const { config } = loadConfig(dir);
    assert.strictEqual(config.threshold, DEFAULTS.threshold);
  });

  it('ignores negative threshold', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ threshold: -5 }));
    const { config } = loadConfig(dir);
    assert.strictEqual(config.threshold, DEFAULTS.threshold);
  });

  it('accepts valid positive threshold', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ threshold: 42 }));
    const { config } = loadConfig(dir);
    assert.strictEqual(config.threshold, 42);
  });

  // --- mergeConfig: patterns validation ---

  it('ignores non-array patterns', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ patterns: 'AGENTS.md' }));
    const { config } = loadConfig(dir);
    assert.deepStrictEqual(config.patterns, DEFAULTS.patterns);
  });

  it('ignores empty array patterns', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ patterns: [] }));
    const { config } = loadConfig(dir);
    assert.deepStrictEqual(config.patterns, DEFAULTS.patterns);
  });

  it('ignores patterns with non-string elements', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ patterns: ['ok', 123] }));
    const { config } = loadConfig(dir);
    assert.deepStrictEqual(config.patterns, DEFAULTS.patterns);
  });

  it('accepts valid string array patterns', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ patterns: ['AGENTS.md', 'RULES.md'] }));
    const { config } = loadConfig(dir);
    assert.deepStrictEqual(config.patterns, ['AGENTS.md', 'RULES.md']);
  });

  // --- mergeConfig: exclude validation ---

  it('ignores non-array exclude', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ exclude: 'node_modules' }));
    const { config } = loadConfig(dir);
    assert.deepStrictEqual(config.exclude, DEFAULTS.exclude);
  });

  it('ignores exclude with non-string elements', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ exclude: [42] }));
    const { config } = loadConfig(dir);
    assert.deepStrictEqual(config.exclude, DEFAULTS.exclude);
  });

  it('accepts valid exclude array', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ exclude: ['vendor', 'dist'] }));
    const { config } = loadConfig(dir);
    assert.deepStrictEqual(config.exclude, ['vendor', 'dist']);
  });

  it('accepts empty exclude array', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ exclude: [] }));
    const { config } = loadConfig(dir);
    assert.deepStrictEqual(config.exclude, []);
  });

  // --- mergeConfig: cache validation ---

  it('ignores non-boolean cache', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ cache: 'yes' }));
    const { config } = loadConfig(dir);
    assert.strictEqual(config.cache, DEFAULTS.cache);
  });

  it('accepts cache set to false', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ cache: false }));
    const { config } = loadConfig(dir);
    assert.strictEqual(config.cache, false);
  });

  it('accepts cache set to true', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ cache: true }));
    const { config } = loadConfig(dir);
    assert.strictEqual(config.cache, true);
  });

  // --- mergeConfig: multiple fields combined ---

  it('merges multiple valid fields together', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({
      threshold: 50,
      patterns: ['RULES.md'],
      exclude: ['build'],
      cache: false,
    }));
    const { config } = loadConfig(dir);
    assert.strictEqual(config.threshold, 50);
    assert.deepStrictEqual(config.patterns, ['RULES.md']);
    assert.deepStrictEqual(config.exclude, ['build']);
    assert.strictEqual(config.cache, false);
  });

  it('ignores unknown keys and preserves defaults', () => {
    const dir = makeTempDir();
    writeFileSync(join(dir, CONFIG_FILE), JSON.stringify({ unknown: 'field', extra: 123 }));
    const { config } = loadConfig(dir);
    assert.deepStrictEqual(config, { ...DEFAULTS });
  });
});
