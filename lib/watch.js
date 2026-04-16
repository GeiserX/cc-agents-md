'use strict';

const { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync } = require('fs');
const { execSync, execFileSync } = require('child_process');
const { join } = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE;

// --- macOS LaunchAgent ---

const MACOS_LABEL = 'com.cc-agents-md.repatch';
const MACOS_PLIST_DIR = join(HOME, 'Library', 'LaunchAgents');
const MACOS_PLIST_PATH = join(MACOS_PLIST_DIR, `${MACOS_LABEL}.plist`);

// --- Linux systemd ---

const LINUX_UNIT_DIR = join(HOME, '.config', 'systemd', 'user');
const LINUX_PATH_UNIT = join(LINUX_UNIT_DIR, 'cc-agents-md-repatch.path');
const LINUX_SERVICE_UNIT = join(LINUX_UNIT_DIR, 'cc-agents-md-repatch.service');

const LOG_PATH = join(HOME, '.claude', 'cc-agents-md-autopatch.log');

/**
 * Resolve the path to the cc-agents-md CLI binary.
 */
function resolveCli() {
  try {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    const out = execFileSync(cmd, ['cc-agents-md'], { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (out && existsSync(out.split('\n')[0])) return out.split('\n')[0];
  } catch { /* fall through */ }
  return join(__dirname, '..', 'bin', 'cli.js');
}

// ============================================================
// macOS: LaunchAgent with WatchPaths
// ============================================================

function buildPlist(cliPath) {
  const watchPath = '/opt/homebrew/Caskroom/claude-code';
  const isScript = cliPath.endsWith('.js');
  const programArgs = isScript
    ? `    <string>/usr/bin/env</string>
    <string>node</string>
    <string>${cliPath}</string>`
    : `    <string>${cliPath}</string>`;

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${MACOS_LABEL}</string>
  <key>WatchPaths</key>
  <array>
    <string>${watchPath}</string>
  </array>
  <key>ProgramArguments</key>
  <array>
${programArgs}
    <string>patch</string>
    <string>--force</string>
    <string>--auto</string>
  </array>
  <key>StandardOutPath</key>
  <string>${LOG_PATH}</string>
  <key>StandardErrorPath</key>
  <string>${LOG_PATH}</string>
  <key>RunAtLoad</key>
  <false/>
</dict>
</plist>`;
}

function installMacOS() {
  if (!existsSync('/opt/homebrew/Caskroom/claude-code')) {
    return {
      success: false,
      message: 'Homebrew Claude Code not found at /opt/homebrew/Caskroom/claude-code.\n' +
        'Auto-repatch watcher is only needed for Homebrew installations.',
    };
  }

  const cliPath = resolveCli();
  const plist = buildPlist(cliPath);

  mkdirSync(MACOS_PLIST_DIR, { recursive: true });
  writeFileSync(MACOS_PLIST_PATH, plist);

  try {
    execSync(`launchctl bootout gui/${process.getuid()} "${MACOS_PLIST_PATH}" 2>/dev/null`, { stdio: 'pipe' });
  } catch { /* not loaded */ }

  try {
    execSync(`launchctl bootstrap gui/${process.getuid()} "${MACOS_PLIST_PATH}"`, { stdio: 'pipe' });
  } catch (err) {
    return {
      success: false,
      message: `Plist written but launchctl bootstrap failed: ${err.message}\nPlist: ${MACOS_PLIST_PATH}`,
    };
  }

  return {
    success: true,
    message: `Auto-repatch watcher installed (macOS LaunchAgent).\n` +
      `Watches: /opt/homebrew/Caskroom/claude-code\n` +
      `Plist:   ${MACOS_PLIST_PATH}\n` +
      `Log:     ${LOG_PATH}\n\n` +
      `After "brew upgrade claude-code", the patch will be reapplied automatically.`,
  };
}

function removeMacOS() {
  if (!existsSync(MACOS_PLIST_PATH)) {
    return { success: true, message: 'macOS watcher not installed — nothing to do.' };
  }

  try {
    execSync(`launchctl bootout gui/${process.getuid()} "${MACOS_PLIST_PATH}" 2>/dev/null`, { stdio: 'pipe' });
  } catch { /* not loaded */ }

  try { unlinkSync(MACOS_PLIST_PATH); } catch (err) {
    return { success: false, message: `Could not remove plist: ${err.message}` };
  }

  return { success: true, message: 'macOS auto-repatch watcher removed.' };
}

function statusMacOS() {
  const installed = existsSync(MACOS_PLIST_PATH);
  let loaded = false;

  if (installed) {
    try {
      const out = execSync(`launchctl print gui/${process.getuid()}/${MACOS_LABEL} 2>&1`, {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      loaded = !out.includes('Could not find service');
    } catch {
      loaded = false;
    }
  }

  return { installed, loaded, unitPath: MACOS_PLIST_PATH };
}

// ============================================================
// Linux: systemd user path unit + service
// ============================================================

function buildSystemdUnits(cliPath) {
  // Detect common Claude Code install locations on Linux
  const watchPaths = [
    '/usr/lib/node_modules/@anthropic-ai/claude-code',
    '/usr/local/lib/node_modules/@anthropic-ai/claude-code',
    join(HOME, '.npm-global', 'lib', 'node_modules', '@anthropic-ai', 'claude-code'),
  ];
  // Use the first path that exists, or the npm global default
  const watchPath = watchPaths.find(p => existsSync(p)) || watchPaths[0];

  const isScript = cliPath.endsWith('.js');
  const execStart = isScript
    ? `/usr/bin/env node ${cliPath} patch --auto`
    : `${cliPath} patch --auto`;

  const pathUnit = `[Unit]
Description=cc-agents-md auto-repatch watcher

[Path]
PathChanged=${watchPath}

[Install]
WantedBy=default.target
`;

  const serviceUnit = `[Unit]
Description=cc-agents-md auto-repatch

[Service]
Type=oneshot
ExecStart=${execStart}
StandardOutput=append:${LOG_PATH}
StandardError=append:${LOG_PATH}
`;

  return { pathUnit, serviceUnit, watchPath };
}

function installLinux() {
  const cliPath = resolveCli();
  const { pathUnit, serviceUnit, watchPath } = buildSystemdUnits(cliPath);

  mkdirSync(LINUX_UNIT_DIR, { recursive: true });
  mkdirSync(join(HOME, '.claude'), { recursive: true });

  writeFileSync(LINUX_PATH_UNIT, pathUnit);
  writeFileSync(LINUX_SERVICE_UNIT, serviceUnit);

  try {
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
    execSync('systemctl --user enable --now cc-agents-md-repatch.path', { stdio: 'pipe' });
  } catch (err) {
    return {
      success: false,
      message: `Units written but systemctl failed: ${err.message}\n` +
        `Path unit:    ${LINUX_PATH_UNIT}\n` +
        `Service unit: ${LINUX_SERVICE_UNIT}`,
    };
  }

  return {
    success: true,
    message: `Auto-repatch watcher installed (systemd user path unit).\n` +
      `Watches: ${watchPath}\n` +
      `Units:   ${LINUX_PATH_UNIT}\n` +
      `         ${LINUX_SERVICE_UNIT}\n` +
      `Log:     ${LOG_PATH}\n\n` +
      `After Claude Code updates, the patch will be reapplied automatically.`,
  };
}

function removeLinux() {
  const hasPath = existsSync(LINUX_PATH_UNIT);
  const hasService = existsSync(LINUX_SERVICE_UNIT);

  if (!hasPath && !hasService) {
    return { success: true, message: 'Linux watcher not installed — nothing to do.' };
  }

  try {
    execSync('systemctl --user disable --now cc-agents-md-repatch.path 2>/dev/null', { stdio: 'pipe' });
  } catch { /* not enabled */ }

  try { unlinkSync(LINUX_PATH_UNIT); } catch { /* best effort */ }
  try { unlinkSync(LINUX_SERVICE_UNIT); } catch { /* best effort */ }

  try {
    execSync('systemctl --user daemon-reload', { stdio: 'pipe' });
  } catch { /* best effort */ }

  return { success: true, message: 'Linux auto-repatch watcher removed.' };
}

function statusLinux() {
  const installed = existsSync(LINUX_PATH_UNIT);
  let loaded = false;

  if (installed) {
    try {
      const out = execSync('systemctl --user is-active cc-agents-md-repatch.path 2>&1', {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      loaded = out.trim() === 'active' || out.trim() === 'waiting';
    } catch {
      loaded = false;
    }
  }

  return { installed, loaded, unitPath: LINUX_PATH_UNIT };
}

// ============================================================
// Platform dispatcher
// ============================================================

function installWatch() {
  if (process.platform === 'darwin') return installMacOS();
  if (process.platform === 'linux') return installLinux();
  return { success: false, message: `Auto-repatch watcher is not supported on ${process.platform}.\nSupported: macOS (LaunchAgent), Linux (systemd).` };
}

function removeWatch() {
  if (process.platform === 'darwin') return removeMacOS();
  if (process.platform === 'linux') return removeLinux();
  return { success: true, message: 'No watcher to remove on this platform.' };
}

function watchStatus() {
  if (process.platform === 'darwin') return statusMacOS();
  if (process.platform === 'linux') return statusLinux();
  return { installed: false, loaded: false, unitPath: null };
}

module.exports = { installWatch, removeWatch, watchStatus, MACOS_PLIST_PATH, MACOS_LABEL };
