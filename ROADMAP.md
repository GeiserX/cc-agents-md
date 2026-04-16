# Roadmap

## Released

### v0.1.0 — SessionStart hook (initial release)

Registered a `SessionStart` hook in `~/.claude/settings.json` that injects AGENTS.md content into every Claude Code session. Walk-up discovery from working directory to git root, root-first ordering, pure bash loader.

### v0.2.0 — Configurable inline threshold

Added support for large AGENTS.md files. Files under a configurable threshold (default 200 lines) are inlined directly into Claude's context via hook stdout. Larger files produce a read instruction with an absolute path so Claude reads them on demand. Configurable via `AGENTS_MD_INLINE_THRESHOLD` environment variable.

### v0.3.0 — Security hardening

- Symlink rejection in the bash loader (prevents path traversal via malicious symlinks)
- Shell injection prevention (safe argument handling throughout)
- File permission checks on the hook script
- Zero filesystem footprint — no generated files, AGENTS.md is the single source of truth

### v0.4.0 — Experimental internal patching

Introduced `cc-agents-md patch` to modify Claude Code's internal file-loading logic so it recognizes AGENTS.md natively alongside CLAUDE.md.

**How it works.** Claude Code's minified source contains an async reader function:

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

The patch wraps the catch block with a fallback: `H.replace("CLAUDE","AGENTS")` derives the AGENTS.md path, and a recursive call loads it. Natural recursion guard: when called with an AGENTS.md path, the replace returns the same string, so `z != H` is false and the recursion stops.

- **npm installs**: Direct source file patching (text replacement with backup)
- **Native binaries**: Legacy in-place byte replacement with null padding detection
- Supports AGENTS.md, AGENTS.local.md, and .claude/AGENTS.md
- Respects the same walk-up discovery Claude Code uses for CLAUDE.md
- Must be reapplied after Claude Code updates

### v0.5.0 — Robust Bun patching, auto-repatch, cross-platform

Major reliability overhaul for Homebrew binary patching, plus platform expansion.

#### Bun binary patcher rewrite (`lib/patch-bun.js`)

The Homebrew Claude Code binary is a Bun standalone (~190 MB Mach-O arm64). The previous approach (legacy `patch-native.js`) used in-place byte replacement that failed when there was no null padding between functions. The new patcher uses **source-local expansion into bytecode space**:

1. **Trailer-anchored navigation** — Dynamically discovers the source region by parsing the Bun trailer backwards (magic `\n---- Bun! ----\n` at content end, then entries table, then source header pattern `[0x10, 0x00, 0x01, source_size]`). No hardcoded offsets.
2. **Tiered regex fallback** — 3 patterns from strict to relaxed (exact CC shape, relaxed encoding `utf-8`/`utf8`, extra trailing params). Logs which tier matched for diagnostics.
3. **Source-local shift** — Shifts only bytes within the source region forward by ~82 bytes. The overflow lands in the first bytes of bytecode, which is disabled anyway. No file growth, no Mach-O header changes, no trailer updates.
4. **Bytecode disabling** — Zeroes 64 bytes at the new bytecode start to invalidate the bytecode header, forcing Bun to interpret source. First launch after patching is slower (~10-30s).
5. **Bytecode boundary sanity check** — Verifies the boundary with a `// @bun` probe before zeroing. Auto-restores backup if the check fails.
6. **Post-patch verification** — Runs `claude --version` (90s timeout for first cold start) after patching. Auto-restores backup on failure.
7. **Version metadata** — Stores `{ version, regexTier, growth, patchedAt }` in a `.meta.json` file alongside the backup. Used by `doctor` for diagnostics and stale-patch detection.
8. **Security** — All shell commands use `execFileSync` with argument arrays (no shell injection). `codesign -s - -f` re-signs and `xattr -dr com.apple.quarantine` removes quarantine.

#### Auto-repatch watcher

`cc-agents-md watch` installs a platform-native file watcher that automatically reapplies the patch after Claude Code upgrades.

- **macOS**: LaunchAgent with `WatchPaths` on `/opt/homebrew/Caskroom/claude-code`. Fires after `brew upgrade claude-code` and runs `cc-agents-md patch --force --auto`.
- **Linux**: systemd user path unit (`PathChanged`) monitoring the npm global install directory, plus a oneshot service unit that runs the patch command.

Both write logs to `~/.claude/cc-agents-md-autopatch.log`.

The `--auto` flag (used by the watcher) suppresses the warning banner, uses ISO-timestamped log lines, auto-forces native patching, and tolerates "already patched" as a no-op.

#### Windows support

- **PowerShell loader** (`bin/loader.ps1`) — Port of `loader.sh` for Windows. Walks from `$env:CLAUDE_PROJECT_DIR` to git root, collects AGENTS.md files, skips symlinks/junctions, inlines small files, emits read instructions for large ones. Respects `$env:AGENTS_MD_INLINE_THRESHOLD`.
- **CLI platform awareness** — `setup` uses `.ps1` extension and `powershell -NoProfile -ExecutionPolicy Bypass -File` as the hook command on Windows. Skips `chmod` on non-Unix platforms.

#### CLI improvements

- `doctor` now checks patch metadata, detects version mismatches (patched v2.1.90 but running v2.1.92), and reports watcher status
- `watch` / `unwatch` commands in the CLI dispatch table
- `--path` override for targeting specific installations
- Installation resolver prefers previously-patched installs (avoids patching the wrong binary when both npm and native exist)

---

## Bun standalone binary format (reference)

The Homebrew binary is a Bun standalone (~190 MB Mach-O arm64). This section documents the format for contributors and debuggers.

### Mach-O layout

- `__BUN.__bun` section: ~120 MB at file offset ~70.7 MB
- Segment has ~4.5 KB padding after section end (unused)
- Binary is ad-hoc codesigned; must re-sign after any modification

### `__BUN` section content layout

```text
[8-byte header: u64 content_size]
[module header: ~424 bytes]
  - source header pattern at content offset ~400: [0x10, 0x00, 0x01, source_size]
  - source text starts immediately after the pattern
[source text: ~12 MB of minified JS]
[\0 null terminator]
[compiled bytecode: ~96 MB — Bun's pre-compiled format]
[auxiliary modules: native .node files + helper JS]
[trailer entries: module graph metadata]
[magic: "\n---- Bun! ----\n" (16 bytes)]
```

### Trailer structure (48 bytes before magic)

```text
[... 8 bytes ...]
[entries_table_offset: u32]  ← offset from content_base
[entries_table_length: u32]
[... remaining trailer fields ...]
[\n---- Bun! ----\n]
```

Each module entry in the entries table: `path_offset(u32) + path_length(u32) + data_offset(u32) + data_size(u32)`. Paths start with `/$bunfs/`. Typical binary has ~11 modules (1 main JS + 5 helper JS + 5 native .node).

### Patching strategy: source-local expansion

The reader function is ~152 bytes; the patched version is ~234 bytes (~82 byte growth). The binary is tightly packed — no null padding between functions. Full-content shift would cause Bus errors because bytecode has internal absolute offsets.

**Solution**: Only shift bytes within the source region (from reader function end to source end). The shifted tail overflows into the first ~82 bytes of bytecode, which is disabled by zeroing.

Steps:
1. Parse Mach-O to find `__BUN.__bun` section (iterate `nsects`, match by name)
2. Parse trailer backwards to find `source_size` from entries table
3. Scan module header for `[0x10, 0x00, 0x01, source_size]` pattern
4. Find reader function via tiered regex in source text (64 KB chunked search with 512-byte overlap)
5. `buffer.copy()` source bytes after reader function forward by `growth` bytes
6. Write patched function at original offset
7. Write null terminator after new source end
8. Update all `source_size` fields found in the module header
9. Zero 64 bytes at new bytecode start (with `// @bun` boundary probe)
10. Re-codesign and remove quarantine
11. Verify with `--version` (90s timeout), restore backup on failure
12. Write metadata JSON for diagnostics

**No file growth. No Mach-O header changes. No trailer updates. No section size changes.**

---

### v0.6.0 — Cross-platform support

- **Windows PowerShell loader** (`bin/loader.ps1`) — Port of `loader.sh` for Windows SessionStart hook
- **Linux systemd watcher** — auto-repatch via `systemctl --user` path unit + oneshot service
- **CLI platform awareness** — `setup`, `preview`, `doctor` dispatch correctly per platform
- Windows hook detection in `settings.js` (`.ps1` support in `isInstalled`/`removeHook`)
- `watch.js` uses `execFileSync` throughout (no shell string injection)

### v0.7.0 (current) — Caching, diagnostics, configuration

All remaining planned roadmap items shipped in one release.

#### Caching and performance

- **Stat-based output caching** — The loader hashes file paths + modification times + config values (SHA-256) and caches the assembled output in `~/.claude/cc-agents-md-cache/`. On cache hit, the loader returns instantly without reading or assembling files. Cache is automatically pruned to the 20 most recent entries.
- **Cache key includes config** — Changing the inline threshold, patterns, or exclude list invalidates the cache.
- **Benchmark suite** (`bench/benchmark.sh`) — Measures hook latency across scenarios: no files (baseline), small/medium/large single files, nested monorepo, and cached runs.

#### Enhanced diagnostics

- **`cc-agents-md logs`** — Tail the auto-repatch watcher log (`~/.claude/cc-agents-md-autopatch.log`). Supports `--lines N` (default: 50).
- **`cc-agents-md diff`** — Show what the patch changed. For npm installs: unified diff between backup and current `cli.js`. For native binaries: patch metadata (version, regex tier, byte growth, source sizes).
- **`--json` flag** — Machine-readable JSON output for `status`, `doctor`, `preview`, `logs`, and `diff`. Designed for CI pipelines and scripting.
- **`--verbose` flag** — Extra output during `patch`: shows config file path, patterns, cache setting, and post-patch details (regex tier, source growth, size locations).

#### Configuration file

- **`.agents-md.json`** — Per-project configuration file, discovered via walk-up from working directory. Parsed by both the Node CLI (`lib/config.js`) and the bash/PowerShell loaders (via `node -e` / `ConvertFrom-Json`).
- **Custom file patterns** — `"patterns": ["AGENTS.md", "GUIDELINES.md"]` loads additional file types alongside AGENTS.md.
- **Exclude patterns** — `"exclude": ["vendor", "node_modules"]` skips directories during walk-up discovery.
- **Threshold override** — `"threshold": 100` overrides the default 200-line inline threshold.
- **Cache toggle** — `"cache": false` disables stat-based caching.

Example `.agents-md.json`:

```json
{
  "threshold": 150,
  "patterns": ["AGENTS.md", "RULES.md"],
  "exclude": ["vendor"],
  "cache": true
}
```

Environment variables (`AGENTS_MD_INLINE_THRESHOLD`, `AGENTS_MD_PATTERNS`, `AGENTS_MD_EXCLUDE`, `AGENTS_MD_CACHE`) take precedence over the config file for CI overrides.

---

## Future ideas

- **Official support** — Lobby Anthropic to add native AGENTS.md support to Claude Code ([anthropics/claude-code#6235](https://github.com/anthropics/claude-code/issues/6235), 3,600+ upvotes)
- **Mid-session reload** — Detect AGENTS.md changes during a running session and re-inject (requires Claude Code hook API expansion)
- **Monorepo awareness** — Load AGENTS.md from sibling packages in monorepos, not just ancestor directories
- **CI/CD integration** — GitHub Action / pre-commit hook that validates AGENTS.md files (syntax, size, conflicts)
- **Migration tool** — `cc-agents-md migrate` to convert existing CLAUDE.md files to AGENTS.md format
- **Plugin system** — Allow custom transformers that process AGENTS.md content before injection (variable substitution, conditional sections)
