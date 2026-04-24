'use strict';

const { describe, it, afterEach } = require('node:test');
const assert = require('node:assert');
const { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } = require('fs');
const { join } = require('path');
const { tmpdir } = require('os');
const {
  findBunSection,
  findSourceRegion,
  buildBunReplacement,
  readPatchMeta,
  metaPath,
  BUN_PATCH_MARKER,
  READER_PATTERNS,
  patchBun,
  unpatchBun,
} = require('../lib/patch-bun');

// Realistic reader function matching CC shape
const READER_MATCH = [
  'async function l59(H,_,q){try{let O=await Y_().readFile(H,{encoding:"utf-8"});return un4(O,H,_,q)}catch(K){return mn4(K,H),{info:null,includePaths:[]}}}',
  'l59', 'H', '_', 'q', 'O', 'Y_', 'un4', 'K', 'mn4',
];

describe('patch-bun.js', () => {
  const dirs = [];

  function makeTempDir() {
    const d = mkdtempSync(join(tmpdir(), 'patch-bun-test-'));
    dirs.push(d);
    return d;
  }

  afterEach(() => {
    for (const d of dirs) {
      rmSync(d, { recursive: true, force: true });
    }
    dirs.length = 0;
  });

  // --- BUN_PATCH_MARKER ---

  it('exports a recognizable patch marker', () => {
    assert.ok(BUN_PATCH_MARKER.includes('CLAUDE'));
    assert.ok(BUN_PATCH_MARKER.includes('AGENTS'));
  });

  // --- READER_PATTERNS ---

  it('exports multiple tiered regex patterns', () => {
    assert.ok(Array.isArray(READER_PATTERNS));
    assert.ok(READER_PATTERNS.length >= 3);
    for (const p of READER_PATTERNS) {
      assert.ok(p.tier > 0);
      assert.ok(typeof p.desc === 'string');
      assert.ok(p.re instanceof RegExp);
    }
  });

  it('tier 1 pattern matches exact CC shape', () => {
    const fn = 'async function l59(H,_,q){try{let O=await Y_().readFile(H,{encoding:"utf-8"});return un4(O,H,_,q)}catch(K){return mn4(K,H),{info:null,includePaths:[]}}}';
    const m = fn.match(READER_PATTERNS[0].re);
    assert.ok(m, 'tier 1 should match');
    assert.strictEqual(m[1], 'l59');
  });

  it('tier 2 pattern matches utf8 without hyphen', () => {
    const fn = 'async function l59(H,_,q){try{let O=await Y_().readFile(H,{encoding:"utf8"});return un4(O,H,_,q)}catch(K){return mn4(K,H),{info:null,includePaths:[]}}}';
    assert.strictEqual(fn.match(READER_PATTERNS[0].re), null, 'tier 1 should not match utf8');
    const m = fn.match(READER_PATTERNS[1].re);
    assert.ok(m, 'tier 2 should match utf8');
  });

  // --- buildBunReplacement ---

  it('builds a valid replacement with CLAUDE/AGENTS string replace', () => {
    const result = buildBunReplacement(READER_MATCH);
    assert.ok(result.includes('replace("CLAUDE","AGENTS")'), 'should contain the string replace');
    assert.ok(result.includes('async function l59'), 'should preserve function name');
    assert.ok(result.includes('Y_().readFile'), 'should preserve fs accessor');
    assert.ok(result.includes('un4('), 'should preserve processor');
    assert.ok(result.includes('mn4('), 'should preserve error handler');
  });

  it('replacement includes recursion guard via string inequality check', () => {
    const result = buildBunReplacement(READER_MATCH);
    assert.ok(result.includes('if(z!=H)'), 'should check string inequality to prevent infinite recursion');
  });

  it('replacement is longer than original function', () => {
    const result = buildBunReplacement(READER_MATCH);
    assert.ok(result.length > READER_MATCH[0].length, 'patched function should be longer');
  });

  // --- findBunSection ---

  it('returns null for non-Mach-O buffer', () => {
    const buf = Buffer.alloc(1024);
    buf.write('not a macho binary');
    assert.strictEqual(findBunSection(buf), null);
  });

  it('returns null for Mach-O without __BUN segment', () => {
    // Minimal Mach-O 64 header: magic + fields + 0 load commands
    const buf = Buffer.alloc(256);
    buf.writeUInt32LE(0xFEEDFACF, 0); // MH_MAGIC_64
    buf.writeUInt32LE(0, 16);          // ncmds = 0
    assert.strictEqual(findBunSection(buf), null);
  });

  it('parses a synthetic Mach-O with __BUN.__bun section', () => {
    // Build a minimal Mach-O 64 with one LC_SEGMENT_64 containing __BUN.__bun
    const headerSize = 32;
    const segCmdSize = 72 + 80; // segment_command_64 (72) + one section_64 (80)
    const totalSize = headerSize + segCmdSize + 4096; // extra space for section data
    const buf = Buffer.alloc(totalSize);

    // Mach-O header
    buf.writeUInt32LE(0xFEEDFACF, 0);  // magic
    buf.writeUInt32LE(1, 16);           // ncmds = 1
    buf.writeUInt32LE(segCmdSize, 20);  // sizeofcmds

    // LC_SEGMENT_64 at offset 32
    const segOff = headerSize;
    buf.writeUInt32LE(0x19, segOff);           // cmd = LC_SEGMENT_64
    buf.writeUInt32LE(segCmdSize, segOff + 4); // cmdsize
    buf.write('__BUN\0', segOff + 8);          // segname
    buf.writeBigUInt64LE(BigInt(4096), segOff + 48); // filesize
    buf.writeUInt32LE(1, segOff + 64);         // nsects = 1

    // section_64 at segOff + 72
    const sectOff = segOff + 72;
    buf.write('__bun\0', sectOff);                     // sectname
    buf.writeBigUInt64LE(BigInt(2048), sectOff + 40);  // size
    buf.writeUInt32LE(512, sectOff + 48);              // offset

    const result = findBunSection(buf);
    assert.ok(result, 'should find __BUN.__bun section');
    assert.strictEqual(result.sectionOffset, 512);
    assert.strictEqual(result.sectionSize, 2048);
    assert.strictEqual(result.segmentFilesize, 4096);
  });

  it('skips non-BUN segments and finds __BUN in a later command', () => {
    // Build a Mach-O with TWO load commands: a non-BUN LC_SEGMENT_64 followed by __BUN
    const headerSize = 32;
    const segCmdSize = 72 + 80; // segment_command_64 + one section
    const totalCmdSize = segCmdSize * 2;
    const totalSize = headerSize + totalCmdSize + 4096;
    const buf = Buffer.alloc(totalSize);

    // Mach-O header
    buf.writeUInt32LE(0xFEEDFACF, 0);
    buf.writeUInt32LE(2, 16);            // ncmds = 2
    buf.writeUInt32LE(totalCmdSize, 20); // sizeofcmds

    // First segment: __TEXT (not __BUN)
    const seg1Off = headerSize;
    buf.writeUInt32LE(0x19, seg1Off);           // cmd = LC_SEGMENT_64
    buf.writeUInt32LE(segCmdSize, seg1Off + 4); // cmdsize
    buf.write('__TEXT\0', seg1Off + 8);         // segname
    buf.writeBigUInt64LE(BigInt(1024), seg1Off + 48); // filesize
    buf.writeUInt32LE(1, seg1Off + 64);         // nsects = 1
    // section: __text (irrelevant)
    buf.write('__text\0', seg1Off + 72);

    // Second segment: __BUN
    const seg2Off = seg1Off + segCmdSize;
    buf.writeUInt32LE(0x19, seg2Off);
    buf.writeUInt32LE(segCmdSize, seg2Off + 4);
    buf.write('__BUN\0', seg2Off + 8);
    buf.writeBigUInt64LE(BigInt(4096), seg2Off + 48);
    buf.writeUInt32LE(1, seg2Off + 64);

    const sectOff = seg2Off + 72;
    buf.write('__bun\0', sectOff);
    buf.writeBigUInt64LE(BigInt(2048), sectOff + 40);
    buf.writeUInt32LE(1024, sectOff + 48);

    const result = findBunSection(buf);
    assert.ok(result, 'should find __BUN after skipping __TEXT');
    assert.strictEqual(result.sectionOffset, 1024);
    assert.strictEqual(result.sectionSize, 2048);
  });

  it('skips non-LC_SEGMENT_64 commands before finding __BUN', () => {
    const headerSize = 32;
    const segCmdSize = 72 + 80;
    const nonSegCmdSize = 16; // a minimal non-segment load command
    const totalCmdSize = nonSegCmdSize + segCmdSize;
    const totalSize = headerSize + totalCmdSize + 4096;
    const buf = Buffer.alloc(totalSize);

    buf.writeUInt32LE(0xFEEDFACF, 0);
    buf.writeUInt32LE(2, 16);            // ncmds = 2
    buf.writeUInt32LE(totalCmdSize, 20);

    // First command: LC_UUID (0x1B) -- not LC_SEGMENT_64
    const cmd1Off = headerSize;
    buf.writeUInt32LE(0x1B, cmd1Off);          // cmd = LC_UUID
    buf.writeUInt32LE(nonSegCmdSize, cmd1Off + 4); // cmdsize

    // Second command: LC_SEGMENT_64 __BUN
    const seg2Off = cmd1Off + nonSegCmdSize;
    buf.writeUInt32LE(0x19, seg2Off);
    buf.writeUInt32LE(segCmdSize, seg2Off + 4);
    buf.write('__BUN\0', seg2Off + 8);
    buf.writeBigUInt64LE(BigInt(4096), seg2Off + 48);
    buf.writeUInt32LE(1, seg2Off + 64);

    const sectOff = seg2Off + 72;
    buf.write('__bun\0', sectOff);
    buf.writeBigUInt64LE(BigInt(2048), sectOff + 40);
    buf.writeUInt32LE(512, sectOff + 48);

    const result = findBunSection(buf);
    assert.ok(result, 'should skip non-segment command and find __BUN');
    assert.strictEqual(result.sectionOffset, 512);
  });

  it('returns null for __BUN segment with non-__bun section name', () => {
    const headerSize = 32;
    const segCmdSize = 72 + 80;
    const totalSize = headerSize + segCmdSize + 1024;
    const buf = Buffer.alloc(totalSize);

    buf.writeUInt32LE(0xFEEDFACF, 0);
    buf.writeUInt32LE(1, 16);
    buf.writeUInt32LE(segCmdSize, 20);

    const segOff = headerSize;
    buf.writeUInt32LE(0x19, segOff);
    buf.writeUInt32LE(segCmdSize, segOff + 4);
    buf.write('__BUN\0', segOff + 8);
    buf.writeBigUInt64LE(BigInt(4096), segOff + 48);
    buf.writeUInt32LE(1, segOff + 64);

    // Section name is NOT __bun
    const sectOff = segOff + 72;
    buf.write('__data\0', sectOff);
    buf.writeBigUInt64LE(BigInt(2048), sectOff + 40);
    buf.writeUInt32LE(512, sectOff + 48);

    const result = findBunSection(buf);
    assert.strictEqual(result, null, 'should return null when __BUN has no __bun section');
  });

  // --- findSourceRegion ---

  it('returns error when Bun magic trailer is not found', () => {
    const buf = Buffer.alloc(4096);
    const bun = { sectionOffset: 0, sectionSize: 4096 };
    // Write a content_size at offset 0
    buf.writeBigUInt64LE(BigInt(2048), 0);

    const result = findSourceRegion(buf, bun);
    assert.ok(result.error, 'should return error');
    assert.ok(result.error.includes('trailer magic not found'));
  });

  // --- findSourceRegion: invalid entries table ---

  it('returns error when entries table offset is out of bounds', () => {
    // Build a buffer with valid Bun magic trailer but invalid entries table
    const contentSize = 1024;
    const buf = Buffer.alloc(contentSize + 8 + 16); // 8 for content_size prefix

    // Write content_size at offset 0 (the section starts here)
    buf.writeBigUInt64LE(BigInt(contentSize), 0);

    const contentBase = 8;
    const magicOffset = contentBase + contentSize - 16;

    // Write Bun magic at the end of content
    buf.write('\n---- Bun! ----\n', magicOffset, 'utf8');

    // Write the 48-byte trailer
    const trailerBase = contentBase + contentSize - 48;
    // entries_table_offset = contentSize (out of bounds)
    buf.writeUInt32LE(contentSize + 100, trailerBase + 8);
    // entries_table_length = 0
    buf.writeUInt32LE(0, trailerBase + 12);

    const bun = { sectionOffset: 0, sectionSize: contentSize + 8 };
    const result = findSourceRegion(buf, bun);
    assert.ok(result.error, 'should return error');
    assert.ok(result.error.includes('Invalid entries table') || result.error.includes('Implausible'));
  });

  // --- findSourceRegion: implausible source_size ---

  it('returns error when source_size is implausibly small', () => {
    const contentSize = 1024;
    const buf = Buffer.alloc(contentSize + 8 + 16);
    buf.writeBigUInt64LE(BigInt(contentSize), 0);

    const contentBase = 8;
    const magicOffset = contentBase + contentSize - 16;
    buf.write('\n---- Bun! ----\n', magicOffset, 'utf8');

    const trailerBase = contentBase + contentSize - 48;
    // entries_table_offset = 100 (within bounds)
    buf.writeUInt32LE(100, trailerBase + 8);
    buf.writeUInt32LE(32, trailerBase + 12);

    // At entries table abs offset (contentBase + 100), write source_size = 50 (too small, <100000)
    buf.writeUInt32LE(50, contentBase + 100 + 12);

    const bun = { sectionOffset: 0, sectionSize: contentSize + 8 };
    const result = findSourceRegion(buf, bun);
    assert.ok(result.error, 'should return error');
    assert.ok(result.error.includes('Implausible source_size'));
  });

  // --- findSourceRegion: valid source but no header pattern ---

  it('returns error when source header pattern not found', () => {
    // Build a buffer with valid Bun trailer, valid entries table, plausible source_size,
    // but no [0x10, 0, 1, sourceSize] pattern in the header region
    const sourceSize = 200000;
    const contentSize = 4096;
    const totalBufSize = contentSize + 8 + 256;
    const buf = Buffer.alloc(totalBufSize);

    // content_size at offset 0
    buf.writeBigUInt64LE(BigInt(contentSize), 0);
    const contentBase = 8;

    // Write Bun magic at end of content
    const magicOffset = contentBase + contentSize - 16;
    buf.write('\n---- Bun! ----\n', magicOffset, 'utf8');

    // Write trailer at contentBase + contentSize - 48
    const trailerBase = contentBase + contentSize - 48;
    // entries_table_offset = 64 (within bounds, < contentSize)
    buf.writeUInt32LE(64, trailerBase + 8);
    // entries_table_length = 32
    buf.writeUInt32LE(32, trailerBase + 12);

    // Write source_size at entries table + 12
    buf.writeUInt32LE(sourceSize, contentBase + 64 + 12);

    // Do NOT write the [0x10, 0, 1, sourceSize] pattern -- leave header blank

    const bun = { sectionOffset: 0, sectionSize: totalBufSize };
    const result = findSourceRegion(buf, bun);
    assert.ok(result.error, 'should return error');
    assert.ok(result.error.includes('Could not find source header pattern'));
  });

  // --- findSourceRegion: fully valid returns source region ---

  it('returns valid source region when all checks pass', () => {
    const sourceSize = 200000;
    const contentSize = 8192;
    const totalBufSize = contentSize + 8 + 256;
    const buf = Buffer.alloc(totalBufSize);

    buf.writeBigUInt64LE(BigInt(contentSize), 0);
    const contentBase = 8;

    // Write Bun magic at end
    const magicOffset = contentBase + contentSize - 16;
    buf.write('\n---- Bun! ----\n', magicOffset, 'utf8');

    // Trailer
    const trailerBase = contentBase + contentSize - 48;
    buf.writeUInt32LE(64, trailerBase + 8);  // entries_table_offset
    buf.writeUInt32LE(32, trailerBase + 12); // entries_table_length

    // Entries table: source_size at offset +12
    buf.writeUInt32LE(sourceSize, contentBase + 64 + 12);

    // Write source header pattern [0x10, 0, 1, sourceSize] at offset 200 from contentBase
    buf.writeUInt32LE(0x10, contentBase + 200);
    buf.writeUInt32LE(0, contentBase + 204);
    buf.writeUInt32LE(1, contentBase + 208);
    buf.writeUInt32LE(sourceSize, contentBase + 212);

    const bun = { sectionOffset: 0, sectionSize: totalBufSize };
    const result = findSourceRegion(buf, bun);
    assert.ok(!result.error, 'should not have error');
    assert.strictEqual(result.sourceSize, sourceSize);
    assert.strictEqual(result.sourceAbsStart, contentBase + 200 + 16);
    assert.ok(result.sizeLocations.length >= 1);
    assert.strictEqual(result.contentBase, contentBase);
  });

  // --- patchBun: dry run with synthetic valid binary ---

  it('patchBun dry-run succeeds on a correctly synthesized binary', () => {
    const dir = makeTempDir();
    const binaryPath = join(dir, 'claude-synth');

    // The reader function to embed
    const readerFn = 'async function l59(H,_,q){try{let O=await Y_().readFile(H,{encoding:"utf-8"});return un4(O,H,_,q)}catch(K){return mn4(K,H),{info:null,includePaths:[]}}}';
    const readerBytes = Buffer.from(readerFn, 'utf8');
    // sourceSize must be >= 100000 to pass plausibility check
    const sourceSize = 110000;

    const sectionOffset = 192;
    const headerPadding = 1024;
    const bytecodeSize = 256;
    const contentSize = headerPadding + sourceSize + bytecodeSize + 48 + 16;
    const sectionSize = 8 + contentSize + 256;
    const totalSize = sectionOffset + sectionSize;
    const buf = Buffer.alloc(totalSize);

    // Mach-O header
    buf.writeUInt32LE(0xFEEDFACF, 0);
    buf.writeUInt32LE(1, 16);
    buf.writeUInt32LE(152, 20);

    // LC_SEGMENT_64 __BUN
    const segOff = 32;
    buf.writeUInt32LE(0x19, segOff);
    buf.writeUInt32LE(152, segOff + 4);
    buf.write('__BUN\0', segOff + 8);
    buf.writeBigUInt64LE(BigInt(sectionSize), segOff + 48);
    buf.writeUInt32LE(1, segOff + 64);

    // section_64 __bun
    const sectOff = segOff + 72;
    buf.write('__bun\0', sectOff);
    buf.writeBigUInt64LE(BigInt(sectionSize), sectOff + 40);
    buf.writeUInt32LE(sectionOffset, sectOff + 48);

    // __BUN section content
    buf.writeBigUInt64LE(BigInt(contentSize), sectionOffset);
    const contentBase = sectionOffset + 8;

    // Bun trailer magic at end of content
    buf.write('\n---- Bun! ----\n', contentBase + contentSize - 16, 'utf8');

    // 48-byte trailer
    const trailerBase = contentBase + contentSize - 48;
    buf.writeUInt32LE(64, trailerBase + 8);
    buf.writeUInt32LE(32, trailerBase + 12);

    // Entries table: source_size at +12
    buf.writeUInt32LE(sourceSize, contentBase + 64 + 12);

    // Source header pattern [0x10, 0, 1, sourceSize] at offset 200 from contentBase
    const sourceHeaderOff = 200;
    buf.writeUInt32LE(0x10, contentBase + sourceHeaderOff);
    buf.writeUInt32LE(0, contentBase + sourceHeaderOff + 4);
    buf.writeUInt32LE(1, contentBase + sourceHeaderOff + 8);
    buf.writeUInt32LE(sourceSize, contentBase + sourceHeaderOff + 12);

    // Source region starts at contentBase + sourceHeaderOff + 16
    const sourceStart = contentBase + sourceHeaderOff + 16;
    readerBytes.copy(buf, sourceStart);

    // Bytecode region after source (must NOT be "// @bun")
    const bytecodeStart = sourceStart + sourceSize + 1;
    if (bytecodeStart + 64 <= buf.length) {
      buf.fill(0xAA, bytecodeStart, bytecodeStart + 64);
    }

    writeFileSync(binaryPath, buf);

    const result = patchBun(binaryPath, { dryRun: true });
    assert.strictEqual(result.success, true, `Expected success but got: ${result.message}`);
    assert.ok(result.message.includes('Dry run'));
    assert.ok(result.message.includes('tier 1'));
  });

  it('patchBun with skipVerify patches a synthesized binary fully', () => {
    const dir = makeTempDir();
    const binaryPath = join(dir, 'claude-synth-full');

    const readerFn = 'async function l59(H,_,q){try{let O=await Y_().readFile(H,{encoding:"utf-8"});return un4(O,H,_,q)}catch(K){return mn4(K,H),{info:null,includePaths:[]}}}';
    const readerBytes = Buffer.from(readerFn, 'utf8');
    const sourceSize = 120000;

    const sectionOffset = 192;
    const headerPadding = 1024;
    const bytecodeSize = 512;
    const contentSize = headerPadding + sourceSize + bytecodeSize + 48 + 16;
    const sectionSize = 8 + contentSize + 256;
    const totalSize = sectionOffset + sectionSize;
    const buf = Buffer.alloc(totalSize);

    // Mach-O header
    buf.writeUInt32LE(0xFEEDFACF, 0);
    buf.writeUInt32LE(1, 16);
    buf.writeUInt32LE(152, 20);

    // LC_SEGMENT_64 __BUN
    const segOff = 32;
    buf.writeUInt32LE(0x19, segOff);
    buf.writeUInt32LE(152, segOff + 4);
    buf.write('__BUN\0', segOff + 8);
    buf.writeBigUInt64LE(BigInt(sectionSize), segOff + 48);
    buf.writeUInt32LE(1, segOff + 64);

    const sectOff = segOff + 72;
    buf.write('__bun\0', sectOff);
    buf.writeBigUInt64LE(BigInt(sectionSize), sectOff + 40);
    buf.writeUInt32LE(sectionOffset, sectOff + 48);

    // Content
    buf.writeBigUInt64LE(BigInt(contentSize), sectionOffset);
    const contentBase = sectionOffset + 8;

    // Bun magic
    buf.write('\n---- Bun! ----\n', contentBase + contentSize - 16, 'utf8');

    // Trailer
    const trailerBase = contentBase + contentSize - 48;
    buf.writeUInt32LE(64, trailerBase + 8);
    buf.writeUInt32LE(32, trailerBase + 12);

    // Entries table
    buf.writeUInt32LE(sourceSize, contentBase + 64 + 12);

    // Source header pattern
    const sourceHeaderOff = 200;
    buf.writeUInt32LE(0x10, contentBase + sourceHeaderOff);
    buf.writeUInt32LE(0, contentBase + sourceHeaderOff + 4);
    buf.writeUInt32LE(1, contentBase + sourceHeaderOff + 8);
    buf.writeUInt32LE(sourceSize, contentBase + sourceHeaderOff + 12);

    // Source region with reader function
    const sourceStart = contentBase + sourceHeaderOff + 16;
    readerBytes.copy(buf, sourceStart);

    // Bytecode region (fill with non-source data)
    const afterSource = sourceStart + sourceSize + 1;
    if (afterSource + 128 <= buf.length) {
      buf.fill(0xBB, afterSource, afterSource + 128);
    }

    writeFileSync(binaryPath, buf);

    const result = patchBun(binaryPath, { skipVerify: true });
    assert.strictEqual(result.success, true, `Expected success but got: ${result.message}`);
    assert.ok(result.message.includes('Patched Bun binary'));
    assert.ok(result.message.includes('tier 1'));

    // Verify backup was created
    const { backupPath: bp } = require('../lib/patcher');
    assert.ok(existsSync(bp(binaryPath)), 'backup should exist');

    // Verify metadata was written
    const meta = readPatchMeta(binaryPath);
    assert.ok(meta, 'metadata should be written');
    assert.strictEqual(meta.regexTier, 1);
    assert.ok(meta.growth > 0);
  });

  it('patchBun returns error when findSourceRegion fails', () => {
    const dir = makeTempDir();
    const binaryPath = join(dir, 'claude-bad-trailer');

    // Build a Mach-O with __BUN section but invalid trailer (no Bun magic)
    const sectionOffset = 192;
    const contentSize = 2048;
    const sectionSize = 8 + contentSize + 256;
    const totalSize = sectionOffset + sectionSize;
    const buf = Buffer.alloc(totalSize);

    // Mach-O header
    buf.writeUInt32LE(0xFEEDFACF, 0);
    buf.writeUInt32LE(1, 16);
    buf.writeUInt32LE(152, 20);

    // LC_SEGMENT_64 __BUN
    const segOff = 32;
    buf.writeUInt32LE(0x19, segOff);
    buf.writeUInt32LE(152, segOff + 4);
    buf.write('__BUN\0', segOff + 8);
    buf.writeBigUInt64LE(BigInt(sectionSize), segOff + 48);
    buf.writeUInt32LE(1, segOff + 64);

    // section_64 __bun
    const sectOff = segOff + 72;
    buf.write('__bun\0', sectOff);
    buf.writeBigUInt64LE(BigInt(sectionSize), sectOff + 40);
    buf.writeUInt32LE(sectionOffset, sectOff + 48);

    // Content size
    buf.writeBigUInt64LE(BigInt(contentSize), sectionOffset);
    // NO Bun magic trailer written -- findSourceRegion will fail

    writeFileSync(binaryPath, buf);

    const result = patchBun(binaryPath);
    assert.strictEqual(result.success, false);
    assert.ok(result.message.includes('trailer magic not found'));
  });

  it('patchBun detects bytecode boundary check failure when source region contains // @bun', () => {
    const dir = makeTempDir();
    const binaryPath = join(dir, 'claude-bun-boundary');

    const readerFn = 'async function l59(H,_,q){try{let O=await Y_().readFile(H,{encoding:"utf-8"});return un4(O,H,_,q)}catch(K){return mn4(K,H),{info:null,includePaths:[]}}}';
    const readerBytes = Buffer.from(readerFn, 'utf8');
    const replacement = buildBunReplacement([
      readerFn, 'l59', 'H', '_', 'q', 'O', 'Y_', 'un4', 'K', 'mn4',
    ]);
    const growth = Buffer.byteLength(replacement) - readerBytes.length;
    const sourceSize = 120000;

    const sectionOffset = 192;
    const headerPadding = 1024;
    const bytecodeSize = 512;
    const contentSize = headerPadding + sourceSize + bytecodeSize + 48 + 16;
    const sectionSize = 8 + contentSize + 256;
    const totalSize = sectionOffset + sectionSize;
    const buf = Buffer.alloc(totalSize);

    // Mach-O header
    buf.writeUInt32LE(0xFEEDFACF, 0);
    buf.writeUInt32LE(1, 16);
    buf.writeUInt32LE(152, 20);

    const segOff = 32;
    buf.writeUInt32LE(0x19, segOff);
    buf.writeUInt32LE(152, segOff + 4);
    buf.write('__BUN\0', segOff + 8);
    buf.writeBigUInt64LE(BigInt(sectionSize), segOff + 48);
    buf.writeUInt32LE(1, segOff + 64);

    const sectOff = segOff + 72;
    buf.write('__bun\0', sectOff);
    buf.writeBigUInt64LE(BigInt(sectionSize), sectOff + 40);
    buf.writeUInt32LE(sectionOffset, sectOff + 48);

    buf.writeBigUInt64LE(BigInt(contentSize), sectionOffset);
    const contentBase = sectionOffset + 8;

    buf.write('\n---- Bun! ----\n', contentBase + contentSize - 16, 'utf8');

    const trailerBase = contentBase + contentSize - 48;
    buf.writeUInt32LE(64, trailerBase + 8);
    buf.writeUInt32LE(32, trailerBase + 12);
    buf.writeUInt32LE(sourceSize, contentBase + 64 + 12);

    const sourceHeaderOff = 200;
    buf.writeUInt32LE(0x10, contentBase + sourceHeaderOff);
    buf.writeUInt32LE(0, contentBase + sourceHeaderOff + 4);
    buf.writeUInt32LE(1, contentBase + sourceHeaderOff + 8);
    buf.writeUInt32LE(sourceSize, contentBase + sourceHeaderOff + 12);

    const sourceStart = contentBase + sourceHeaderOff + 16;
    readerBytes.copy(buf, sourceStart);

    // Write "// @bun" at the position where bytecode should start AFTER patching
    // newSourceEnd = sourceStart + sourceSize + growth
    // newBytecodeStart = newSourceEnd + 1
    const newSourceEnd = sourceStart + sourceSize + growth;
    const newBytecodeStart = newSourceEnd + 1;
    if (newBytecodeStart + 7 <= buf.length) {
      buf.write('// @bun', newBytecodeStart, 'utf8');
    }

    writeFileSync(binaryPath, buf);

    const result = patchBun(binaryPath, { skipVerify: true });
    assert.strictEqual(result.success, false);
    assert.ok(result.message.includes('Bytecode boundary check failed'));
    assert.ok(result.message.includes('Backup restored'));
  });

  it('patchBun returns error when reader function not found in source', () => {
    const dir = makeTempDir();
    const binaryPath = join(dir, 'claude-no-reader');

    // Build a valid binary structure but WITHOUT the reader function in the source region
    const sourceSize = 200000; // needs to be > 100000 to pass plausibility check
    const sectionOffset = 192;
    const headerPadding = 1024;
    const bytecodeSize = 256;
    const contentSize = headerPadding + sourceSize + bytecodeSize + 48 + 16;
    const sectionSize = 8 + contentSize + 256;
    const totalSize = sectionOffset + sectionSize;
    const buf = Buffer.alloc(totalSize);

    // Mach-O
    buf.writeUInt32LE(0xFEEDFACF, 0);
    buf.writeUInt32LE(1, 16);
    buf.writeUInt32LE(152, 20);
    const segOff = 32;
    buf.writeUInt32LE(0x19, segOff);
    buf.writeUInt32LE(152, segOff + 4);
    buf.write('__BUN\0', segOff + 8);
    buf.writeBigUInt64LE(BigInt(sectionSize), segOff + 48);
    buf.writeUInt32LE(1, segOff + 64);
    const sectOff = segOff + 72;
    buf.write('__bun\0', sectOff);
    buf.writeBigUInt64LE(BigInt(sectionSize), sectOff + 40);
    buf.writeUInt32LE(sectionOffset, sectOff + 48);

    // Content
    buf.writeBigUInt64LE(BigInt(contentSize), sectionOffset);
    const contentBase = sectionOffset + 8;
    buf.write('\n---- Bun! ----\n', contentBase + contentSize - 16, 'utf8');
    const trailerBase = contentBase + contentSize - 48;
    buf.writeUInt32LE(64, trailerBase + 8);
    buf.writeUInt32LE(32, trailerBase + 12);
    buf.writeUInt32LE(sourceSize, contentBase + 64 + 12);
    const sourceHeaderOff = 200;
    buf.writeUInt32LE(0x10, contentBase + sourceHeaderOff);
    buf.writeUInt32LE(0, contentBase + sourceHeaderOff + 4);
    buf.writeUInt32LE(1, contentBase + sourceHeaderOff + 8);
    buf.writeUInt32LE(sourceSize, contentBase + sourceHeaderOff + 12);

    // Source region: just zeros, no reader function
    writeFileSync(binaryPath, buf);

    const result = patchBun(binaryPath);
    assert.strictEqual(result.success, false);
    assert.ok(result.message.includes('Could not find the CLAUDE.md reader function'));
  });

  // --- metaPath ---

  it('appends meta suffix to binary path', () => {
    assert.strictEqual(metaPath('/usr/bin/claude'), '/usr/bin/claude.cc-agents-md.meta.json');
  });

  // --- readPatchMeta ---

  it('returns null for non-existent meta file', () => {
    assert.strictEqual(readPatchMeta('/nonexistent/binary'), null);
  });

  it('returns null for malformed meta file', () => {
    const dir = makeTempDir();
    const binaryPath = join(dir, 'claude');
    writeFileSync(metaPath(binaryPath), 'not json{{');
    assert.strictEqual(readPatchMeta(binaryPath), null);
  });

  it('reads valid meta file', () => {
    const dir = makeTempDir();
    const binaryPath = join(dir, 'claude');
    const meta = { version: '1.0.0', patchedAt: '2025-01-01', growth: 42 };
    writeFileSync(metaPath(binaryPath), JSON.stringify(meta));
    const result = readPatchMeta(binaryPath);
    assert.deepStrictEqual(result, meta);
  });

  // --- patchBun ---

  it('returns failure for non-existent binary', () => {
    const result = patchBun('/nonexistent/binary');
    assert.strictEqual(result.success, false);
    assert.ok(result.message.includes('not found'));
  });

  it('returns failure when binary is already patched', () => {
    const dir = makeTempDir();
    const binary = join(dir, 'claude');
    const content = Buffer.from('some binary content ' + BUN_PATCH_MARKER + ' more content');
    writeFileSync(binary, content);
    const result = patchBun(binary);
    assert.strictEqual(result.success, false);
    assert.ok(result.message.includes('Already patched'));
  });

  it('returns failure for non-Bun binary (no __BUN section)', () => {
    const dir = makeTempDir();
    const binary = join(dir, 'claude');
    // Write something that is not a Mach-O
    writeFileSync(binary, Buffer.alloc(1024));
    const result = patchBun(binary);
    assert.strictEqual(result.success, false);
    assert.ok(result.message.includes('Not a Bun standalone binary'));
  });

  // --- unpatchBun ---

  it('restores from backup when backup exists', () => {
    const dir = makeTempDir();
    const binary = join(dir, 'claude');
    const backup = binary + '.cc-agents-md.bak';
    const original = Buffer.from('original binary content');
    const patched = Buffer.from('patched binary content ' + BUN_PATCH_MARKER);

    writeFileSync(binary, patched);
    writeFileSync(backup, original);

    const result = unpatchBun(binary);
    assert.strictEqual(result.success, true);
    assert.ok(result.message.includes('Restored'));
    assert.ok(!existsSync(backup), 'backup should be removed');

    const restored = readFileSync(binary);
    assert.deepStrictEqual(restored, original);
  });

  it('reports not patched when binary lacks marker and no backup', () => {
    const dir = makeTempDir();
    const binary = join(dir, 'claude');
    writeFileSync(binary, Buffer.from('clean binary'));
    const result = unpatchBun(binary);
    assert.strictEqual(result.success, true);
    assert.ok(result.message.includes('Not patched'));
  });

  it('reports failure when patched but no backup exists', () => {
    const dir = makeTempDir();
    const binary = join(dir, 'claude');
    writeFileSync(binary, Buffer.from('content with ' + BUN_PATCH_MARKER + ' marker'));
    const result = unpatchBun(binary);
    assert.strictEqual(result.success, false);
    assert.ok(result.message.includes('no backup'));
  });

  it('returns failure for non-existent binary on unpatch', () => {
    const result = unpatchBun('/nonexistent/binary');
    assert.strictEqual(result.success, false);
    assert.ok(result.message.includes('not found'));
  });
});
