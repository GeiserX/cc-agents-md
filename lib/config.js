'use strict';

const { readFileSync, existsSync } = require('fs');
const { join, dirname } = require('path');

const CONFIG_FILE = '.agents-md.json';

const DEFAULTS = {
  threshold: 200,
  patterns: ['AGENTS.md'],
  exclude: [],
  cache: true,
};

/**
 * Load .agents-md.json by walking up from startDir to root.
 * Returns the first config found, merged with defaults.
 *
 * @param {string} startDir - Directory to start searching from
 * @returns {{ config: object, configPath: string|null }}
 */
function loadConfig(startDir) {
  let dir = startDir;

  while (true) {
    const candidate = join(dir, CONFIG_FILE);
    if (existsSync(candidate)) {
      try {
        const raw = JSON.parse(readFileSync(candidate, 'utf8'));
        return { config: mergeConfig(raw), configPath: candidate };
      } catch (e) {
        // Malformed JSON — use defaults but report the error
        return { config: { ...DEFAULTS }, configPath: candidate, parseError: e.message };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return { config: { ...DEFAULTS }, configPath: null };
}

/**
 * Merge user config with defaults, validating types.
 */
function mergeConfig(raw) {
  const config = { ...DEFAULTS };

  if (typeof raw.threshold === 'number' && raw.threshold > 0) {
    config.threshold = raw.threshold;
  }

  if (Array.isArray(raw.patterns) && raw.patterns.length > 0 &&
      raw.patterns.every(p => typeof p === 'string')) {
    config.patterns = raw.patterns;
  }

  if (Array.isArray(raw.exclude) && raw.exclude.every(p => typeof p === 'string')) {
    config.exclude = raw.exclude;
  }

  if (typeof raw.cache === 'boolean') {
    config.cache = raw.cache;
  }

  return config;
}

module.exports = { loadConfig, CONFIG_FILE, DEFAULTS };
