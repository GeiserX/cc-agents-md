#!/usr/bin/env bash
# cc-agents-md: Loads AGENTS.md files for Claude Code SessionStart hook.
# Walks from $CLAUDE_PROJECT_DIR up to git root, outputs root-first.
# Small files are inlined fully; large files get a preview + read instruction.
# All errors silenced — never block a session.

INLINE_THRESHOLD="${AGENTS_MD_INLINE_THRESHOLD:-200}"
PREVIEW_LINES="${AGENTS_MD_PREVIEW_LINES:-50}"
PROJECT="${CLAUDE_PROJECT_DIR:-.}"

# Resolve to absolute path
PROJECT="$(cd "$PROJECT" 2>/dev/null && pwd)" || exit 0

# Find git root or use project dir
ROOT="$(git -C "$PROJECT" rev-parse --show-toplevel 2>/dev/null)" || ROOT="$PROJECT"

# Walk from project dir up to root, collecting AGENTS.md paths
files=()
dir="$PROJECT"
while :; do
  [ -f "$dir/AGENTS.md" ] && files+=("$dir/AGENTS.md")
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

# Output: inline small files, preview + read instruction for large ones
for f in "${reversed[@]}"; do
  prefix="$ROOT/"
  rel="${f#$prefix}"
  [ "$rel" = "$f" ] && rel="$(basename "$f")"

  lines=$(wc -l < "$f" 2>/dev/null || echo 0)
  lines="${lines##* }"

  if [ "$lines" -le "$INLINE_THRESHOLD" ]; then
    # Small file — inline fully
    echo "# AGENTS.md — ${rel}"
    echo ""
    cat "$f" 2>/dev/null
    echo ""
  else
    # Large file — preview + read instruction
    echo "# AGENTS.md — ${rel} (${lines} lines — preview below, read full file for complete instructions)"
    echo ""
    head -n "$PREVIEW_LINES" "$f" 2>/dev/null
    echo ""
    echo "# [${rel}: ${lines} lines total — Read full file: ${f}]"
    echo ""
  fi
done

exit 0
