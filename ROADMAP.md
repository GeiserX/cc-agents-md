# Roadmap

## v0.2.0 (current) — Hybrid loading

- Small AGENTS.md files inlined fully via hook stdout
- Large files: preview + read instruction (Claude reads the full file on demand)
- Zero filesystem footprint — no generated files, AGENTS.md is the source of truth
- Configurable thresholds via `AGENTS_MD_INLINE_THRESHOLD` and `AGENTS_MD_PREVIEW_LINES`

## v0.3.0 — Claude Code internals patch

Modify Claude Code's internal file-loading logic to recognize `AGENTS.md` natively alongside `CLAUDE.md`. This would:

- Replace all internal references to `CLAUDE.md` with support for `AGENTS.md`
- Make AGENTS.md a first-class citizen — loaded automatically, same as CLAUDE.md
- Eliminate the need for hooks entirely
- Respect the same walk-up discovery Claude Code uses for CLAUDE.md

This is the "hard approach" — patching Claude Code's JavaScript internals (like `tweakcc` does). It would need to be reapplied after Claude Code updates.

## Future ideas

- **Windows support** — PowerShell-based loader for Windows users
- **Caching** — skip re-reading unchanged AGENTS.md files across sessions
- **Dry-run mode** — show what would be loaded without actually running the hook
- **Watch mode** — re-inject on AGENTS.md file changes mid-session
- **Official support** — lobby Anthropic to add native AGENTS.md support to Claude Code (tracked in [anthropics/claude-code#6235](https://github.com/anthropics/claude-code/issues/6235))
