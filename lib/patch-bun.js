'use strict';

const { readFileSync, writeFileSync, copyFileSync, existsSync, chmodSync, unlinkSync } = require('fs');
const { execSync } = require('child_process');
const { backupPath } = require('./patcher');

/**
 * Bun-format-aware patcher for Claude Code native binaries.
 *
 * Claude Code ships as a Bun standalone binary (Mach-O arm64). The __BUN.__bun
 * section embeds JS source, compiled bytecode, and a module trailer. This patcher:
 *
 * 1. Parses the Mach-O to find the __BUN section
 * 2. Finds the reader function in the source text
 * 3. Expands source into bytecode space with the AGENTS.md fallback
 * 4. Disables bytecode (forces source interpretation)
 * 5. Updates source_size fields in the content header
 * 6. Re-codesigns and removes quarantine
 *
 * No file growth. No Mach-O header changes. No trailer updates.
 */

/** Sentinel to detect our patch in the binary */
const BUN_PATCH_MARKER = 'replace("CLAUDE","AGENTS")';

/** Regex to match the reader function in source text */
const READER_FN_RE = /async function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+)\)\{try\{let ([$\w]+)=await ([$\w]+)\(\)\.readFile\(\2,\{encoding:"utf-8"\}\);return ([$\w]+)\(\5,\2,\3,\4\)\}catch\(([$\w]+)\)\{return ([$\w]+)\(\8,\2\),\{info:null,includePaths:\[\]\}\}\}/;

/**
 * Build compact replacement for Bun binary patching.
 *
 * Uses simple string replace ("CLAUDE" → "AGENTS") with natural recursion guard:
 * when called with an AGENTS.md path, replace("CLAUDE","AGENTS") returns the
 * same string, so the if(z!=H) check fails and recursion stops.
 *
 * No sentinel comment (saves 22 bytes). No guard parameter (saves ~10 bytes).
 * Growth: ~88 bytes over original.
 */
function buildBunReplacement(m) {
  const [, fn, p, t, r, v, fs, proc, cv, err] = m;
  return `async function ${fn}(${p},${t},${r}){try{let ${v}=await ${fs}().readFile(${p},{encoding:"utf-8"});return ${proc}(${v},${p},${t},${r})}catch(${cv}){var z=${p}.replace("CLAUDE","AGENTS");if(z!=${p})try{return await ${fn}(z,${t},${r})}catch(__){}return ${err}(${cv},${p}),{info:null,includePaths:[]}}}`;
}

/**
 * Parse Mach-O 64-bit header to find __BUN.__bun section.
 *
 * @param {Buffer} binary - Full binary contents
 * @returns {{ sectionOffset, sectionSize, sectionSizeFieldOffset, segmentFilesize } | null}
 */
function findBunSection(binary) {
  const magic = binary.readUInt32LE(0);
  if (magic !== 0xFEEDFACF) return null;

  const ncmds = binary.readUInt32LE(16);
  let pos = 32; // Past mach_header_64

  for (let i = 0; i < ncmds; i++) {
    const cmd = binary.readUInt32LE(pos);
    const cmdsize = binary.readUInt32LE(pos + 4);

    if (cmd === 0x19) { // LC_SEGMENT_64
      const segname = binary.slice(pos + 8, pos + 24).toString('utf8').replace(/\0/g, '');

      if (segname === '__BUN') {
        const segFilesize = Number(binary.readBigUInt64LE(pos + 48));
        const nsects = binary.readUInt32LE(pos + 64);

        if (nsects >= 1) {
          const sectPos = pos + 72; // First section_64 header
          const sectSize = Number(binary.readBigUInt64LE(sectPos + 40));
          const sectOffset = binary.readUInt32LE(sectPos + 48);

          return {
            sectionOffset: sectOffset,
            sectionSize: sectSize,
            sectionSizeFieldOffset: sectPos + 40,
            segmentFilesize: segFilesize,
          };
        }
      }
    }

    pos += cmdsize;
  }

  return null;
}

/**
 * Find the reader function in the source region of the __BUN section.
 *
 * @param {Buffer} section - The raw __BUN section bytes
 * @param {number} sourceStart - Section offset where source text begins
 * @param {number} sourceSize - Size of the source text in bytes
 * @returns {{ offset: number, match: RegExpMatchArray } | null}
 */
function findReaderInSource(section, sourceStart, sourceSize) {
  // Search through source in 64KB chunks with overlap
  const chunkSize = 65536;
  const overlap = 512;

  for (let pos = sourceStart; pos < sourceStart + sourceSize; pos += chunkSize - overlap) {
    const end = Math.min(pos + chunkSize, sourceStart + sourceSize);
    const chunk = section.slice(pos, end).toString('utf8');
    const m = chunk.match(READER_FN_RE);

    if (m) {
      const byteOffset = pos + Buffer.byteLength(chunk.slice(0, m.index), 'utf8');
      return { offset: byteOffset, match: m };
    }
  }

  return null;
}

/**
 * Patch a Bun standalone binary with AGENTS.md fallback.
 *
 * Strategy: Expand source INTO bytecode space (source-local shift).
 *
 * The __BUN content layout is:
 *   [header 0-423] [source @ 424, size S] [\0] [bytecode ~96MB] [...modules...] [trailer]
 *
 * We ONLY shift bytes within the source region (from reader function to source end)
 * forward by `growth` bytes. The shifted tail overwrites the first `growth` bytes
 * of bytecode — which is fine because we disable bytecode anyway.
 *
 * This avoids shifting bytecode, trailer, or auxiliary modules, preventing the
 * Bus error that occurs when bytecode internal offsets are invalidated.
 *
 * No file growth. No Mach-O changes. No trailer updates.
 *
 * @param {string} binaryPath - Absolute path to the claude binary
 * @param {object} options - { dryRun: boolean }
 * @returns {{ success: boolean, message: string }}
 */
function patchBun(binaryPath, options = {}) {
  if (!existsSync(binaryPath)) {
    return { success: false, message: `Binary not found: ${binaryPath}` };
  }

  const binary = readFileSync(binaryPath);

  // Check if already patched
  if (binary.includes(Buffer.from(BUN_PATCH_MARKER, 'utf8'))) {
    return { success: false, message: 'Already patched by cc-agents-md.' };
  }

  // 1. Find __BUN section in Mach-O
  const bun = findBunSection(binary);
  if (!bun) {
    return { success: false, message: 'Not a Bun standalone binary (no __BUN section found).' };
  }

  // 2. Parse content header
  // Section: [8-byte content_size] [content...]
  // Content: [module header 0-423] [source_size @ 420] [source @ 424...]
  const contentBase = bun.sectionOffset + 8; // Absolute offset of content[0]

  // Source size stored at content offsets 164 and 420
  const sourceSizeOff1 = contentBase + 164;
  const sourceSizeOff2 = contentBase + 420;
  const sourceSize1 = binary.readUInt32LE(sourceSizeOff1);
  const sourceSize2 = binary.readUInt32LE(sourceSizeOff2);

  if (sourceSize1 !== sourceSize2) {
    return { success: false, message: `Source size mismatch: ${sourceSize1} vs ${sourceSize2}` };
  }

  const sourceSize = sourceSize1;
  const sourceAbsStart = contentBase + 424;   // Absolute file offset of source[0]
  const sourceAbsEnd = sourceAbsStart + sourceSize; // First byte AFTER source

  // 3. Find reader function in Region 1 source
  const result = findReaderInSource(binary, sourceAbsStart, sourceSize);
  if (!result) {
    return {
      success: false,
      message: 'Could not find the CLAUDE.md reader function in source region.',
    };
  }

  const { offset: readerAbsOffset, match } = result;
  const originalFn = match[0];
  const patchedFn = buildBunReplacement(match);
  const originalBytes = Buffer.from(originalFn, 'utf8');
  const patchedBytes = Buffer.from(patchedFn, 'utf8');
  const growth = patchedBytes.length - originalBytes.length;

  if (options.dryRun) {
    return {
      success: true,
      message: `Dry run: would patch reader function (${growth} byte growth into bytecode space).`,
    };
  }

  // Create backup
  const backup = backupPath(binaryPath);
  copyFileSync(binaryPath, backup);

  // 4. Shift source bytes AFTER the reader function by `growth` bytes.
  //    This only shifts within the source region — the tail overflows into
  //    the first `growth` bytes of bytecode (which we'll disable).
  //
  //    Source layout: [...before...][reader(152)][...after(~8MB)...][\0][bytecode...]
  //    After shift:   [...before...][reader(233)][...after(shifted)...][\0][bytecode+growth...]
  const afterReaderStart = readerAbsOffset + originalBytes.length; // Original "after" region start
  const shiftSrc = afterReaderStart;
  const shiftDst = afterReaderStart + growth;
  const shiftLen = sourceAbsEnd - afterReaderStart; // Bytes to shift (source tail)

  // Shift source tail forward (copy backwards to handle overlap)
  binary.copy(binary, shiftDst, shiftSrc, shiftSrc + shiftLen);

  // 5. Write patched reader function
  patchedBytes.copy(binary, readerAbsOffset);

  // 6. Write null terminator after new source end
  const newSourceEnd = sourceAbsEnd + growth;
  binary[newSourceEnd] = 0x00;

  // 7. Update source_size fields (+growth)
  binary.writeUInt32LE(sourceSize + growth, sourceSizeOff1);
  binary.writeUInt32LE(sourceSize + growth, sourceSizeOff2);

  // 8. Disable bytecode: zero out 32 bytes at new bytecode start position.
  //    Bytecode now implicitly starts at newSourceEnd + 1.
  //    Its first `growth` bytes were already overwritten by the source shift.
  //    Zero more to ensure any bytecode header/magic is invalidated.
  const newBytecodeStart = newSourceEnd + 1;
  const bytecodeZeroEnd = Math.min(newBytecodeStart + 32, bun.sectionOffset + bun.sectionSize);
  binary.fill(0, newBytecodeStart, bytecodeZeroEnd);

  // 9. Write modified binary (same file size — no Mach-O changes needed)
  writeFileSync(binaryPath, binary);

  // 10. Re-codesign + remove quarantine on macOS
  if (process.platform === 'darwin') {
    try {
      execSync(`codesign -s - -f "${binaryPath}"`, { stdio: 'pipe' });
    } catch (err) {
      copyFileSync(backup, binaryPath);
      return {
        success: false,
        message: `Patch applied but codesign failed: ${err.message}\nBackup restored.`,
      };
    }
    try {
      execSync(`xattr -dr com.apple.quarantine "${binaryPath}"`, { stdio: 'pipe' });
    } catch { /* best effort */ }
  }

  try { chmodSync(binaryPath, 0o755); } catch { /* best effort */ }

  return {
    success: true,
    message: `Patched Bun binary (${growth} byte source expansion into bytecode space).\n` +
      `Bytecode disabled — source interpretation on next launch.\n` +
      `Backup: ${backup}`,
  };
}

/**
 * Unpatch a Bun binary by restoring from backup.
 */
function unpatchBun(binaryPath) {
  const backup = backupPath(binaryPath);

  if (existsSync(backup)) {
    copyFileSync(backup, binaryPath);

    if (process.platform === 'darwin') {
      try {
        execSync(`codesign -s - -f "${binaryPath}"`, { stdio: 'pipe' });
      } catch { /* best effort */ }
      try {
        execSync(`xattr -dr com.apple.quarantine "${binaryPath}"`, { stdio: 'pipe' });
      } catch { /* best effort */ }
    }

    try { chmodSync(binaryPath, 0o755); } catch { /* best effort */ }

    unlinkSync(backup);
    return { success: true, message: 'Restored original binary from backup.' };
  }

  if (existsSync(binaryPath)) {
    const probe = readFileSync(binaryPath, { encoding: null });
    if (!probe.includes(Buffer.from(BUN_PATCH_MARKER, 'utf8'))) {
      return { success: true, message: 'Not patched — nothing to do.' };
    }
    return {
      success: false,
      message: 'Patched but no backup found. Reinstall Claude Code to restore:\n  brew reinstall claude-code',
    };
  }

  return { success: false, message: `Binary not found: ${binaryPath}` };
}

module.exports = { patchBun, unpatchBun, findBunSection, buildBunReplacement, BUN_PATCH_MARKER };
