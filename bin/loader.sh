#!/usr/bin/env bash
# cc-agents-md: Loads AGENTS.md files for Claude Code SessionStart hook.
# Walks from $CLAUDE_PROJECT_DIR up to git root, outputs root-first.
# Small files are inlined fully; large files get a read instruction.
# All errors silenced — never block a session.

# Validate inline threshold as positive integer, fall back to default
INLINE_THRESHOLD="${AGENTS_MD_INLINE_THRESHOLD:-200}"
case "$INLINE_THRESHOLD" in
  ''|*[!0-9]*) INLINE_THRESHOLD=200 ;;
esac

PROJECT="${CLAUDE_PROJECT_DIR:-.}"

# Resolve to absolute physical path (resolves symlinks — critical for git root comparison)
PROJECT="$(cd "$PROJECT" 2>/dev/null && pwd -P)" || exit 0

# Find git root or use project dir
ROOT="$(git -C "$PROJECT" rev-parse --show-toplevel 2>/dev/null)" || ROOT="$PROJECT"

# Walk from project dir up to root, collecting AGENTS.md paths
files=()
dir="$PROJECT"
while :; do
  # Skip symlinks to prevent reading files outside the repository
  if [ -f "$dir/AGENTS.md" ] && [ ! -L "$dir/AGENTS.md" ]; then
    files+=("$dir/AGENTS.md")
  fi
  [ "$dir" = "$ROOT" ] && break
  parent="$(dirname "$dir")"
  [ "$parent" = "$dir" ] && break
  dir="$parent"
done

# Nothing found — silent exit
[ ${#files[@]} -eq 0 ] && exit 0

# Reverse array: root first, deeper last (general → specific)
reversed=()
for (( i=${#files[@]}-1; i>=0; i-- )); do
  reversed+=("${files[$i]}")
done

# Output: inline small files, read instruction for large ones
for f in "${reversed[@]}"; do
  prefix="$ROOT/"
  rel="${f#$prefix}"
  [ "$rel" = "$f" ] && rel="$(basename "$f")"

  # Count actual lines (awk counts lines, not newlines — handles missing trailing newline)
  lines=$(awk 'END{print NR}' "$f" 2>/dev/null || echo 0)

  if [ "$lines" -le "$INLINE_THRESHOLD" ]; then
    # Small file — inline fully
    echo "# AGENTS.md — ${rel}"
    echo ""
    cat "$f" 2>/dev/null
    echo ""
  else
    # Large file — read instruction only
    echo "# AGENTS.md — ${rel} (${lines} lines)"
    echo "# Read the full file for project instructions: ${f}"
    echo ""
  fi
done

exit 0
