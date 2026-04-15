'use strict';

const { readFileSync, writeFileSync, copyFileSync, existsSync, chmodSync, statSync } = require('fs');
const { execSync } = require('child_process');
const { patchSource, isPatched, PATCH_SENTINEL, backupPath } = require('./patcher');

/**
 * Native binary patcher for Claude Code (Homebrew / direct download).
 *
 * Claude Code ships as a Bun-compiled single binary. The JS source is embedded
 * inside the binary in a platform-specific section:
 *   - macOS: __BUN/__bun Mach-O section
 *   - Linux: .bun ELF section
 *
 * This module extracts the JS, patches it, and repacks the binary.
 * Requires `node-lief` as an optional dependency for full support.
 *
 * EXPERIMENTAL — this modifies a signed binary. Use at your own risk.
 */

/**
 * Check if node-lief is available.
 */
function hasLief() {
  try {
    require('lief-node');
    return true;
  } catch {
    return false;
  }
}

/**
 * Patch a native Claude Code binary.
 *
 * Strategy: Read the binary, find the embedded JS by searching for the
 * async reader function pattern, patch in-place if possible, otherwise
 * use LIEF for proper section manipulation.
 *
 * For now, we use a simpler approach: find the JS source region in the
 * binary buffer and do a direct byte-level replacement.
 *
 * @param {string} binaryPath - Absolute path to the claude binary
 * @param {object} options - { dryRun: boolean, force: boolean }
 * @returns {{ success: boolean, message: string }}
 */
function patchNative(binaryPath, options = {}) {
  if (!existsSync(binaryPath)) {
    return { success: false, message: `Binary not found: ${binaryPath}` };
  }

  const binary = readFileSync(binaryPath);
  const source = binary.toString('utf8');

  if (isPatched(source)) {
    return { success: false, message: 'Already patched by cc-agents-md.' };
  }

  // Find the async reader function in the binary
  const { patched, matchCount } = patchSource(source);

  if (matchCount === 0) {
    return {
      success: false,
      message: 'Could not find the CLAUDE.md reader function in binary. This version may not be compatible.',
    };
  }

  if (options.dryRun) {
    return { success: true, message: `Dry run: would patch ${matchCount} location(s) in native binary.` };
  }

  // The patched source is LONGER than the original (we add fallback code).
  // Direct byte replacement only works for same-length strings.
  // We need to find the exact byte region and handle the size difference.
  //
  // Approach: Find the original function bytes, replace with padded version.
  // Bun's bytecode section has alignment padding we can use.
  // If the replacement is too large, we need LIEF.

  const originalBytes = findReaderFunctionBytes(binary);
  if (!originalBytes) {
    return {
      success: false,
      message: 'Could not locate reader function bytes in binary. Try npm installation instead.',
    };
  }

  const patchedFn = getPatchedFunctionString(source);
  if (!patchedFn) {
    return { success: false, message: 'Internal error: failed to generate patched function.' };
  }

  const originalLen = originalBytes.length;
  const patchedBytes = Buffer.from(patchedFn, 'utf8');
  const patchedLen = patchedBytes.length;

  if (patchedLen > originalLen) {
    // Need to pad or use LIEF
    // Check if there's enough null bytes after the original to absorb the growth
    const offset = binary.indexOf(originalBytes);
    const growth = patchedLen - originalLen;
    const afterRegion = binary.slice(offset + originalLen, offset + originalLen + growth);
    const hasRoom = afterRegion.every(b => b === 0);

    if (!hasRoom && !hasLief()) {
      return {
        success: false,
        message: `Patch requires ${growth} extra bytes but no room found in binary.\n` +
          'Install node-lief for proper binary section manipulation:\n' +
          '  npm install -g lief-node\n' +
          'Or use npm-installed Claude Code instead:\n' +
          '  npm install -g @anthropic-ai/claude-code',
      };
    }

    if (!hasRoom) {
      // TODO: LIEF-based section manipulation
      return {
        success: false,
        message: 'LIEF-based section manipulation not yet implemented. Use npm installation instead.',
      };
    }
  }

  // Create backup
  const backup = backupPath(binaryPath);
  copyFileSync(binaryPath, backup);

  // Apply patch
  const offset = binary.indexOf(originalBytes);
  const newBinary = Buffer.alloc(binary.length);
  binary.copy(newBinary);
  patchedBytes.copy(newBinary, offset);

  // If patched is shorter, null-pad the remainder
  if (patchedLen < originalLen) {
    newBinary.fill(0, offset + patchedLen, offset + originalLen);
  }

  writeFileSync(binaryPath, newBinary);

  // Re-codesign on macOS (required after modifying a signed binary)
  if (process.platform === 'darwin') {
    try {
      execSync(`codesign -s - -f "${binaryPath}"`, { stdio: 'pipe' });
    } catch (err) {
      // Restore backup if codesign fails
      copyFileSync(backup, binaryPath);
      return {
        success: false,
        message: `Patch applied but codesign failed: ${err.message}\nBackup restored.`,
      };
    }
  }

  // Preserve execute permission
  try {
    chmodSync(binaryPath, 0o755);
  } catch {
    // best effort
  }

  return {
    success: true,
    message: `Patched ${matchCount} location(s) in native binary.\nBackup: ${backup}\nBinary re-signed successfully.`,
  };
}

/**
 * Unpatch a native binary by restoring from backup.
 */
function unpatchNative(binaryPath) {
  const backup = backupPath(binaryPath);

  if (existsSync(backup)) {
    copyFileSync(backup, binaryPath);

    // Re-codesign the restored binary
    if (process.platform === 'darwin') {
      try {
        execSync(`codesign -s - -f "${binaryPath}"`, { stdio: 'pipe' });
      } catch {
        // Original was likely properly signed, ad-hoc resign is best-effort
      }
    }

    try { chmodSync(binaryPath, 0o755); } catch { /* best effort */ }

    const { unlinkSync } = require('fs');
    unlinkSync(backup);
    return { success: true, message: 'Restored original binary from backup.' };
  }

  if (existsSync(binaryPath)) {
    const source = readFileSync(binaryPath, 'utf8');
    if (!source.includes(PATCH_SENTINEL)) {
      return { success: true, message: 'Not patched — nothing to do.' };
    }
    return {
      success: false,
      message: 'Patched but no backup found. Reinstall Claude Code to restore:\n  brew reinstall claude-code',
    };
  }

  return { success: false, message: `Binary not found: ${binaryPath}` };
}

/**
 * Find the raw bytes of the async reader function in the binary.
 */
function findReaderFunctionBytes(binary) {
  const pattern = Buffer.from('async function ');
  let pos = 0;

  while ((pos = binary.indexOf(pattern, pos)) !== -1) {
    // Extract a chunk around this position
    const end = Math.min(pos + 500, binary.length);
    const chunk = binary.slice(pos, end).toString('utf8');

    // Check if this matches the reader function pattern
    const match = chunk.match(
      /^async function [$\w]+\([$\w]+,[$\w]+,[$\w]+\)\{try\{let [$\w]+=await [$\w]+\(\)\.readFile\([$\w]+,\{encoding:"utf-8"\}\);return [$\w]+\([$\w]+,[$\w]+,[$\w]+,[$\w]+\)\}catch\([$\w]+\)\{return [$\w]+\([$\w]+,[$\w]+\),\{info:null,includePaths:\[\]\}\}\}/
    );

    if (match) {
      return Buffer.from(match[0], 'utf8');
    }

    pos++;
  }

  return null;
}

/**
 * Get the patched function string from a source that has been patched.
 */
function getPatchedFunctionString(source) {
  const { patched, matchCount } = patchSource(source);
  if (matchCount === 0) return null;

  const start = patched.indexOf(PATCH_SENTINEL);
  if (start === -1) return null;

  // Find the end of the patched function (matching braces)
  let depth = 0;
  let inFunction = false;
  let end = start;

  for (let i = start; i < patched.length; i++) {
    if (patched[i] === '{') {
      depth++;
      inFunction = true;
    } else if (patched[i] === '}') {
      depth--;
      if (inFunction && depth === 0) {
        end = i + 1;
        break;
      }
    }
  }

  return patched.slice(start, end);
}

module.exports = { patchNative, unpatchNative, hasLief };
