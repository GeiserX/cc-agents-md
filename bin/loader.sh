#!/usr/bin/env bash
# cc-agents-md: Loads AGENTS.md files for Claude Code hooks.
# Walks from $CLAUDE_PROJECT_DIR up to git root, outputs root-first.
# Small files are inlined fully; large files get a read instruction.
# Supports .agents-md.json config for custom patterns, exclusions, and caching.
#
# AGENTS_MD_HOOK_MODE controls output format:
#   session (default) — plain text (SessionStart hook)
#   prompt            — JSON with change detection (UserPromptSubmit hook)
#   compact           — JSON, always re-inject (PreCompact hook)
#
# All errors silenced — never block a session.

HOOK_MODE="${AGENTS_MD_HOOK_MODE:-session}"

PROJECT="${CLAUDE_PROJECT_DIR:-.}"

# Resolve to absolute physical path (resolves symlinks — critical for git root comparison)
PROJECT="$(cd "$PROJECT" 2>/dev/null && pwd -P)" || exit 0

# Find git root or use project dir
ROOT="$(git -C "$PROJECT" rev-parse --show-toplevel 2>/dev/null)" || ROOT="$PROJECT"

# --- Load .agents-md.json config via Node (if available) ---
# Node is optional — the loader runs with zero hard dependencies.
# If node is not installed, the loader falls back to defaults and env vars.
INLINE_THRESHOLD="${AGENTS_MD_INLINE_THRESHOLD:-200}"
PATTERNS="${AGENTS_MD_PATTERNS:-AGENTS.md}"
EXCLUDE="${AGENTS_MD_EXCLUDE:-}"
CACHE_ENABLED="${AGENTS_MD_CACHE:-1}"

if [ -f "$ROOT/.agents-md.json" ] && command -v node >/dev/null 2>&1; then
  _cfg="$(node -e "
    try {
      const c = require('$ROOT/.agents-md.json');
      if (c.threshold) process.stdout.write('T=' + c.threshold + '\n');
      if (Array.isArray(c.patterns) && c.patterns.length) process.stdout.write('P=' + c.patterns.join(',') + '\n');
      if (Array.isArray(c.exclude) && c.exclude.length) process.stdout.write('E=' + c.exclude.join(',') + '\n');
      if (c.cache === false) process.stdout.write('C=0\n');
    } catch {}
  " 2>/dev/null)"
  while IFS='=' read -r key val; do
    case "$key" in
      T) INLINE_THRESHOLD="$val" ;;
      P) PATTERNS="$val" ;;
      E) EXCLUDE="$val" ;;
      C) CACHE_ENABLED="$val" ;;
    esac
  done <<< "$_cfg"
fi

# Validate threshold as positive integer
case "$INLINE_THRESHOLD" in
  ''|*[!0-9]*) INLINE_THRESHOLD=200 ;;
esac

# Split patterns and exclude into arrays
IFS=',' read -ra pattern_arr <<< "$PATTERNS"
IFS=',' read -ra exclude_arr <<< "$EXCLUDE"

# --- Collect matching files ---
files=()
dir="$PROJECT"
while :; do
  # Check if this directory is excluded
  dirname_base="$(basename "$dir")"
  excluded=0
  for ex in "${exclude_arr[@]}"; do
    [ -n "$ex" ] && [ "$dirname_base" = "$ex" ] && excluded=1 && break
  done

  if [ "$excluded" -eq 0 ]; then
    for pat in "${pattern_arr[@]}"; do
      candidate="$dir/$pat"
      # Skip symlinks to prevent reading files outside the repository
      if [ -f "$candidate" ] && [ ! -L "$candidate" ]; then
        files+=("$candidate")
      fi
    done
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

# --- Caching: skip re-assembly if files unchanged ---
CACHE_DIR="$HOME/.claude/cc-agents-md-cache"

if [ "$CACHE_ENABLED" = "1" ]; then
  # Build cache key from file paths + mtimes + config
  cache_input="t=${INLINE_THRESHOLD}:p=${PATTERNS}:e=${EXCLUDE}:"
  for f in "${reversed[@]}"; do
    # macOS stat -f %m, Linux stat -c %Y
    mtime="$(stat -f %m "$f" 2>/dev/null || stat -c %Y "$f" 2>/dev/null)"
    cache_input="${cache_input}${f}:${mtime}:"
  done

  # Hash the cache key
  if command -v shasum >/dev/null 2>&1; then
    cache_hash="$(printf '%s' "$cache_input" | shasum -a 256 | cut -d' ' -f1)"
  elif command -v sha256sum >/dev/null 2>&1; then
    cache_hash="$(printf '%s' "$cache_input" | sha256sum | cut -d' ' -f1)"
  else
    cache_hash=""
  fi

  if [ -n "$cache_hash" ]; then
    cache_file="$CACHE_DIR/${cache_hash}"

    # For prompt mode: check if files changed since last injection
    if [ "$HOOK_MODE" = "prompt" ]; then
      last_injected_file="$CACHE_DIR/.last-injected"
      if [ -f "$last_injected_file" ]; then
        last_hash="$(cat "$last_injected_file" 2>/dev/null)"
        if [ "$last_hash" = "$cache_hash" ]; then
          # Files unchanged since last injection — output nothing
          exit 0
        fi
      fi
    fi

    if [ -f "$cache_file" ] && [ "$HOOK_MODE" = "session" ]; then
      cat "$cache_file"
      exit 0
    fi
  fi
fi

# --- Assemble output ---
output=""
for f in "${reversed[@]}"; do
  prefix="$ROOT/"
  rel="${f#$prefix}"
  [ "$rel" = "$f" ] && rel="$(basename "$f")"

  # Count actual lines (awk counts lines, not newlines — handles missing trailing newline)
  lines=$(awk 'END{print NR}' "$f" 2>/dev/null || echo 0)

  if [ "$lines" -le "$INLINE_THRESHOLD" ]; then
    output+="# AGENTS.md — ${rel}
"
    output+="
"
    output+="$(cat "$f" 2>/dev/null)
"
    output+="
"
  else
    output+="# AGENTS.md — ${rel} (${lines} lines)
"
    output+="# Read the full file for project instructions: ${f}
"
    output+="
"
  fi
done

# --- Output based on hook mode ---
if [ "$HOOK_MODE" = "prompt" ] || [ "$HOOK_MODE" = "compact" ]; then
  # JSON output for UserPromptSubmit / PreCompact hooks
  # Use node for reliable JSON escaping (node is available — cc-agents-md requires Node 18+)
  if command -v node >/dev/null 2>&1; then
    json_output="$(node -e "process.stdout.write(JSON.stringify({additionalContext: process.argv[1]}))" -- "$output")"
  elif command -v python3 >/dev/null 2>&1; then
    # Fallback: use python3 for JSON escaping
    json_output="$(printf '%s' "$output" | python3 -c "import sys,json; print(json.dumps({'additionalContext': sys.stdin.read()}),end='')" 2>/dev/null)"
  else
    # Last resort: output nothing rather than malformed JSON
    exit 0
  fi
  printf '%s' "$json_output"

  # Update last-injected marker for prompt mode change detection
  if [ "$HOOK_MODE" = "prompt" ] && [ -n "${cache_hash:-}" ]; then
    mkdir -p "$CACHE_DIR" 2>/dev/null
    printf '%s' "$cache_hash" > "$CACHE_DIR/.last-injected" 2>/dev/null
  fi
else
  # Plain text output for SessionStart hook
  printf '%s' "$output"
fi

# --- Write cache ---
if [ "$CACHE_ENABLED" = "1" ] && [ -n "${cache_hash:-}" ]; then
  mkdir -p "$CACHE_DIR" 2>/dev/null
  printf '%s' "$output" > "$cache_file" 2>/dev/null

  # Prune old cache files (keep newest 20, skip dotfiles like .last-injected)
  if [ -d "$CACHE_DIR" ]; then
    # shellcheck disable=SC2012
    ls -1t "$CACHE_DIR" 2>/dev/null | grep -v '^\.' | tail -n +21 | while read -r old; do
      rm -f "$CACHE_DIR/$old" 2>/dev/null
    done
  fi
fi

exit 0
