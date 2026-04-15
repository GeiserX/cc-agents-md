'use strict';

const { writeFileSync, unlinkSync, existsSync, readFileSync, mkdirSync } = require('fs');
const { execSync } = require('child_process');
const { join } = require('path');

const HOME = process.env.HOME || process.env.USERPROFILE;
const LABEL = 'com.cc-agents-md.repatch';
const PLIST_DIR = join(HOME, 'Library', 'LaunchAgents');
const PLIST_PATH = join(PLIST_DIR, `${LABEL}.plist`);
const LOG_PATH = join(HOME, '.claude', 'cc-agents-md-autopatch.log');

/**
 * Resolve the path to the cc-agents-md CLI binary.
 * Prefers the npm global bin, falls back to the script that invoked us.
 */
function resolveCli() {
  // Try to find our own bin from npm
  try {
    const out = execSync('which cc-agents-md', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (out && existsSync(out)) return out;
  } catch { /* fall through */ }

  // Fallback: use the main script path
  return join(__dirname, '..', 'bin', 'cli.js');
}

/**
 * Build the LaunchAgent plist XML for watching Homebrew Caskroom.
 */
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
  <string>${LABEL}</string>
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

/**
 * Install the LaunchAgent for auto-repatching after brew upgrades.
 *
 * @returns {{ success: boolean, message: string }}
 */
function installWatch() {
  if (process.platform !== 'darwin') {
    return { success: false, message: 'Auto-repatch watcher is only supported on macOS.' };
  }

  if (!existsSync('/opt/homebrew/Caskroom/claude-code')) {
    return {
      success: false,
      message: 'Homebrew Claude Code not found at /opt/homebrew/Caskroom/claude-code.\n' +
        'Auto-repatch watcher is only needed for Homebrew installations.',
    };
  }

  const cliPath = resolveCli();
  const plist = buildPlist(cliPath);

  mkdirSync(PLIST_DIR, { recursive: true });
  writeFileSync(PLIST_PATH, plist);

  // Unload first if already loaded (idempotent)
  try {
    execSync(`launchctl bootout gui/${process.getuid()} "${PLIST_PATH}" 2>/dev/null`, { stdio: 'pipe' });
  } catch { /* not loaded, fine */ }

  try {
    execSync(`launchctl bootstrap gui/${process.getuid()} "${PLIST_PATH}"`, { stdio: 'pipe' });
  } catch (err) {
    return {
      success: false,
      message: `Plist written but launchctl bootstrap failed: ${err.message}\nPlist: ${PLIST_PATH}`,
    };
  }

  return {
    success: true,
    message: `Auto-repatch watcher installed.\n` +
      `Watches: /opt/homebrew/Caskroom/claude-code\n` +
      `Plist:   ${PLIST_PATH}\n` +
      `Log:     ${LOG_PATH}\n\n` +
      `After "brew upgrade claude-code", the patch will be reapplied automatically.`,
  };
}

/**
 * Remove the LaunchAgent.
 *
 * @returns {{ success: boolean, message: string }}
 */
function removeWatch() {
  if (!existsSync(PLIST_PATH)) {
    return { success: true, message: 'Watcher not installed — nothing to do.' };
  }

  try {
    execSync(`launchctl bootout gui/${process.getuid()} "${PLIST_PATH}" 2>/dev/null`, { stdio: 'pipe' });
  } catch { /* not loaded, fine */ }

  try {
    unlinkSync(PLIST_PATH);
  } catch (err) {
    return { success: false, message: `Could not remove plist: ${err.message}` };
  }

  return { success: true, message: 'Auto-repatch watcher removed.' };
}

/**
 * Check watcher status.
 *
 * @returns {{ installed: boolean, plistPath: string, loaded: boolean }}
 */
function watchStatus() {
  const installed = existsSync(PLIST_PATH);
  let loaded = false;

  if (installed) {
    try {
      const out = execSync(`launchctl print gui/${process.getuid()}/${LABEL} 2>&1`, {
        encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'],
      });
      loaded = !out.includes('Could not find service');
    } catch {
      loaded = false;
    }
  }

  return { installed, plistPath: PLIST_PATH, loaded };
}

module.exports = { installWatch, removeWatch, watchStatus, PLIST_PATH, LABEL };
