'use strict';

const { existsSync, readFileSync, statSync } = require('fs');
const { join, dirname } = require('path');
const { execSync } = require('child_process');

/**
 * Known installation paths for Claude Code's npm package.
 * The cli.js file inside this package is the patchable target.
 */
const NPM_MODULE = '@anthropic-ai/claude-code';
const CLI_JS = 'cli.js';

/**
 * Detect Claude Code installation type and location.
 *
 * Returns { type, path, version } where:
 *   type = 'npm' | 'native' | null
 *   path = absolute path to patchable file (cli.js for npm, binary for native)
 *   version = Claude Code version string or null
 */
function detectInstallation() {
  // Try npm installation first (most patchable)
  const npmResult = detectNpm();
  if (npmResult) return npmResult;

  // Try native binary
  const nativeResult = detectNative();
  if (nativeResult) return nativeResult;

  return { type: null, path: null, version: null };
}

/**
 * Find npm-installed Claude Code by resolving the package from common paths.
 */
function detectNpm() {
  // Strategy 1: Use npm/node to resolve the module
  const resolveStrategies = [
    // Global npm
    () => {
      const out = execSync('npm root -g', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      return join(out, NPM_MODULE, CLI_JS);
    },
    // Bun global
    () => {
      const out = execSync('bun pm -g bin', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
      const bunRoot = dirname(out);
      return join(bunRoot, 'node_modules', NPM_MODULE, CLI_JS);
    },
  ];

  // Strategy 2: Check well-known paths
  const HOME = process.env.HOME || process.env.USERPROFILE || '';
  const knownPaths = [
    // npm global (macOS/Linux)
    join('/usr/local/lib/node_modules', NPM_MODULE, CLI_JS),
    join('/usr/lib/node_modules', NPM_MODULE, CLI_JS),
    // Homebrew npm
    join('/opt/homebrew/lib/node_modules', NPM_MODULE, CLI_JS),
    // nvm
    ...(process.env.NVM_DIR ? [join(process.env.NVM_DIR, 'versions/node', '**', 'lib/node_modules', NPM_MODULE, CLI_JS)] : []),
    // volta
    join(HOME, '.volta/tools/image/packages', NPM_MODULE, 'lib/node_modules', NPM_MODULE, CLI_JS),
    // fnm
    join(HOME, '.local/share/fnm/node-versions', '**', 'installation/lib/node_modules', NPM_MODULE, CLI_JS),
    // pnpm
    join(HOME, '.local/share/pnpm/global', '**', 'node_modules', NPM_MODULE, CLI_JS),
    // yarn global
    join(HOME, '.config/yarn/global/node_modules', NPM_MODULE, CLI_JS),
    // Bun
    join(HOME, '.bun/install/global/node_modules', NPM_MODULE, CLI_JS),
  ];

  // Try resolve strategies first
  for (const strategy of resolveStrategies) {
    try {
      const candidate = strategy();
      if (existsSync(candidate) && isFile(candidate)) {
        return buildNpmResult(candidate);
      }
    } catch {
      // Strategy failed, try next
    }
  }

  // Try known paths (skip glob patterns for now — just direct paths)
  for (const candidate of knownPaths) {
    if (!candidate.includes('**') && existsSync(candidate) && isFile(candidate)) {
      return buildNpmResult(candidate);
    }
  }

  return null;
}

function buildNpmResult(cliJsPath) {
  let version = null;
  try {
    const pkgPath = join(dirname(cliJsPath), 'package.json');
    if (existsSync(pkgPath)) {
      version = JSON.parse(readFileSync(pkgPath, 'utf8')).version || null;
    }
  } catch {
    // version detection is best-effort
  }
  return { type: 'npm', path: cliJsPath, version };
}

/**
 * Find native binary installation (Homebrew, direct download).
 */
function detectNative() {
  const candidates = [];

  // Try which/type first
  try {
    const out = execSync('which claude', { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
    if (out) candidates.push(out);
  } catch {
    // not in PATH
  }

  const HOME = process.env.HOME || process.env.USERPROFILE || '';

  // Well-known native paths
  candidates.push(
    join(HOME, '.local/bin/claude'),
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  );

  for (const candidate of candidates) {
    try {
      if (!existsSync(candidate)) continue;

      // Resolve symlinks
      const resolved = require('fs').realpathSync(candidate);
      if (!isFile(resolved)) continue;

      // Check if it's a native binary (not a shell script or node wrapper)
      const fd = require('fs').openSync(resolved, 'r');
      const buf = Buffer.alloc(4);
      require('fs').readSync(fd, buf, 0, 4, 0);
      require('fs').closeSync(fd);

      const isMachO = buf[0] === 0xCF && buf[1] === 0xFA && buf[2] === 0xED && buf[3] === 0xFE;
      const isELF = buf[0] === 0x7F && buf[1] === 0x45 && buf[2] === 0x4C && buf[3] === 0x46;

      if (!isMachO && !isELF) continue;

      // Try to extract version from binary strings
      let version = null;
      try {
        const out = execSync(`strings "${resolved}" | grep -oE 'VERSION:"[0-9]+\\.[0-9]+\\.[0-9]+"' | head -1`, {
          encoding: 'utf8',
          stdio: ['pipe', 'pipe', 'pipe'],
          timeout: 5000,
        }).trim();
        const match = out.match(/VERSION:"([^"]+)"/);
        if (match) version = match[1];
      } catch {
        // version detection is best-effort
      }

      return { type: 'native', path: resolved, version };
    } catch {
      continue;
    }
  }

  return null;
}

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

module.exports = { detectInstallation, detectNpm, detectNative };
