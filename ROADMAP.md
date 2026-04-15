# Roadmap

## v0.3.0 (current) — Hybrid loading + security fixes

- Small AGENTS.md files inlined fully via hook stdout
- Large files: read instruction with absolute path (Claude reads on demand)
- Zero filesystem footprint — no generated files, AGENTS.md is the source of truth
- Configurable threshold via `AGENTS_MD_INLINE_THRESHOLD`
- Security hardening: symlink rejection, shell injection prevention, file permissions

## v0.4.0 (current) — Experimental internal patching

Modify Claude Code's internal file-loading logic to recognize `AGENTS.md` natively alongside `CLAUDE.md`:

- **`cc-agents-md patch`** — patches Claude Code's async reader function to try AGENTS.md as a fallback when CLAUDE.md is not found
- Supports npm installations (direct `cli.js` patching) and native binaries (Homebrew, with `--force`)
- AGENTS.md, AGENTS.local.md, and .claude/AGENTS.md all become loadable
- Respects the same walk-up discovery Claude Code uses for CLAUDE.md
- Must be reapplied after Claude Code updates
- **Experimental** — opt-in via `cc-agents-md patch`, disabled by default

### How it works

Claude Code's minified source contains an async reader function:

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

The patch wraps this with a fallback: if reading `CLAUDE.md` fails, it tries `AGENTS.md` in the same directory before returning an error. Variable names change per Claude Code version, so the regex uses capture groups.

## Future ideas

- **LIEF-based native patching** — proper Bun section extraction/repacking for native binaries (currently uses direct byte replacement)
- **Auto-repatch** — detect Claude Code updates and re-apply the patch automatically
- **Windows support** — PowerShell-based loader for Windows users
- **Caching** — skip re-reading unchanged AGENTS.md files across sessions
- **Watch mode** — re-inject on AGENTS.md file changes mid-session
- **Official support** — lobby Anthropic to add native AGENTS.md support to Claude Code (tracked in [anthropics/claude-code#6235](https://github.com/anthropics/claude-code/issues/6235))
