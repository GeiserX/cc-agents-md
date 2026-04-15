'use strict';

const { readFileSync, writeFileSync, mkdirSync } = require('fs');
const { dirname } = require('path');

const HOOK_ID = 'cc-agents-md';

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

function isInstalled(settings, hookScriptPath) {
  const hooks = settings?.hooks?.SessionStart;
  if (!Array.isArray(hooks)) return false;
  if (hookScriptPath) {
    return hooks.some(h =>
      h.hooks?.some(inner => inner.command === hookScriptPath)
    );
  }
  return hooks.some(h =>
    h.hooks?.some(inner =>
      inner.command?.endsWith('/cc-agents-md.sh') || inner.command?.endsWith('/' + HOOK_ID)
    )
  );
}

function addHook(settings, hookScriptPath) {
  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.SessionStart)) settings.hooks.SessionStart = [];

  // Idempotent — don't add if already present
  if (isInstalled(settings, hookScriptPath)) return settings;

  settings.hooks.SessionStart.push({
    matcher: '',
    hooks: [{
      type: 'command',
      command: hookScriptPath
    }]
  });

  return settings;
}

function removeHook(settings, hookScriptPath) {
  if (!settings?.hooks?.SessionStart) return settings;

  settings.hooks.SessionStart = settings.hooks.SessionStart.filter(h => {
    if (hookScriptPath) {
      return !h.hooks?.some(inner => inner.command === hookScriptPath);
    }
    return !h.hooks?.some(inner =>
      inner.command?.endsWith('/cc-agents-md.sh') || inner.command?.endsWith('/' + HOOK_ID)
    );
  });

  if (settings.hooks.SessionStart.length === 0) delete settings.hooks.SessionStart;
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  return settings;
}

module.exports = { readSettings, writeSettings, isInstalled, addHook, removeHook, HOOK_ID };
