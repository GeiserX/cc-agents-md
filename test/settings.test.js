'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { readSettings, writeSettings, isInstalled, addHook, removeHook } = require('../lib/settings');
const { mkdtempSync, readFileSync, rmSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');

describe('settings.js', () => {
  it('readSettings returns empty object for missing file', () => {
    const result = readSettings('/nonexistent/settings.json');
    assert.deepStrictEqual(result, {});
  });

  it('readSettings throws on invalid JSON (not ENOENT)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'settings-test-'));
    const path = join(dir, 'settings.json');
    require('fs').writeFileSync(path, 'not json');
    assert.throws(() => readSettings(path), /Failed to read/);
    rmSync(dir, { recursive: true, force: true });
  });

  it('readSettings parses valid JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'settings-test-'));
    const path = join(dir, 'settings.json');
    require('fs').writeFileSync(path, '{"model":"opus"}');
    const result = readSettings(path);
    assert.strictEqual(result.model, 'opus');
    rmSync(dir, { recursive: true, force: true });
  });

  it('writeSettings creates file with pretty JSON', () => {
    const dir = mkdtempSync(join(tmpdir(), 'settings-test-'));
    const path = join(dir, 'settings.json');
    writeSettings(path, { foo: 'bar' });
    const content = readFileSync(path, 'utf8');
    assert.ok(content.includes('  "foo": "bar"'), 'Should be pretty-printed');
    assert.ok(content.endsWith('\n'), 'Should end with newline');
    rmSync(dir, { recursive: true, force: true });
  });

  it('writeSettings creates parent directories', () => {
    const dir = mkdtempSync(join(tmpdir(), 'settings-test-'));
    const path = join(dir, 'deep', 'nested', 'settings.json');
    writeSettings(path, { ok: true });
    const result = JSON.parse(readFileSync(path, 'utf8'));
    assert.strictEqual(result.ok, true);
    rmSync(dir, { recursive: true, force: true });
  });

  it('isInstalled returns false for empty settings', () => {
    assert.strictEqual(isInstalled({}), false);
  });

  it('isInstalled returns false for unrelated hooks', () => {
    const settings = {
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'echo hello' }] }]
      }
    };
    assert.strictEqual(isInstalled(settings), false);
  });

  it('isInstalled returns true when hook is present (substring fallback)', () => {
    const settings = {
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: '/path/cc-agents-md.sh' }] }]
      }
    };
    assert.strictEqual(isInstalled(settings), true);
  });

  it('isInstalled with exact path matches only that path', () => {
    const settings = {
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: '/home/user/.claude/hooks/cc-agents-md.sh' }] }]
      }
    };
    assert.strictEqual(isInstalled(settings, '/home/user/.claude/hooks/cc-agents-md.sh'), true);
    assert.strictEqual(isInstalled(settings, '/other/path/cc-agents-md.sh'), false);
  });

  it('addHook adds to empty settings', () => {
    const settings = {};
    addHook(settings, '/path/to/loader.sh');
    assert.strictEqual(settings.hooks.SessionStart.length, 1);
    assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, '/path/to/loader.sh');
  });

  it('addHook preserves existing hooks', () => {
    const settings = {
      hooks: {
        SessionStart: [{ matcher: 'startup', hooks: [{ type: 'command', command: 'echo existing' }] }]
      }
    };
    addHook(settings, '/path/to/loader.sh');
    assert.strictEqual(settings.hooks.SessionStart.length, 2);
    assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, 'echo existing');
  });

  it('removeHook with exact path removes only that entry', () => {
    const hookPath = '/home/user/.claude/hooks/cc-agents-md.sh';
    const settings = {
      hooks: {
        SessionStart: [
          { matcher: '', hooks: [{ type: 'command', command: 'echo other' }] },
          { matcher: '', hooks: [{ type: 'command', command: hookPath }] }
        ]
      }
    };
    removeHook(settings, hookPath);
    assert.strictEqual(settings.hooks.SessionStart.length, 1);
    assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, 'echo other');
  });

  it('removeHook without path uses substring fallback', () => {
    const settings = {
      hooks: {
        SessionStart: [
          { matcher: '', hooks: [{ type: 'command', command: 'echo other' }] },
          { matcher: '', hooks: [{ type: 'command', command: '/path/cc-agents-md.sh' }] }
        ]
      }
    };
    removeHook(settings);
    assert.strictEqual(settings.hooks.SessionStart.length, 1);
    assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, 'echo other');
  });

  it('removeHook cleans up empty hooks object', () => {
    const hookPath = '/cc-agents-md.sh';
    const settings = {
      hooks: {
        SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: hookPath }] }]
      }
    };
    removeHook(settings, hookPath);
    assert.ok(!settings.hooks, 'hooks key should be removed when empty');
  });

  it('removeHook is safe on empty settings', () => {
    const settings = {};
    removeHook(settings);
    assert.deepStrictEqual(settings, {});
  });
});
