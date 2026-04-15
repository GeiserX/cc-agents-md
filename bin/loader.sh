#!/usr/bin/env bash
# agents-md-loader: Loads AGENTS.md files for Claude Code SessionStart hook.
# Walks from $CLAUDE_PROJECT_DIR up to git root, outputs root-first.
# All errors silenced — never block a session.

MAX_LINES="${AGENTS_MD_MAX_LINES:-5000}"
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

# Output with headers
total_lines=0
for f in "${reversed[@]}"; do
  prefix="$ROOT/"
  rel="${f#$prefix}"
  [ "$rel" = "$f" ] && rel="$(basename "$f")"

  lines=$(wc -l < "$f" 2>/dev/null || echo 0)
  lines="${lines##* }"
  total_lines=$((total_lines + lines))

  if [ "$total_lines" -gt "$MAX_LINES" ]; then
    echo "# AGENTS.md — ${rel} [TRUNCATED — exceeded ${MAX_LINES} line limit]"
    echo ""
    remaining=$((MAX_LINES - (total_lines - lines)))
    [ "$remaining" -gt 0 ] && head -n "$remaining" "$f" 2>/dev/null
    echo ""
    echo "# [Remaining AGENTS.md files skipped due to size limit]"
    break
  fi

  echo "# AGENTS.md — ${rel}"
  echo ""
  cat "$f" 2>/dev/null
  echo ""
done

exit 0
