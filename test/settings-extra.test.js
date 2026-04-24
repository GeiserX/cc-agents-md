'use strict';

const { describe, it } = require('node:test');
const assert = require('node:assert');
const { isEventRegistered, addHook, removeHook, HOOK_ID, HOOK_EVENTS } = require('../lib/settings');

describe('settings.js — extra coverage', () => {
  // --- HOOK_EVENTS ---

  it('exports HOOK_EVENTS array with three event types', () => {
    assert.ok(Array.isArray(HOOK_EVENTS));
    assert.strictEqual(HOOK_EVENTS.length, 3);
    assert.ok(HOOK_EVENTS.includes('SessionStart'));
    assert.ok(HOOK_EVENTS.includes('UserPromptSubmit'));
    assert.ok(HOOK_EVENTS.includes('PreCompact'));
  });

  it('exports HOOK_ID constant', () => {
    assert.strictEqual(HOOK_ID, 'cc-agents-md');
  });

  // --- isEventRegistered ---

  it('returns false for empty settings', () => {
    assert.strictEqual(isEventRegistered({}, 'SessionStart'), false);
  });

  it('returns false for event not in hooks', () => {
    const settings = { hooks: { SessionStart: [] } };
    assert.strictEqual(isEventRegistered(settings, 'PreCompact'), false);
  });

  it('returns false when hooks key is not an array', () => {
    const settings = { hooks: { SessionStart: 'invalid' } };
    assert.strictEqual(isEventRegistered(settings, 'SessionStart'), false);
  });

  it('returns true for registered event with substring match', () => {
    const settings = {
      hooks: {
        UserPromptSubmit: [{
          matcher: '',
          hooks: [{ type: 'command', command: 'AGENTS_MD_HOOK_MODE=prompt /path/cc-agents-md.sh' }],
        }],
      },
    };
    assert.strictEqual(isEventRegistered(settings, 'UserPromptSubmit'), true);
  });

  it('returns true for registered event with exact path', () => {
    const hookPath = '/home/user/.claude/hooks/cc-agents-md.sh';
    const settings = {
      hooks: {
        PreCompact: [{
          matcher: '',
          hooks: [{ type: 'command', command: `AGENTS_MD_HOOK_MODE=compact ${hookPath}` }],
        }],
      },
    };
    assert.strictEqual(isEventRegistered(settings, 'PreCompact', hookPath), true);
  });

  it('returns false when exact path does not match', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          matcher: '',
          hooks: [{ type: 'command', command: '/other/path/cc-agents-md.sh' }],
        }],
      },
    };
    assert.strictEqual(isEventRegistered(settings, 'SessionStart', '/specific/path.sh'), false);
  });

  // --- addHook: multi-event registration ---

  it('adds hooks for all three events', () => {
    const settings = {};
    addHook(settings, '/path/to/loader.sh');

    assert.ok(Array.isArray(settings.hooks.SessionStart));
    assert.ok(Array.isArray(settings.hooks.UserPromptSubmit));
    assert.ok(Array.isArray(settings.hooks.PreCompact));
    assert.strictEqual(settings.hooks.SessionStart.length, 1);
    assert.strictEqual(settings.hooks.UserPromptSubmit.length, 1);
    assert.strictEqual(settings.hooks.PreCompact.length, 1);
  });

  it('SessionStart command is plain script path', () => {
    const settings = {};
    addHook(settings, '/path/to/loader.sh');
    assert.strictEqual(settings.hooks.SessionStart[0].hooks[0].command, '/path/to/loader.sh');
  });

  it('UserPromptSubmit command includes AGENTS_MD_HOOK_MODE=prompt', () => {
    const settings = {};
    addHook(settings, '/path/to/loader.sh');
    const cmd = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.ok(cmd.includes('AGENTS_MD_HOOK_MODE=prompt'));
    assert.ok(cmd.includes('/path/to/loader.sh'));
  });

  it('PreCompact command includes AGENTS_MD_HOOK_MODE=compact', () => {
    const settings = {};
    addHook(settings, '/path/to/loader.sh');
    const cmd = settings.hooks.PreCompact[0].hooks[0].command;
    assert.ok(cmd.includes('AGENTS_MD_HOOK_MODE=compact'));
    assert.ok(cmd.includes('/path/to/loader.sh'));
  });

  it('Windows hook commands use powershell $env syntax', () => {
    const settings = {};
    addHook(settings, 'C:\\Users\\test\\.claude\\hooks\\cc-agents-md.ps1');
    const promptCmd = settings.hooks.UserPromptSubmit[0].hooks[0].command;
    assert.ok(promptCmd.includes("$env:AGENTS_MD_HOOK_MODE='prompt'"));
    const compactCmd = settings.hooks.PreCompact[0].hooks[0].command;
    assert.ok(compactCmd.includes("$env:AGENTS_MD_HOOK_MODE='compact'"));
  });

  it('addHook is idempotent across all events', () => {
    const settings = {};
    addHook(settings, '/path/cc-agents-md.sh');
    addHook(settings, '/path/cc-agents-md.sh');
    assert.strictEqual(settings.hooks.SessionStart.length, 1);
    assert.strictEqual(settings.hooks.UserPromptSubmit.length, 1);
    assert.strictEqual(settings.hooks.PreCompact.length, 1);
  });

  // --- removeHook: multi-event removal ---

  it('removes hooks from all three events', () => {
    const settings = {};
    addHook(settings, '/path/cc-agents-md.sh');
    removeHook(settings, '/path/cc-agents-md.sh');
    assert.ok(!settings.hooks, 'hooks should be fully cleaned up');
  });

  it('removeHook preserves unrelated events', () => {
    const settings = {
      hooks: {
        PreToolUse: [{ matcher: '', hooks: [{ type: 'command', command: 'echo pre' }] }],
      },
    };
    addHook(settings, '/path/cc-agents-md.sh');
    removeHook(settings, '/path/cc-agents-md.sh');
    assert.ok(settings.hooks.PreToolUse, 'PreToolUse should be preserved');
    assert.strictEqual(settings.hooks.PreToolUse.length, 1);
  });

  // --- _matchesCcAgentsMd edge cases (tested via isInstalled/isEventRegistered) ---

  it('matches command ending with /cc-agents-md', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          matcher: '',
          hooks: [{ type: 'command', command: '/usr/local/bin/cc-agents-md' }],
        }],
      },
    };
    assert.strictEqual(isEventRegistered(settings, 'SessionStart'), true);
  });

  it('matches command with backslash Windows path', () => {
    const settings = {
      hooks: {
        SessionStart: [{
          matcher: '',
          hooks: [{ type: 'command', command: 'C:\\Users\\test\\cc-agents-md.ps1' }],
        }],
      },
    };
    assert.strictEqual(isEventRegistered(settings, 'SessionStart'), true);
  });
});
