'use strict';

const { readFileSync, writeFileSync, mkdirSync } = require('fs');
const { dirname } = require('path');

const HOOK_ID = 'cc-agents-md';

// Hook events that cc-agents-md registers
const HOOK_EVENTS = ['SessionStart', 'UserPromptSubmit', 'PreCompact'];

function readSettings(settingsPath) {
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return {};
    throw new Error(`Failed to read ${settingsPath}: ${err.message}`);
  }
}

function writeSettings(settingsPath, settings) {
  mkdirSync(dirname(settingsPath), { recursive: true, mode: 0o700 });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Check if a hook command matches cc-agents-md (substring fallback).
 */
function _matchesCcAgentsMd(command) {
  return (
    command?.endsWith('/cc-agents-md.sh') ||
    command?.endsWith('\\cc-agents-md.ps1') ||
    command?.includes('cc-agents-md.ps1') ||
    command?.endsWith('/' + HOOK_ID) ||
    command?.includes('cc-agents-md.sh')
  );
}

function isInstalled(settings, hookScriptPath) {
  const hooks = settings?.hooks?.SessionStart;
  if (!Array.isArray(hooks)) return false;
  if (hookScriptPath) {
    return hooks.some(h =>
      h.hooks?.some(inner =>
        inner.command === hookScriptPath ||
        inner.command?.includes(hookScriptPath)
      )
    );
  }
  return hooks.some(h =>
    h.hooks?.some(inner => _matchesCcAgentsMd(inner.command))
  );
}

/**
 * Check if a specific hook event is registered.
 */
function isEventRegistered(settings, event, hookScriptPath) {
  const hooks = settings?.hooks?.[event];
  if (!Array.isArray(hooks)) return false;
  if (hookScriptPath) {
    return hooks.some(h =>
      h.hooks?.some(inner =>
        inner.command === hookScriptPath ||
        inner.command?.includes(hookScriptPath)
      )
    );
  }
  return hooks.some(h =>
    h.hooks?.some(inner => _matchesCcAgentsMd(inner.command))
  );
}

/**
 * Build the hook command for a given event.
 * SessionStart: plain script invocation
 * UserPromptSubmit: set AGENTS_MD_HOOK_MODE=prompt
 * PreCompact: set AGENTS_MD_HOOK_MODE=compact
 */
function _buildCommand(hookScriptPath, event) {
  const isWindows = hookScriptPath.endsWith('.ps1');

  if (event === 'SessionStart') {
    return hookScriptPath;
  }

  const mode = event === 'UserPromptSubmit' ? 'prompt' : 'compact';

  if (isWindows) {
    return `$env:AGENTS_MD_HOOK_MODE='${mode}'; ${hookScriptPath}`;
  }
  return `AGENTS_MD_HOOK_MODE=${mode} ${hookScriptPath}`;
}

function addHook(settings, hookScriptPath) {
  if (!settings.hooks) settings.hooks = {};

  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) settings.hooks[event] = [];

    // Idempotent — skip if already present for this event
    if (isEventRegistered(settings, event, hookScriptPath)) continue;

    settings.hooks[event].push({
      matcher: '',
      hooks: [{
        type: 'command',
        command: _buildCommand(hookScriptPath, event)
      }]
    });
  }

  return settings;
}

function removeHook(settings, hookScriptPath) {
  if (!settings?.hooks) return settings;

  for (const event of HOOK_EVENTS) {
    if (!Array.isArray(settings.hooks[event])) continue;

    settings.hooks[event] = settings.hooks[event].filter(h => {
      if (hookScriptPath) {
        return !h.hooks?.some(inner =>
          inner.command === hookScriptPath ||
          inner.command?.includes(hookScriptPath)
        );
      }
      return !h.hooks?.some(inner => _matchesCcAgentsMd(inner.command));
    });

    if (settings.hooks[event].length === 0) delete settings.hooks[event];
  }

  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  return settings;
}

module.exports = { readSettings, writeSettings, isInstalled, isEventRegistered, addHook, removeHook, HOOK_ID, HOOK_EVENTS };
