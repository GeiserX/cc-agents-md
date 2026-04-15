'use strict';

const { readFileSync, writeFileSync, copyFileSync, existsSync, chmodSync, unlinkSync } = require('fs');
const { execFileSync } = require('child_process');
const { backupPath } = require('./patcher');

/**
 * Bun-format-aware patcher for Claude Code native binaries.
 *
 * Claude Code ships as a Bun standalone binary (Mach-O arm64). The __BUN.__bun
 * section embeds JS source, compiled bytecode, and a module trailer. This patcher:
 *
 * 1. Parses the Mach-O to find the __BUN section
 * 2. Navigates the trailer to dynamically locate the source region
 * 3. Finds the reader function via tiered regex fallback
 * 4. Expands source into bytecode space with the AGENTS.md fallback
 * 5. Disables bytecode (forces source interpretation)
 * 6. Updates all source_size fields in the content header
 * 7. Verifies the patched binary runs before finalizing
 * 8. Re-codesigns and removes quarantine
 *
 * No file growth. No Mach-O header changes. No trailer updates.
 */

/** Sentinel to detect our patch in the binary */
const BUN_PATCH_MARKER = 'replace("CLAUDE","AGENTS")';

/** Bun standalone trailer magic (16 bytes) */
const BUN_MAGIC = '\n---- Bun! ----\n';

/**
 * Tiered regex patterns for matching the reader function.
 * Ordered from most specific (current CC shape) to most relaxed.
 * Each tier logs which pattern matched for diagnostics.
 */
const READER_PATTERNS = [
  {
    tier: 1,
    desc: 'exact match (current CC shape)',
    // async function X(A,B,C){try{let D=await E().readFile(A,{encoding:"utf-8"});return F(D,A,B,C)}catch(G){return H(G,A),{info:null,includePaths:[]}}}
    re: /async function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+)\)\{try\{let ([$\w]+)=await ([$\w]+)\(\)\.readFile\(\2,\{encoding:"utf-8"\}\);return ([$\w]+)\(\5,\2,\3,\4\)\}catch\(([$\w]+)\)\{return ([$\w]+)\(\8,\2\),\{info:null,includePaths:\[\]\}\}\}/,
  },
  {
    tier: 2,
    desc: 'relaxed encoding (utf8 or utf-8)',
    re: /async function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+)\)\{try\{let ([$\w]+)=await ([$\w]+)\(\)\.readFile\(\2,\{encoding:"utf-?8"\}\);return ([$\w]+)\(\5,\2,\3,\4\)\}catch\(([$\w]+)\)\{return ([$\w]+)\(\8,\2\),\{info:null,includePaths:\[\]\}\}\}/,
  },
  {
    tier: 3,
    desc: 'extra trailing params allowed',
    re: /async function ([$\w]+)\(([$\w]+),([$\w]+),([$\w]+)(?:,[$\w]+)*\)\{try\{let ([$\w]+)=await ([$\w]+)\(\)\.readFile\(\2,\{encoding:"utf-?8"\}\);return ([$\w]+)\(\5,\2,\3,\4(?:,[$\w]+)*\)\}catch\(([$\w]+)\)\{return ([$\w]+)\(\8,\2\),\{info:null,includePaths:\[\]\}\}\}/,
  },
];

/**
 * Build compact replacement for Bun binary patching.
 *
 * Uses simple string replace ("CLAUDE" → "AGENTS") with natural recursion guard:
 * when called with an AGENTS.md path, replace("CLAUDE","AGENTS") returns the
 * same string, so the if(z!=H) check fails and recursion stops.
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

        for (let s = 0; s < nsects; s++) {
          const sectPos = pos + 72 + (s * 80); // section_64 is 80 bytes
          const sectname = binary.slice(sectPos, sectPos + 16).toString('utf8').replace(/\0/g, '');
          if (sectname !== '__bun') continue;

          return {
            sectionOffset: binary.readUInt32LE(sectPos + 48),
            sectionSize: Number(binary.readBigUInt64LE(sectPos + 40)),
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
 * Dynamically locate the source region by parsing the trailer backwards.
 *
 * Instead of hardcoding offsets (164, 420, 424), we:
 * 1. Verify the Bun magic trailer at content end
 * 2. Read entries_table from the trailer to get source_size
 * 3. Scan the module header for the [0x10, 0x00, 0x01, source_size] pattern
 * 4. Find all source_size occurrences in the header for updating
 *
 * @param {Buffer} binary - Full binary contents
 * @param {{ sectionOffset, sectionSize }} bun - From findBunSection
 * @returns {{ sourceSize, sourceAbsStart, sizeLocations, contentBase } | null}
 */
function findSourceRegion(binary, bun) {
  const contentBase = bun.sectionOffset + 8;
  const contentSize = Number(binary.readBigUInt64LE(bun.sectionOffset));

  // 1. Verify trailer magic at content end
  const magicOffset = contentBase + contentSize - 16;
  const magic = binary.slice(magicOffset, magicOffset + 16).toString('utf8');
  if (magic !== BUN_MAGIC) {
    return { error: 'Bun trailer magic not found — binary format may have changed.' };
  }

  // 2. Read entries_table_offset from the 48-byte trailer
  const trailerBase = contentBase + contentSize - 48;
  const entriesTableOffset = binary.readUInt32LE(trailerBase + 8);
  const entriesTableLength = binary.readUInt32LE(trailerBase + 12);

  if (entriesTableOffset >= contentSize || entriesTableLength === 0) {
    return { error: 'Invalid entries table in trailer.' };
  }

  // 3. Read source_size from entries table header (offset +12 in the table)
  const entriesAbs = contentBase + entriesTableOffset;
  const sourceSize = binary.readUInt32LE(entriesAbs + 12);

  if (sourceSize < 100000 || sourceSize > 100000000) {
    return { error: `Implausible source_size from entries table: ${sourceSize}` };
  }

  // 4. Scan module header (first ~500 bytes) for source header pattern [0x10, 0, 1, sourceSize]
  let sourceHeaderOffset = -1;
  for (let off = 200; off < 600; off += 4) {
    if (binary.readUInt32LE(contentBase + off) === 0x10 &&
        binary.readUInt32LE(contentBase + off + 4) === 0 &&
        binary.readUInt32LE(contentBase + off + 8) === 1 &&
        binary.readUInt32LE(contentBase + off + 12) === sourceSize) {
      sourceHeaderOffset = off;
      break;
    }
  }

  if (sourceHeaderOffset === -1) {
    return { error: 'Could not find source header pattern in module header.' };
  }

  const sourceAbsStart = contentBase + sourceHeaderOffset + 16;

  // 5. Find ALL source_size locations in the header (for updating both copies)
  const sizeLocations = [];
  // The one in the source header pattern
  sizeLocations.push(contentBase + sourceHeaderOffset + 12);
  // Scan earlier metadata for any matching u32
  for (let off = 0; off < sourceHeaderOffset; off += 4) {
    if (binary.readUInt32LE(contentBase + off) === sourceSize) {
      sizeLocations.push(contentBase + off);
    }
  }

  return { sourceSize, sourceAbsStart, sizeLocations, contentBase };
}

/**
 * Find the reader function in the source region using tiered regex fallback.
 *
 * @param {Buffer} binary - The full binary buffer
 * @param {number} sourceStart - Absolute offset where source text begins
 * @param {number} sourceSize - Size of the source text in bytes
 * @returns {{ offset: number, match: RegExpMatchArray, tier: number, tierDesc: string } | null}
 */
function findReaderInSource(binary, sourceStart, sourceSize) {
  const chunkSize = 65536;
  const overlap = 512;

  for (const pattern of READER_PATTERNS) {
    for (let pos = sourceStart; pos < sourceStart + sourceSize; pos += chunkSize - overlap) {
      const end = Math.min(pos + chunkSize, sourceStart + sourceSize);
      const chunk = binary.slice(pos, end).toString('utf8');
      const m = chunk.match(pattern.re);

      if (m) {
        const byteOffset = pos + Buffer.byteLength(chunk.slice(0, m.index), 'utf8');
        return { offset: byteOffset, match: m, tier: pattern.tier, tierDesc: pattern.desc };
      }
    }
  }

  return null;
}

/**
 * Path for patch metadata JSON file.
 */
function metaPath(binaryPath) {
  return binaryPath + '.cc-agents-md.meta.json';
}

/**
 * Write patch metadata alongside the backup for diagnostics.
 */
function writePatchMeta(binaryPath, meta) {
  writeFileSync(metaPath(binaryPath), JSON.stringify(meta, null, 2));
}

/**
 * Read patch metadata, returns null if not found.
 */
function readPatchMeta(binaryPath) {
  const p = metaPath(binaryPath);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; }
}

/**
 * Patch a Bun standalone binary with AGENTS.md fallback.
 *
 * Strategy: Expand source INTO bytecode space (source-local shift).
 * Uses trailer-anchored navigation to find source region dynamically.
 *
 * @param {string} binaryPath - Absolute path to the claude binary
 * @param {object} options - { dryRun: boolean, skipVerify: boolean }
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

  // 2. Dynamically locate source region via trailer navigation
  const region = findSourceRegion(binary, bun);
  if (region.error) {
    return { success: false, message: region.error };
  }

  const { sourceSize, sourceAbsStart, sizeLocations } = region;
  const sourceAbsEnd = sourceAbsStart + sourceSize;

  // 3. Find reader function via tiered regex
  const result = findReaderInSource(binary, sourceAbsStart, sourceSize);
  if (!result) {
    return {
      success: false,
      message: 'Could not find the CLAUDE.md reader function in source region.\n' +
        'This Claude Code version may have changed the function structure.',
    };
  }

  const { offset: readerAbsOffset, match, tier, tierDesc } = result;
  const originalFn = match[0];
  const patchedFn = buildBunReplacement(match);
  const originalBytes = Buffer.from(originalFn, 'utf8');
  const patchedBytes = Buffer.from(patchedFn, 'utf8');
  const growth = patchedBytes.length - originalBytes.length;

  if (options.dryRun) {
    return {
      success: true,
      message: `Dry run: would patch reader function (${growth} byte growth, regex tier ${tier}: ${tierDesc}).`,
    };
  }

  // Create backup
  const backup = backupPath(binaryPath);
  copyFileSync(binaryPath, backup);

  // 4. Shift source bytes AFTER the reader function by `growth` bytes
  const afterReaderStart = readerAbsOffset + originalBytes.length;
  const shiftLen = sourceAbsEnd - afterReaderStart;
  binary.copy(binary, afterReaderStart + growth, afterReaderStart, afterReaderStart + shiftLen);

  // 5. Write patched reader function
  patchedBytes.copy(binary, readerAbsOffset);

  // 6. Write null terminator after new source end
  const newSourceEnd = sourceAbsEnd + growth;
  binary[newSourceEnd] = 0x00;

  // 7. Update ALL source_size fields
  for (const off of sizeLocations) {
    binary.writeUInt32LE(sourceSize + growth, off);
  }

  // 8. Disable bytecode with sanity check
  const newBytecodeStart = newSourceEnd + 1;
  // Verify we're actually at bytecode, not still in source
  const probe = binary.slice(newBytecodeStart, newBytecodeStart + 7).toString('utf8');
  if (probe === '// @bun') {
    copyFileSync(backup, binaryPath);
    unlinkSync(backup);
    return {
      success: false,
      message: 'Bytecode boundary check failed — still in source region. Backup restored.',
    };
  }
  const BYTECODE_ZERO_SIZE = 64;
  const bytecodeZeroEnd = Math.min(newBytecodeStart + BYTECODE_ZERO_SIZE, bun.sectionOffset + bun.sectionSize);
  binary.fill(0, newBytecodeStart, bytecodeZeroEnd);

  // 9. Write modified binary
  writeFileSync(binaryPath, binary);

  // 10. Re-codesign + remove quarantine on macOS
  if (process.platform === 'darwin') {
    try {
      execFileSync('codesign', ['-s', '-', '-f', binaryPath], { stdio: 'pipe' });
    } catch (err) {
      copyFileSync(backup, binaryPath);
      return {
        success: false,
        message: `Patch applied but codesign failed: ${err.message}\nBackup restored.`,
      };
    }
    try {
      execFileSync('xattr', ['-dr', 'com.apple.quarantine', binaryPath], { stdio: 'pipe' });
    } catch { /* best effort */ }
  }

  try { chmodSync(binaryPath, 0o755); } catch { /* best effort */ }

  // 11. Post-patch verification: run --version to confirm binary works
  if (!options.skipVerify) {
    try {
      const out = execFileSync(binaryPath, ['--version'], {
        encoding: 'utf8',
        timeout: 90000, // first launch after bytecode disable is slow
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      if (!out.includes('.')) {
        throw new Error(`Unexpected --version output: ${out.trim()}`);
      }
    } catch (err) {
      copyFileSync(backup, binaryPath);
      try { execFileSync('codesign', ['-s', '-', '-f', binaryPath], { stdio: 'pipe' }); } catch { /* best effort */ }
      try { unlinkSync(metaPath(binaryPath)); } catch { /* best effort */ }
      return {
        success: false,
        message: `Patch applied but binary verification failed: ${err.message}\nBackup restored.`,
      };
    }
  }

  // 12. Write patch metadata for diagnostics and upgrade detection
  let version = null;
  try {
    version = execSync(`"${binaryPath}" --version`, {
      encoding: 'utf8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch { /* already verified above, version is nice-to-have */ }

  writePatchMeta(binaryPath, {
    version,
    patchedAt: new Date().toISOString(),
    sourceSizeOriginal: sourceSize,
    sourceSizePatched: sourceSize + growth,
    growth,
    regexTier: tier,
    regexTierDesc: tierDesc,
    sizeLocations: sizeLocations.length,
  });

  return {
    success: true,
    message: `Patched Bun binary (${growth} byte source expansion, regex tier ${tier}).\n` +
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
        execFileSync('codesign', ['-s', '-', '-f', binaryPath], { stdio: 'pipe' });
      } catch { /* best effort */ }
      try {
        execFileSync('xattr', ['-dr', 'com.apple.quarantine', binaryPath], { stdio: 'pipe' });
      } catch { /* best effort */ }
    }

    try { chmodSync(binaryPath, 0o755); } catch { /* best effort */ }

    unlinkSync(backup);
    try { unlinkSync(metaPath(binaryPath)); } catch { /* best effort */ }
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

module.exports = {
  patchBun, unpatchBun, findBunSection, findSourceRegion,
  buildBunReplacement, readPatchMeta, metaPath,
  BUN_PATCH_MARKER, READER_PATTERNS,
};
