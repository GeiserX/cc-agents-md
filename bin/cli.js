#!/usr/bin/env node
'use strict';

const { copyFileSync, unlinkSync, existsSync, chmodSync, statSync, readFileSync, realpathSync } = require('fs');
const { join, dirname } = require('path');
const { execSync, execFileSync } = require('child_process');
const { mkdirSync } = require('fs');
const { readSettings, writeSettings, isInstalled, addHook, removeHook } = require('../lib/settings');
const { detectInstallation, detectNpm, detectNative } = require('../lib/detect');
const { patchNpm, unpatchNpm, isPatched: isPatchedSource, backupPath } = require('../lib/patcher');
const { patchNative, unpatchNative } = require('../lib/patch-native');

const HOME = process.env.HOME || process.env.USERPROFILE;
if (!HOME) {
  console.error('Error: HOME environment variable is not set.');
  process.exit(1);
}

const CLAUDE_DIR = join(HOME, '.claude');
const HOOK_DIR = join(CLAUDE_DIR, 'hooks');
const HOOK_SCRIPT = join(HOOK_DIR, 'cc-agents-md.sh');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const SOURCE_SCRIPT = join(__dirname, 'loader.sh');

function findAgentsMd(from, root) {
  if (!root) {
    try {
      root = execSync('git rev-parse --show-toplevel', { cwd: from, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    } catch {
      root = from;
    }
  }

  const files = [];
  let dir;
  try { dir = realpathSync(from); } catch { dir = from; }
  try { root = realpathSync(root); } catch { /* keep as-is */ }

  while (true) {
    const candidate = join(dir, 'AGENTS.md');
    if (existsSync(candidate)) files.unshift(candidate);
    if (dir === root) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  return files;
}

function setup() {
  const settings = readSettings(SETTINGS_PATH);
  const hookRegistered = isInstalled(settings, HOOK_SCRIPT);
  const scriptExists = existsSync(HOOK_SCRIPT);

  if (hookRegistered && scriptExists) {
    console.log('Already installed. Run "cc-agents-md doctor" to verify.');
    return;
  }

  // Copy loader script (also repairs missing script)
  mkdirSync(HOOK_DIR, { recursive: true });
  copyFileSync(SOURCE_SCRIPT, HOOK_SCRIPT);
  chmodSync(HOOK_SCRIPT, 0o755);

  // Add hook to settings only if not already registered
  if (!hookRegistered) {
    addHook(settings, HOOK_SCRIPT);
    writeSettings(SETTINGS_PATH, settings);
  }

  console.log('Installed successfully.');
  console.log(`  Hook script: ${HOOK_SCRIPT}`);
  console.log(`  Settings:    ${SETTINGS_PATH}`);
  console.log('\nRestart Claude Code for changes to take effect.');
}

function remove() {
  const settings = readSettings(SETTINGS_PATH);
  removeHook(settings, HOOK_SCRIPT);
  writeSettings(SETTINGS_PATH, settings);

  try {
    unlinkSync(HOOK_SCRIPT);
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`Warning: Could not remove ${HOOK_SCRIPT}: ${err.message}`);
    }
  }

  console.log('Removed successfully.');
}

function status() {
  const settings = readSettings(SETTINGS_PATH);
  const installed = isInstalled(settings);

  console.log(`Hook installed: ${installed ? 'yes' : 'no'}`);
  console.log(`Hook script:    ${existsSync(HOOK_SCRIPT) ? 'exists' : 'missing'}`);

  const cwd = process.cwd();
  let root;
  try {
    root = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    root = cwd;
  }

  console.log(`\nProject:  ${cwd}`);
  console.log(`Git root: ${root}`);

  const files = findAgentsMd(cwd, root);
  if (files.length === 0) {
    console.log('\nNo AGENTS.md files found on path.');
  } else {
    console.log(`\nAGENTS.md files (${files.length}):`);
    for (const f of files) {
      const lines = readFileSync(f, 'utf8').split('\n').length;
      const rel = f.startsWith(root) ? f.slice(root.length + 1) || 'AGENTS.md' : f;
      console.log(`  ${rel} (${lines} lines)`);
    }
  }
}

function doctor() {
  let ok = true;

  function check(label, pass, detail) {
    const icon = pass ? '\u2713' : '\u2717';
    console.log(`${icon} ${label}${detail ? ` \u2014 ${detail}` : ''}`);
    if (!pass) ok = false;
  }

  const settings = readSettings(SETTINGS_PATH);
  check('Hook registered in settings.json', isInstalled(settings, HOOK_SCRIPT));
  check('Hook script exists', existsSync(HOOK_SCRIPT), HOOK_SCRIPT);

  if (existsSync(HOOK_SCRIPT)) {
    const stat = statSync(HOOK_SCRIPT);
    check('Hook script is executable', (stat.mode & 0o111) !== 0);
  }

  // Check for conflicting CLAUDE.md
  const cwd = process.cwd();
  const claudeMd = join(cwd, 'CLAUDE.md');
  if (existsSync(claudeMd)) {
    const content = readFileSync(claudeMd, 'utf8');
    if (content.includes('@AGENTS.md') || content.toLowerCase().includes('read agents.md')) {
      check('No conflicting CLAUDE.md import', false, 'CLAUDE.md references AGENTS.md — may cause double-loading');
    }
  }

  const files = findAgentsMd(cwd, null);
  check('AGENTS.md found in project', files.length > 0,
    files.length > 0 ? `${files.length} file(s)` : 'none in current project');

  console.log(`\n${ok ? 'All checks passed.' : 'Issues found — see above.'}`);
  process.exit(ok ? 0 : 1);
}

function preview() {
  if (!existsSync(HOOK_SCRIPT)) {
    console.error('Hook script not found. Run "cc-agents-md setup" first.');
    process.exit(1);
  }

  try {
    const env = { ...process.env };
    if (!env.CLAUDE_PROJECT_DIR) {
      env.CLAUDE_PROJECT_DIR = process.cwd();
    }
    const output = execFileSync('bash', [HOOK_SCRIPT], {
      encoding: 'utf8',
      env,
      timeout: 10000
    });
    if (output.trim()) {
      process.stdout.write(output);
    } else {
      console.log('No AGENTS.md files found — nothing would be injected.');
    }
  } catch (err) {
    console.error(`Error running loader: ${err.message}`);
    process.exit(1);
  }
}

/**
 * Parse --path <value> from argv.
 */
function parsePathArg() {
  const idx = process.argv.indexOf('--path');
  if (idx === -1 || idx + 1 >= process.argv.length) return null;
  return process.argv[idx + 1];
}

/**
 * Resolve the target installation. Supports --path override.
 * When no --path given, prefers an install that already has a backup
 * (i.e. was previously patched) before falling back to auto-detect.
 */
function resolveInstallation(pathOverride) {
  if (pathOverride) {
    if (!existsSync(pathOverride)) {
      console.error(`Specified path not found: ${pathOverride}`);
      process.exit(1);
    }
    // Detect type from file header
    const fd = require('fs').openSync(pathOverride, 'r');
    const buf = Buffer.alloc(4);
    require('fs').readSync(fd, buf, 0, 4, 0);
    require('fs').closeSync(fd);
    const isMachO = buf[0] === 0xCF && buf[1] === 0xFA && buf[2] === 0xED && buf[3] === 0xFE;
    const isELF = buf[0] === 0x7F && buf[1] === 0x45 && buf[2] === 0x4C && buf[3] === 0x46;
    const type = (isMachO || isELF) ? 'native' : 'npm';
    return { type, path: pathOverride, version: null };
  }

  // Check both installs; prefer one that already has a backup
  const npm = detectNpm();
  const native = detectNative();

  if (npm && existsSync(backupPath(npm.path))) return npm;
  if (native && existsSync(backupPath(native.path))) return native;

  // Fall back to auto-detect (prefers npm)
  return detectInstallation();
}

function patch() {
  const dryRun = process.argv.includes('--dry-run');
  const force = process.argv.includes('--force');
  const pathOverride = parsePathArg();

  console.log('\x1b[33m⚠  EXPERIMENTAL: This modifies Claude Code internals.\x1b[0m');
  console.log('   Patches may break after Claude Code updates.');
  console.log('   Run "cc-agents-md unpatch" to restore at any time.\n');

  const install = resolveInstallation(pathOverride);

  if (!install || !install.type) {
    console.error('Could not find Claude Code installation.');
    console.error('Ensure Claude Code is installed via npm or Homebrew.');
    console.error('Or specify a path: cc-agents-md patch --path /path/to/cli.js');
    process.exit(1);
  }

  console.log(`Detected: ${install.type} installation`);
  console.log(`Path:     ${install.path}`);
  if (install.version) console.log(`Version:  ${install.version}`);
  console.log();

  let result;
  if (install.type === 'npm') {
    result = patchNpm(install.path, { dryRun });
  } else if (install.type === 'native') {
    if (!force) {
      console.log('Native binary patching is risky — it modifies a signed executable.');
      console.log('Use --force to proceed, or install via npm for safer patching:');
      console.log('  npm install -g @anthropic-ai/claude-code');
      process.exit(1);
    }
    result = patchNative(install.path, { dryRun });
  } else {
    console.error(`Unsupported installation type: ${install.type}`);
    process.exit(1);
  }

  if (result.success) {
    console.log(result.message);
    if (!dryRun) {
      console.log('\nRestart Claude Code for the patch to take effect.');
      console.log('AGENTS.md files will now be loaded alongside CLAUDE.md.');
    }
  } else {
    console.error(result.message);
    process.exit(1);
  }
}

function unpatch() {
  const pathOverride = parsePathArg();
  const install = resolveInstallation(pathOverride);

  if (!install || !install.type) {
    console.error('Could not find Claude Code installation.');
    console.error('Or specify a path: cc-agents-md unpatch --path /path/to/cli.js');
    process.exit(1);
  }

  console.log(`Detected: ${install.type} installation`);
  console.log(`Path:     ${install.path}\n`);

  let result;
  if (install.type === 'npm') {
    result = unpatchNpm(install.path);
  } else if (install.type === 'native') {
    result = unpatchNative(install.path);
  } else {
    console.error(`Unsupported installation type: ${install.type}`);
    process.exit(1);
  }

  if (result.success) {
    console.log(result.message);
  } else {
    console.error(result.message);
    process.exit(1);
  }
}

// CLI dispatch
const command = process.argv[2];
const commands = { setup, remove, status, doctor, preview, patch, unpatch };

if (!command || command === '--help' || command === '-h') {
  console.log(`cc-agents-md — Load AGENTS.md into Claude Code sessions

Usage:
  cc-agents-md setup     Install the SessionStart hook
  cc-agents-md remove    Uninstall completely
  cc-agents-md status    Show installation state and detected files
  cc-agents-md doctor    Full health check
  cc-agents-md preview   Show what Claude would see

Experimental:
  cc-agents-md patch     Patch Claude Code to load AGENTS.md natively
  cc-agents-md unpatch   Restore Claude Code to original state

Patch options:
  --dry-run        Show what would be patched without modifying files
  --force          Required for native binary patching (Homebrew)

Options:
  --help, -h       Show this help
  --version, -v    Show version`);
  process.exit(0);
}

if (command === '--version' || command === '-v') {
  console.log(require('../package.json').version);
  process.exit(0);
}

if (!commands[command]) {
  console.error(`Unknown command: ${command}\nRun "cc-agents-md --help" for usage.`);
  process.exit(1);
}

commands[command]();
