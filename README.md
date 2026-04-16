<p align="center">
  <img src="docs/images/banner.svg" alt="cc-agents-md banner" width="900"/>
</p>

<p align="center">
  <a href="https://github.com/GeiserX/cc-agents-md/actions/workflows/ci.yml"><img src="https://github.com/GeiserX/cc-agents-md/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
  <a href="https://www.npmjs.com/package/cc-agents-md"><img src="https://img.shields.io/npm/v/cc-agents-md" alt="npm version"></a>
  <a href="https://www.gnu.org/licenses/gpl-3.0"><img src="https://img.shields.io/badge/License-GPL--3.0-blue.svg" alt="License: GPL-3.0"></a>
</p>

Claude Code only reads `CLAUDE.md`. The [AGENTS.md specification](https://agents.md) is supported by 23+ tools (Codex, Cursor, Copilot, Gemini CLI, and more), but Claude Code is not one of them. This has been the [most requested feature](https://github.com/anthropics/claude-code/issues/6235) (3,600+ upvotes) with no official response.

**cc-agents-md** fixes this. One command, and every Claude Code session automatically loads your AGENTS.md files. No CLAUDE.md wrapper files. No symlinks.

## How It Works

A `SessionStart` hook is registered in `~/.claude/settings.json`. On every new Claude Code session, the hook:

1. Walks **upward** from your working directory to the git root
2. Collects every `AGENTS.md` on the path
3. Small files are **inlined** directly into Claude's context
4. Large files get a **read instruction** — Claude reads the full file on demand

```text
monorepo/
├── AGENTS.md                  ← always loaded (project root)
├── packages/
│   ├── frontend/
│   │   ├── AGENTS.md          ← loaded if you're working here
│   │   └── src/
│   └── backend/
│       ├── AGENTS.md          ← NOT loaded (not on your path)
│       └── src/
```

The depth adapts to where you are. Open Claude at the root? One file. Open it in `packages/frontend`? Two files. No scanning downward, no wasted context.

## Installation

```bash
npx cc-agents-md setup
```

That's it. Restart Claude Code.

### Verify

```bash
npx cc-agents-md doctor
```

### Uninstall

```bash
npx cc-agents-md remove
```

## Commands

| Command   | Description                                       |
|-----------|---------------------------------------------------|
| `setup`   | Install the SessionStart hook globally             |
| `remove`  | Uninstall completely (hook + script)               |
| `status`  | Show installation state and detected AGENTS.md     |
| `doctor`  | Full health check (hook, patch, watcher, config)   |
| `preview` | Print exactly what Claude would see                |
| `patch`   | **Experimental** — patch Claude Code internals     |
| `unpatch` | Restore Claude Code to original state              |
| `watch`   | Auto-repatch after Claude Code upgrades (macOS/Linux) |
| `unwatch` | Remove the auto-repatch watcher                    |
| `logs`    | Show auto-repatch watcher log (`--lines N`)        |
| `diff`    | Show what the patch changed (unified diff or metadata) |

### Output flags

| Flag        | Description                                      |
|-------------|--------------------------------------------------|
| `--json`    | Machine-readable JSON (`status`, `doctor`, `preview`, `logs`, `diff`) |
| `--verbose` | Extra detail during `patch` (regex tier, byte offsets, config) |

## Experimental: Internal Patching

> **Warning**: This is experimental. It modifies Claude Code's JavaScript internals and may break after updates. Use `cc-agents-md unpatch` to restore at any time.

The default `setup` command uses a stable SessionStart hook. For deeper integration, `patch` modifies Claude Code itself so it loads AGENTS.md natively — the same way it loads CLAUDE.md:

```bash
# Dry run — see what would change
cc-agents-md patch --dry-run

# Patch npm installation
cc-agents-md patch

# Patch native binary (Homebrew) — requires --force
cc-agents-md patch --force

# Restore original
cc-agents-md unpatch
```

### What it does

Patches the async reader function inside Claude Code to try `AGENTS.md` as a fallback when `CLAUDE.md` is not found. This means:

- `AGENTS.md` is loaded at each directory level (same walk-up discovery as CLAUDE.md)
- `AGENTS.local.md` works as a local counterpart (like CLAUDE.local.md)
- `.claude/AGENTS.md` is checked alongside `.claude/CLAUDE.md`

### After Claude Code updates

The patch needs to be reapplied after every Claude Code update:

```bash
cc-agents-md patch        # or: cc-agents-md patch --force
```

The backup of the previous version is stored alongside the patched file and used by `unpatch` to restore.

### Auto-repatch watcher

Tired of repatching after every update? The `watch` command installs a platform-native file watcher that automatically reapplies the patch:

```bash
# Install the watcher
cc-agents-md watch

# Remove it
cc-agents-md unwatch
```

- **macOS**: LaunchAgent monitoring `/opt/homebrew/Caskroom/claude-code` — fires after `brew upgrade claude-code`
- **Linux**: systemd user path unit monitoring the npm global install directory

Logs are written to `~/.claude/cc-agents-md-autopatch.log`.

## Configuration

### Config file

Create `.agents-md.json` at your project root (or any ancestor directory) to customize behavior:

```json
{
  "threshold": 150,
  "patterns": ["AGENTS.md", "RULES.md"],
  "exclude": ["vendor", "node_modules"],
  "cache": true
}
```

| Key         | Default          | Description                                        |
|-------------|------------------|----------------------------------------------------|
| `threshold` | `200`            | Lines — inline below, read instruction above       |
| `patterns`  | `["AGENTS.md"]`  | File names to look for at each directory level      |
| `exclude`   | `[]`             | Directory names to skip during walk-up discovery    |
| `cache`     | `true`           | Cache assembled output based on file modification times |

### Environment variables

Environment variables override the config file (useful for CI):

```bash
export AGENTS_MD_INLINE_THRESHOLD=200   # lines — inline below, read instruction above
export AGENTS_MD_PATTERNS=AGENTS.md,RULES.md   # comma-separated file patterns
export AGENTS_MD_EXCLUDE=vendor,dist            # comma-separated directories to skip
export AGENTS_MD_CACHE=0                        # disable caching
```

## How is this different from...

### `@AGENTS.md` in CLAUDE.md

That still requires a CLAUDE.md file in every repo. Also, [imported content is followed less reliably](https://github.com/anthropics/claude-code/issues/35295) than inline instructions.

### Symlink `CLAUDE.md → AGENTS.md`

Still creates a CLAUDE.md file (even if it's a symlink). Doesn't handle nested AGENTS.md in monorepos.

### `tweakcc`

A general-purpose Claude Code patcher with 40+ patches (themes, prompts, tools, etc.). cc-agents-md is focused solely on AGENTS.md loading — the `setup` command uses the stable hook API (no patching), while `patch` is an opt-in experimental alternative for deeper integration.

## Platform support

| Platform | Hook loader | Patching | Auto-repatch watcher |
|----------|-------------|----------|---------------------|
| macOS    | bash        | npm + Homebrew (Bun binary) | LaunchAgent |
| Linux    | bash        | npm      | systemd user path unit |
| Windows  | PowerShell  | npm      | not yet supported |

## Requirements

- Claude Code (any version with SessionStart hooks)
- Node.js >= 18 (for the CLI only — the runtime hook is pure bash / PowerShell)
- bash (macOS/Linux) or PowerShell (Windows)

## License

GPL-3.0 — see [LICENSE](LICENSE).
