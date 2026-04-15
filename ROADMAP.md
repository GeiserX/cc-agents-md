# Roadmap

## v0.3.0 — Hybrid loading + security fixes

- Small AGENTS.md files inlined fully via hook stdout
- Large files: read instruction with absolute path (Claude reads on demand)
- Zero filesystem footprint — no generated files, AGENTS.md is the source of truth
- Configurable threshold via `AGENTS_MD_INLINE_THRESHOLD`
- Security hardening: symlink rejection, shell injection prevention, file permissions

## v0.4.0 — Experimental internal patching

Modify Claude Code's internal file-loading logic to recognize `AGENTS.md` natively alongside `CLAUDE.md`:

- **`cc-agents-md patch`** — patches Claude Code's async reader function to try AGENTS.md as a fallback when CLAUDE.md is not found
- Supports npm installations (direct `cli.js` patching) and native Bun binaries (Homebrew, with `--force`)
- Bun patching uses format-aware source-local expansion (not crude string replacement)
- AGENTS.md, AGENTS.local.md, and .claude/AGENTS.md all become loadable
- Respects the same walk-up discovery Claude Code uses for CLAUDE.md
- Must be reapplied after Claude Code updates
- **Experimental** — opt-in via `cc-agents-md patch`, disabled by default

### How it works

Claude Code's minified source contains an async reader function (variable names change per version):

```javascript
async function l59(H,_,q){
  try {
    let O = await Y_().readFile(H, {encoding:"utf-8"});
    return un4(O, H, _, q);
  } catch(K) {
    return mn4(K, H), {info:null, includePaths:[]};
  }
}
```

The patch wraps this with a fallback that uses `path.replace("CLAUDE","AGENTS")` to derive the AGENTS.md path. Natural recursion guard: when called with an AGENTS.md path, the replace returns the same string, so `z != H` is false and recursion stops.

For **npm** installs: direct source file patching (simple text replacement).
For **Homebrew** (Bun standalone binary): Mach-O-aware patching that expands source into disabled bytecode space. See "Bun standalone binary format" below for details.

## v0.5.0 (current) — Robust Bun patching + auto-repatch

Hardened the Homebrew binary patcher for reliability across Claude Code upgrades:

- **Trailer-anchored navigation** — dynamically discovers source region by parsing the Bun trailer backwards instead of hardcoding offsets (164, 420, 424)
- **Tiered regex fallback** — 3 patterns from strict to relaxed; logs which tier matched
- **Post-patch verification** — runs `--version` after patching, auto-restores backup on failure
- **Bytecode sanity check** — verifies boundary (`// @bun` probe) before zeroing 64 bytes
- **Version metadata** — stores `{ version, regexTier, growth }` alongside backup for `doctor` diagnostics and stale-patch detection
- **Auto-repatch watcher** — `cc-agents-md watch` installs a macOS LaunchAgent that monitors `/opt/homebrew/Caskroom/claude-code` and reapplies the patch after `brew upgrade`
- **Security** — `execFileSync` with arg arrays (no shell injection), proper `__bun` section name matching

## Bun standalone binary format (reference)

The Homebrew binary is a Bun standalone (~190MB Mach-O arm64). Key structure:

### Mach-O layout
- `__BUN.__bun` section: ~120MB at file offset ~70.7MB
- Segment has ~4.5KB padding after section end (unused)
- Binary is ad-hoc codesigned; must re-sign after any modification

### __BUN section content layout
```text
[8-byte header: u64 content_size]
[module header: bytes 0-423]
  - source_size stored at content offsets 164 AND 420 (both must match)
  - source text starts at content offset 424
[source text: ~12MB of minified JS]
[\0 null terminator]
[compiled bytecode: ~96MB — Bun's pre-compiled format]
[auxiliary modules: native .node files + helper JS]
[trailer entries: module graph metadata]
[magic: "---- Bun! ----"]
```

### Trailer entry format
Each module entry: `path_offset(u32) + path_length(u32) + data_offset(u32) + data_size(u32)`
where `data_offset = path_offset + path_length + 1`. Paths start with `/$bunfs/`.
Typical binary has ~11 modules (1 main JS + 5 helper JS + 5 native .node).

### Patching strategy: source-local expansion into bytecode space

The reader function is ~152 bytes; the patched version is ~234 bytes (~82 byte growth).
The binary is tightly packed — no null padding between functions. Full-content shift
(moving everything after the function) causes Bus errors because bytecode has internal
absolute offsets that break when shifted.

**Solution**: Only shift bytes within the source region (from reader function end to source end).
The shifted tail overflows into the first ~82 bytes of bytecode, which is disabled anyway.

Steps:
1. Parse Mach-O to find `__BUN.__bun` section offset and size
2. Read `source_size` from content offsets 164 and 420
3. Find reader function via regex in source text (64KB chunked search)
4. `buffer.copy()` source bytes after reader function forward by `growth` bytes
5. Write patched function at original offset
6. Write null terminator after new source end
7. Update `source_size` fields at offsets 164 and 420 (+growth)
8. Zero 32 bytes at new bytecode start to invalidate bytecode header
9. Re-codesign (`codesign -s - -f`) and remove quarantine (`xattr -dr`)

**No file growth. No Mach-O header changes. No trailer updates. No section size changes.**

Bytecode is disabled by zeroing its header bytes, forcing Bun to interpret source.
First launch after patching is slower (~10-30s) due to source parsing.

## Future ideas

- **Auto-repatch** — detect Claude Code updates and re-apply the patch automatically
- **Windows support** — PowerShell-based loader for Windows users
- **Caching** — skip re-reading unchanged AGENTS.md files across sessions
- **Watch mode** — re-inject on AGENTS.md file changes mid-session
- **Official support** — lobby Anthropic to add native AGENTS.md support to Claude Code (tracked in [anthropics/claude-code#6235](https://github.com/anthropics/claude-code/issues/6235))
