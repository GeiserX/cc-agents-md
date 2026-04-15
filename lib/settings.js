'use strict';

const { readFileSync, writeFileSync, mkdirSync } = require('fs');
const { dirname } = require('path');

const HOOK_ID = 'agents-md-loader';

function readSettings(settingsPath) {
  try {
    return JSON.parse(readFileSync(settingsPath, 'utf8'));
  } catch {
    return {};
  }
}

function writeSettings(settingsPath, settings) {
  mkdirSync(dirname(settingsPath), { recursive: true });
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n');
}

function isInstalled(settings) {
  const hooks = settings?.hooks?.SessionStart;
  if (!Array.isArray(hooks)) return false;
  return hooks.some(h =>
    h.hooks?.some(inner => inner.command?.includes(HOOK_ID))
  );
}

function addHook(settings, hookScriptPath) {
  if (!settings.hooks) settings.hooks = {};
  if (!Array.isArray(settings.hooks.SessionStart)) settings.hooks.SessionStart = [];

  settings.hooks.SessionStart.push({
    matcher: '',
    hooks: [{
      type: 'command',
      command: hookScriptPath
    }]
  });

  return settings;
}

function removeHook(settings) {
  if (!settings?.hooks?.SessionStart) return settings;

  settings.hooks.SessionStart = settings.hooks.SessionStart.filter(h =>
    !h.hooks?.some(inner => inner.command?.includes(HOOK_ID))
  );

  if (settings.hooks.SessionStart.length === 0) delete settings.hooks.SessionStart;
  if (settings.hooks && Object.keys(settings.hooks).length === 0) delete settings.hooks;

  return settings;
}

module.exports = { readSettings, writeSettings, isInstalled, addHook, removeHook, HOOK_ID };
