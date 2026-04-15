# Security Policy

## Reporting Security Issues

**Please do not report security vulnerabilities through public GitHub issues.**

Instead, please use GitHub's private vulnerability reporting:

1. Go to https://github.com/GeiserX/agents-md-loader/security/advisories
2. Click "Report a vulnerability"
3. Fill out the form with details

We will respond within **48 hours** and work with you to understand and address the issue.

### What to Include

- Type of issue (e.g., command injection, path traversal)
- Full paths of affected source files
- Step-by-step instructions to reproduce
- Proof-of-concept or exploit code (if possible)
- Impact assessment and potential attack scenarios

### Supported Versions

| Version | Supported          |
| ------- | ------------------ |
| 0.x.x   | Current release    |

Only the latest version receives security updates. We recommend always running the latest version.

## Security Architecture

### File System Access

- **Read-only**: The loader script (`loader.sh`) only reads AGENTS.md files — it never writes, deletes, or modifies any files.
- **Bounded traversal**: Directory walking is bounded between the current working directory and the git root. It cannot escape the repository.
- **No symlink exploitation**: Standard `cat` follows symlinks, but the walk is bounded to the repo root, limiting the attack surface.

### Settings Modification

- The `setup` command modifies `~/.claude/settings.json` to add a hook entry. It merges non-destructively and never overwrites existing settings.
- The `remove` command only removes the specific hook entry added by this tool.

### Shell Execution

- The hook script runs as a `command`-type hook in Claude Code's hook system, inheriting the user's shell permissions.
- No user input is passed to shell commands — the script only uses `$CLAUDE_PROJECT_DIR` (set by Claude Code) and filesystem paths.

## Security Best Practices

### For Contributors

1. **Never execute user-controlled strings** — All shell operations use hardcoded commands and paths.
2. **Validate paths** — Directory traversal is bounded to the git root.
3. **Fail silently** — The loader script never blocks a Claude Code session, even on errors.

---

*Last updated: April 2025*
