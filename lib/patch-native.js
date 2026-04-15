'use strict';

const { readFileSync, writeFileSync, copyFileSync, existsSync, chmodSync, unlinkSync } = require('fs');
const { execSync } = require('child_process');
const { buildReplacement, isPatched, PATCH_SENTINEL, backupPath } = require('./patcher');

/**
 * Native binary patcher for Claude Code (Homebrew / direct download).
 *
 * Claude Code ships as a Bun-compiled single binary. The JS source is embedded
 * inside the binary. This module finds all async reader functions, patches each
 * one individually with AGENTS.md fallback, and re-codesigns on macOS.
 *
 * EXPERIMENTAL — this modifies a signed binary. Use at your own risk.
 */

/**
 * Regex to match the reader function in a binary chunk.
 * Same structure as ASYNC_READER_RE but anchored to start of chunk, non-global.
 */
const READER_FN_RE = /^async function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+)\)\{try\{let ([$\w]+)=await ([$\w]+)\(\)\.readFile\(\2,\{encoding:"utf-8"\}\);return ([$\w]+)\(\5,\2,\3,\4\)\}catch\(([$\w]+)\)\{return ([$\w]+)\(\8,\2\),\{info:null,includePaths:\[\]\}\}\}/;

/**
 * Find ALL reader function locations in the binary.
 * Returns array of { offset, originalBytes, match } sorted by offset.
 */
function findAllReaderFunctions(binary) {
  const marker = Buffer.from('async function ');
  const results = [];
  let pos = 0;

  while ((pos = binary.indexOf(marker, pos)) !== -1) {
    const end = Math.min(pos + 500, binary.length);
    const chunk = binary.slice(pos, end).toString('utf8');
    const match = chunk.match(READER_FN_RE);

    if (match) {
      results.push({
        offset: pos,
        originalBytes: Buffer.from(match[0], 'utf8'),
        match,
      });
      pos += match[0].length; // skip past this match
    } else {
      pos++;
    }
  }

  return results;
}

/**
 * Patch a native Claude Code binary.
 *
 * Finds all async reader functions in the binary and patches each one
 * individually with AGENTS.md fallback. Works backwards so byte offsets
 * remain valid as patches grow.
 *
 * @param {string} binaryPath - Absolute path to the claude binary
 * @param {object} options - { dryRun: boolean }
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

  const matches = findAllReaderFunctions(binary);

  if (matches.length === 0) {
    return {
      success: false,
      message: 'Could not find the CLAUDE.md reader function in binary. This version may not be compatible.',
    };
  }

  if (options.dryRun) {
    return { success: true, message: `Dry run: would patch ${matches.length} location(s) in native binary.` };
  }

  // Create backup before any modifications
  const backup = backupPath(binaryPath);
  copyFileSync(binaryPath, backup);

  // Work on a copy of the binary buffer
  let newBinary = Buffer.from(binary);

  // Process matches from last to first so earlier offsets stay valid
  const reversed = [...matches].sort((a, b) => b.offset - a.offset);
  let patched = 0;
  let skipped = 0;

  for (const m of reversed) {
    const patchedFn = buildReplacement(
      m.match[0], m.match[1], m.match[2], m.match[3], m.match[4],
      m.match[5], m.match[6], m.match[7], m.match[8], m.match[9]
    );
    const patchedBytes = Buffer.from(patchedFn, 'utf8');
    const originalLen = m.originalBytes.length;
    const patchedLen = patchedBytes.length;

    if (patchedLen <= originalLen) {
      // Fits in place — replace and null-pad remainder
      patchedBytes.copy(newBinary, m.offset);
      if (patchedLen < originalLen) {
        newBinary.fill(0, m.offset + patchedLen, m.offset + originalLen);
      }
      patched++;
    } else {
      // Need extra room — check for null padding after the original
      const growth = patchedLen - originalLen;
      const afterRegion = newBinary.slice(m.offset + originalLen, m.offset + originalLen + growth);
      const hasRoom = afterRegion.length === growth && afterRegion.every(b => b === 0);

      if (hasRoom) {
        patchedBytes.copy(newBinary, m.offset);
        patched++;
      } else {
        // No room — skip this location
        skipped++;
      }
    }
  }

  if (patched === 0) {
    copyFileSync(backup, binaryPath);
    unlinkSync(backup);
    return {
      success: false,
      message: `Found ${matches.length} reader function(s) but none had room for the patch.\n` +
        'Use npm-installed Claude Code instead:\n  npm install -g @anthropic-ai/claude-code',
    };
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

  const skippedNote = skipped > 0 ? `\n${skipped} location(s) skipped (no room in binary).` : '';
  return {
    success: true,
    message: `Patched ${patched}/${matches.length} location(s) in native binary.${skippedNote}\nBackup: ${backup}\nBinary re-signed successfully.`,
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

module.exports = { patchNative, unpatchNative };
