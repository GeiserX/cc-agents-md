#!/usr/bin/env node
'use strict';

const { copyFileSync, unlinkSync, existsSync, chmodSync, statSync, readFileSync, writeFileSync, realpathSync } = require('fs');
const { join, dirname, relative } = require('path');
const { execSync, execFileSync } = require('child_process');
const { mkdirSync } = require('fs');
const { readSettings, writeSettings, isInstalled, isEventRegistered, addHook, removeHook, HOOK_EVENTS } = require('../lib/settings');
const { detectInstallation, detectNpm, detectNative } = require('../lib/detect');
const { patchNpm, unpatchNpm, isPatched: isPatchedSource, backupPath } = require('../lib/patcher');
const { patchNative, unpatchNative } = require('../lib/patch-native');
const { patchBun, unpatchBun, readPatchMeta } = require('../lib/patch-bun');
const { installWatch, removeWatch, watchStatus } = require('../lib/watch');
const { loadConfig, CONFIG_FILE } = require('../lib/config');

const HOME = process.env.HOME || process.env.USERPROFILE;
if (!HOME) {
  console.error('Error: HOME environment variable is not set.');
  process.exit(1);
}

const CLAUDE_DIR = join(HOME, '.claude');
const HOOK_DIR = join(CLAUDE_DIR, 'hooks');
const HOOK_SCRIPT = process.platform === 'win32'
  ? join(HOOK_DIR, 'cc-agents-md.ps1')
  : join(HOOK_DIR, 'cc-agents-md.sh');
const SETTINGS_PATH = join(CLAUDE_DIR, 'settings.json');
const SOURCE_SCRIPT = process.platform === 'win32'
  ? join(__dirname, 'loader.ps1')
  : join(__dirname, 'loader.sh');

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
  if (process.platform !== 'win32') {
    chmodSync(HOOK_SCRIPT, 0o755);
  }

  // Add hook to settings only if not already registered
  if (!hookRegistered) {
    // On Windows, Claude Code needs "powershell -File <script>" as the command
    const hookCommand = process.platform === 'win32'
      ? `powershell -NoProfile -ExecutionPolicy Bypass -File "${HOOK_SCRIPT}"`
      : HOOK_SCRIPT;
    addHook(settings, hookCommand);
    writeSettings(SETTINGS_PATH, settings);
  }

  console.log('Installed successfully.');
  console.log(`  Hook script: ${HOOK_SCRIPT}`);
  console.log(`  Settings:    ${SETTINGS_PATH}`);
  console.log(`  Hooks:       SessionStart, UserPromptSubmit, PreCompact`);
  console.log('\nAGENTS.md changes are detected mid-session and instructions survive context compression.');
  console.log('Restart Claude Code for changes to take effect.');
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
  const scriptExists = existsSync(HOOK_SCRIPT);

  const cwd = process.cwd();
  let root;
  try {
    root = execSync('git rev-parse --show-toplevel', { cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch {
    root = cwd;
  }

  const { config, configPath } = loadConfig(cwd);
  const files = findAgentsMd(cwd, root);
  const fileDetails = files.map(f => {
    try {
      const lines = readFileSync(f, 'utf8').split('\n').length;
      const rel = f.startsWith(root) ? f.slice(root.length + 1) || 'AGENTS.md' : f;
      return { path: f, rel, lines };
    } catch {
      return { path: f, rel: f, lines: 0, error: 'unreadable' };
    }
  });

  // Check all three hook events
  const hookEvents = {};
  for (const event of HOOK_EVENTS) {
    hookEvents[event] = isEventRegistered(settings, event);
  }

  if (JSON_FLAG) {
    console.log(JSON.stringify({
      hookInstalled: installed,
      hookScript: scriptExists ? HOOK_SCRIPT : null,
      hookEvents,
      project: cwd,
      gitRoot: root,
      config: configPath ? { path: configPath, ...config } : null,
      files: fileDetails,
    }, null, 2));
    return;
  }

  console.log(`Hook installed: ${installed ? 'yes' : 'no'}`);
  console.log(`Hook script:    ${scriptExists ? 'exists' : 'missing'}`);
  console.log(`Hook events:    ${HOOK_EVENTS.map(e => `${e} ${hookEvents[e] ? 'yes' : 'no'}`).join(', ')}`);

  console.log(`\nProject:  ${cwd}`);
  console.log(`Git root: ${root}`);

  if (configPath) {
    console.log(`Config:   ${configPath}`);
    if (config.patterns.length > 1 || config.patterns[0] !== 'AGENTS.md') {
      console.log(`Patterns: ${config.patterns.join(', ')}`);
    }
    if (config.exclude.length > 0) {
      console.log(`Exclude:  ${config.exclude.join(', ')}`);
    }
  }

  if (fileDetails.length === 0) {
    console.log('\nNo AGENTS.md files found on path.');
  } else {
    console.log(`\nAGENTS.md files (${fileDetails.length}):`);
    for (const f of fileDetails) {
      console.log(`  ${f.rel} (${f.lines} lines)`);
    }
  }
}

function doctor() {
  let ok = true;
  const checks = [];

  function check(label, pass, detail) {
    checks.push({ label, pass, detail: detail || null });
    if (!JSON_FLAG) {
      const icon = pass ? '\u2713' : '\u2717';
      console.log(`${icon} ${label}${detail ? ` \u2014 ${detail}` : ''}`);
    }
    if (!pass) ok = false;
  }

  const settings = readSettings(SETTINGS_PATH);
  check('Hook registered in settings.json', isInstalled(settings, HOOK_SCRIPT));
  check('Hook script exists', existsSync(HOOK_SCRIPT), HOOK_SCRIPT);

  // Check all three hook events
  for (const event of HOOK_EVENTS) {
    check(`${event} hook registered`, isEventRegistered(settings, event, HOOK_SCRIPT) || isEventRegistered(settings, event));
  }

  if (existsSync(HOOK_SCRIPT) && process.platform !== 'win32') {
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

  // Check config file
  const { configPath } = loadConfig(cwd);
  if (configPath) {
    check('Config file found', true, configPath);
  }

  // Check patch status
  const install = detectInstallation();
  if (install && install.type === 'native') {
    const meta = readPatchMeta(install.path);
    if (meta) {
      check('Native binary patched', true,
        `v${meta.version || '?'}, tier ${meta.regexTier}, ${meta.growth}b growth`);

      // Check if binary version changed (upgrade detected)
      try {
        const currentVer = execSync(`"${install.path}" --version`, {
          encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
        }).trim();
        if (meta.version && currentVer !== meta.version) {
          check('Patch matches current version', false,
            `patched v${meta.version} but running v${currentVer} — run "cc-agents-md patch --force" to repatch`);
        }
      } catch { /* binary may not run if patch is stale */ }
    } else {
      const { BUN_PATCH_MARKER } = require('../lib/patch-bun');
      try {
        const probe = readFileSync(install.path, { encoding: null });
        const patched = probe.includes(Buffer.from(BUN_PATCH_MARKER, 'utf8'));
        check('Native binary patched', patched, patched ? 'no metadata file' : 'not patched');
      } catch { /* best effort */ }
    }
  }

  // Check watcher status
  const ws = watchStatus();
  if (ws.installed) {
    check('Auto-repatch watcher installed', true, ws.loaded ? 'loaded' : 'installed but not loaded');
  }

  if (JSON_FLAG) {
    console.log(JSON.stringify({ ok, checks }, null, 2));
  } else {
    console.log(`\n${ok ? 'All checks passed.' : 'Issues found — see above.'}`);
  }
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
    const output = process.platform === 'win32'
      ? execFileSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', HOOK_SCRIPT], {
        encoding: 'utf8', env, timeout: 10000,
      })
      : execFileSync('bash', [HOOK_SCRIPT], {
        encoding: 'utf8', env, timeout: 10000,
      });
    if (output.trim()) {
      if (JSON_FLAG) {
        console.log(JSON.stringify({ output: output.trimEnd() }));
      } else {
        process.stdout.write(output);
      }
    } else {
      if (JSON_FLAG) {
        console.log(JSON.stringify({ output: null }));
      } else {
        console.log('No AGENTS.md files found — nothing would be injected.');
      }
    }
  } catch (err) {
    console.error(`Error running loader: ${err.message}`);
    process.exit(1);
  }
}

function logs() {
  const LOG_PATH = join(HOME, '.claude', 'cc-agents-md-autopatch.log');
  if (!existsSync(LOG_PATH)) {
    if (JSON_FLAG) {
      console.log(JSON.stringify({ error: 'No log file found', path: LOG_PATH }));
    } else {
      console.log(`No log file found at ${LOG_PATH}`);
      console.log('Logs are created by the auto-repatch watcher (cc-agents-md watch).');
    }
    return;
  }

  const n = parseLinesArg(50);
  const content = readFileSync(LOG_PATH, 'utf8');
  const lines = content.split('\n');
  const tail = lines.slice(-n).join('\n');

  if (JSON_FLAG) {
    console.log(JSON.stringify({ path: LOG_PATH, totalLines: lines.length, lines: lines.slice(-n) }));
  } else {
    console.log(`--- ${LOG_PATH} (last ${n} lines) ---\n`);
    process.stdout.write(tail);
    if (!tail.endsWith('\n')) process.stdout.write('\n');
  }
}

function diff() {
  const pathOverride = parsePathArg();
  const install = resolveInstallation(pathOverride);

  if (!install || !install.type) {
    console.error('Could not find Claude Code installation.');
    process.exit(1);
  }

  const backup = backupPath(install.path);
  if (!existsSync(backup)) {
    console.log('No backup found — Claude Code is not patched (or was patched without backup).');
    return;
  }

  if (JSON_FLAG) {
    const meta = install.type === 'native' ? readPatchMeta(install.path) : null;
    console.log(JSON.stringify({
      type: install.type,
      path: install.path,
      backup,
      meta,
    }, null, 2));
    return;
  }

  console.log(`Type:    ${install.type}`);
  console.log(`Current: ${install.path}`);
  console.log(`Backup:  ${backup}\n`);

  if (install.type === 'npm') {
    // Text diff for npm cli.js
    if (process.platform === 'win32') {
      console.log('Unified diff not available on Windows. Compare manually:');
      console.log(`  Original: ${backup}`);
      console.log(`  Current:  ${install.path}`);
      return;
    }
    try {
      const out = execFileSync('diff', ['-u', backup, install.path], {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      console.log(out || 'Files are identical.');
    } catch (err) {
      // diff exits 1 when files differ — that's the normal case
      if (err.stdout) {
        process.stdout.write(err.stdout);
      } else {
        console.log('Could not run diff.');
      }
    }
  } else {
    // Binary diff — show metadata and size comparison
    const meta = readPatchMeta(install.path);
    if (meta) {
      console.log('Patch metadata:');
      console.log(`  Version:     ${meta.version || '?'}`);
      console.log(`  Patched at:  ${meta.patchedAt}`);
      console.log(`  Regex tier:  ${meta.regexTier} (${meta.regexTierDesc})`);
      console.log(`  Growth:      ${meta.growth} bytes`);
      console.log(`  Source size:  ${meta.sourceSizeOriginal} → ${meta.sourceSizePatched}`);
    } else {
      console.log('No patch metadata found.');
    }

    const currentSize = statSync(install.path).size;
    const backupSize = statSync(backup).size;
    console.log(`\nFile size: ${backupSize} → ${currentSize} (${currentSize === backupSize ? 'same' : 'changed'})`);
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
 * Parse --lines <N> from argv (default 50).
 */
function parseLinesArg(def = 50) {
  const idx = process.argv.indexOf('--lines');
  if (idx === -1 || idx + 1 >= process.argv.length) return def;
  const n = parseInt(process.argv[idx + 1], 10);
  return n > 0 ? n : def;
}

const JSON_FLAG = process.argv.includes('--json');
const VERBOSE_FLAG = process.argv.includes('--verbose');

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
  const auto = process.argv.includes('--auto');
  const pathOverride = parsePathArg();

  if (!auto) {
    console.log('\x1b[33m⚠  EXPERIMENTAL: This modifies Claude Code internals.\x1b[0m');
    console.log('   Patches may break after Claude Code updates.');
    console.log('   Run "cc-agents-md unpatch" to restore at any time.\n');
  }

  const install = resolveInstallation(pathOverride);

  if (!install || !install.type) {
    console.error('Could not find Claude Code installation.');
    console.error('Ensure Claude Code is installed via npm or Homebrew.');
    console.error('Or specify a path: cc-agents-md patch --path /path/to/cli.js');
    process.exit(1);
  }

  const log = auto
    ? (...args) => console.log(`[${new Date().toISOString()}]`, ...args)
    : console.log.bind(console);

  log(`Detected: ${install.type} installation`);
  log(`Path:     ${install.path}`);
  if (install.version) log(`Version:  ${install.version}`);
  if (VERBOSE_FLAG) {
    const { config: cfg, configPath: cfgPath } = loadConfig(process.cwd());
    if (cfgPath) log(`Config:   ${cfgPath}`);
    log(`Patterns: ${cfg.patterns.join(', ')}`);
    log(`Cache:    ${cfg.cache ? 'enabled' : 'disabled'}`);
  }
  if (!auto) console.log();

  let result;
  if (install.type === 'npm') {
    result = patchNpm(install.path, { dryRun });
  } else if (install.type === 'native') {
    if (!force && !auto) {
      console.log('Native binary patching modifies a signed executable.');
      console.log('Use --force to proceed, or install via npm for safer patching:');
      console.log('  npm install -g @anthropic-ai/claude-code');
      process.exit(1);
    }
    // Try Bun-format-aware patching first, fall back to legacy byte replacement
    result = patchBun(install.path, { dryRun });
    if (!result.success && result.message.includes('no __BUN section')) {
      result = patchNative(install.path, { dryRun });
    }
  } else {
    console.error(`Unsupported installation type: ${install.type}`);
    process.exit(1);
  }

  if (result.success) {
    log(result.message);
    if (VERBOSE_FLAG && install.type === 'native') {
      const meta = readPatchMeta(install.path);
      if (meta) {
        log(`\nVerbose patch details:`);
        log(`  Regex tier:     ${meta.regexTier} (${meta.regexTierDesc})`);
        log(`  Source growth:   ${meta.growth} bytes`);
        log(`  Source original: ${meta.sourceSizeOriginal} bytes`);
        log(`  Source patched:  ${meta.sourceSizePatched} bytes`);
        log(`  Size locations:  ${meta.sizeLocations}`);
      }
    }
    if (!dryRun && !auto) {
      console.log('\nRestart Claude Code for the patch to take effect.');
      console.log('AGENTS.md files will now be loaded alongside CLAUDE.md.');
    }
  } else {
    if (auto && result.message.includes('Already patched')) {
      log('Already patched — nothing to do.');
      return;
    }
    log(result.message);
    if (!auto) process.exit(1);
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
    // Try Bun unpatch first, fall back to legacy
    result = unpatchBun(install.path);
    if (!result.success && result.message.includes('no backup')) {
      result = unpatchNative(install.path);
    }
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

function watch() {
  const result = installWatch();
  if (result.success) {
    console.log(result.message);
  } else {
    console.error(result.message);
    process.exit(1);
  }
}

function unwatch() {
  const result = removeWatch();
  if (result.success) {
    console.log(result.message);
  } else {
    console.error(result.message);
    process.exit(1);
  }
}

function migrate() {
  const dryRun = process.argv.includes('--dry-run');
  const deleteOriginals = process.argv.includes('--delete');

  const cwd = process.cwd();
  let root;
  try {
    root = execFileSync('git', ['rev-parse', '--show-toplevel'], {
      cwd, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch {
    root = cwd;
  }

  // Walk from CWD up to git root, collecting CLAUDE.md variants
  const CLAUDE_NAMES = ['CLAUDE.md', 'CLAUDE.local.md'];
  const CLAUDE_DIR_NAME = '.claude';
  const found = [];

  let dir;
  try { dir = realpathSync(cwd); } catch { dir = cwd; }
  let realRoot;
  try { realRoot = realpathSync(root); } catch { realRoot = root; }

  while (true) {
    for (const name of CLAUDE_NAMES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) {
        found.push(candidate);
      }
    }
    // Check .claude/ subdirectory
    const dotClaudeFile = join(dir, CLAUDE_DIR_NAME, 'CLAUDE.md');
    if (existsSync(dotClaudeFile)) {
      found.push(dotClaudeFile);
    }

    if (dir === realRoot) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }

  if (found.length === 0) {
    if (JSON_FLAG) {
      console.log(JSON.stringify({ migrated: [], skipped: [], deleted: [] }));
    } else {
      console.log('No CLAUDE.md files found on path from CWD to git root.');
    }
    return;
  }

  const migrated = [];
  const skipped = [];
  const deleted = [];

  for (const src of found) {
    const target = src.replace(/CLAUDE\.md$/, 'AGENTS.md').replace(/CLAUDE\.local\.md$/, 'AGENTS.local.md');
    const relSrc = relative(realRoot, src) || src;
    const relTarget = relative(realRoot, target) || target;

    if (existsSync(target)) {
      skipped.push({ source: relSrc, target: relTarget, reason: 'target already exists' });
      if (!JSON_FLAG) {
        console.log(`  skip: ${relSrc} -> ${relTarget} (already exists)`);
      }
      continue;
    }

    // Read content and replace @AGENTS.md import references
    // (these are CLAUDE.md -> AGENTS.md import directives that become self-referential after migration)
    let content = readFileSync(src, 'utf8');
    const agentsRefs = (content.match(/@AGENTS\.md/g) || []).length;
    content = content.replace(/@AGENTS\.md/g, '');

    if (dryRun) {
      migrated.push({ source: relSrc, target: relTarget, refsRemoved: agentsRefs });
      if (!JSON_FLAG) {
        let msg = `  would migrate: ${relSrc} -> ${relTarget}`;
        if (agentsRefs > 0) msg += ` (${agentsRefs} @AGENTS.md ref(s) removed)`;
        console.log(msg);
      }
    } else {
      writeFileSync(target, content, 'utf8');
      migrated.push({ source: relSrc, target: relTarget, refsRemoved: agentsRefs });
      if (!JSON_FLAG) {
        let msg = `  migrated: ${relSrc} -> ${relTarget}`;
        if (agentsRefs > 0) msg += ` (${agentsRefs} @AGENTS.md ref(s) removed)`;
        console.log(msg);
      }

      if (deleteOriginals) {
        unlinkSync(src);
        deleted.push(relSrc);
        if (!JSON_FLAG) {
          console.log(`  deleted: ${relSrc}`);
        }
      }
    }
  }

  if (JSON_FLAG) {
    console.log(JSON.stringify({ migrated, skipped, deleted }, null, 2));
  } else {
    console.log(`\nSummary: ${migrated.length} migrated, ${skipped.length} skipped${deleteOriginals ? `, ${deleted.length} deleted` : ''}.${dryRun ? ' (dry run)' : ''}`);
  }
}

// CLI dispatch
const command = process.argv[2];
const commands = { setup, remove, status, doctor, preview, migrate, patch, unpatch, watch, unwatch, logs, diff };

if (!command || command === '--help' || command === '-h') {
  console.log(`cc-agents-md — Load AGENTS.md into Claude Code sessions

Usage:
  cc-agents-md setup     Install hooks (SessionStart + mid-session reload)
  cc-agents-md remove    Uninstall completely
  cc-agents-md status    Show installation state and detected files
  cc-agents-md doctor    Full health check
  cc-agents-md preview   Show what Claude would see
  cc-agents-md migrate   Convert CLAUDE.md files to AGENTS.md format

Experimental:
  cc-agents-md patch     Patch Claude Code to load AGENTS.md natively
  cc-agents-md unpatch   Restore Claude Code to original state
  cc-agents-md watch     Auto-repatch after upgrades (macOS/Linux)
  cc-agents-md unwatch   Remove the auto-repatch watcher

Diagnostics:
  cc-agents-md logs      Show auto-repatch watcher log
  cc-agents-md diff      Show what the patch changed

Migrate options:
  --dry-run        Preview migration without making changes
  --delete         Delete original CLAUDE.md files after copying

Patch options:
  --dry-run        Show what would be patched without modifying files
  --force          Required for native binary patching (Homebrew)
  --verbose        Show detailed patch info (regex tier, byte offsets)

Output options:
  --json           Machine-readable JSON (status, doctor, preview, logs, diff)
  --lines N        Number of log lines to show (default: 50)

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
