#!/usr/bin/env bash
# cc-agents-md benchmark — Measure hook latency across file counts and sizes.
# Usage: ./bench/benchmark.sh [iterations]
#
# Creates temp repos with varying AGENTS.md configurations and times the loader.

set -euo pipefail

ITERATIONS="${1:-20}"
LOADER="$(cd "$(dirname "$0")/.." && pwd)/bin/loader.sh"

if [ ! -f "$LOADER" ]; then
  echo "Error: loader.sh not found at $LOADER"
  exit 1
fi

# Portable high-res timer (milliseconds)
now_ms() {
  if command -v gdate >/dev/null 2>&1; then
    echo $(($(gdate +%s%N) / 1000000))
  else
    local ts
    ts="$(date +%s%N 2>/dev/null)"
    if [[ "$ts" =~ ^[0-9]+$ ]]; then
      echo $((ts / 1000000))
    else
      # macOS fallback: python3 milliseconds
      python3 -c 'import time; print(int(time.time()*1000))'
    fi
  fi
}

# Run loader N times and compute stats
bench() {
  local label="$1"
  local dir="$2"
  local times=()

  # Warm up (1 run, discard)
  CLAUDE_PROJECT_DIR="$dir" bash "$LOADER" >/dev/null 2>&1 || true

  for (( i=0; i<ITERATIONS; i++ )); do
    local start end elapsed
    start=$(now_ms)
    CLAUDE_PROJECT_DIR="$dir" bash "$LOADER" >/dev/null 2>&1 || true
    end=$(now_ms)
    elapsed=$((end - start))
    times+=("$elapsed")
  done

  # Compute min, max, avg
  local sum=0 min=999999 max=0
  for t in "${times[@]}"; do
    sum=$((sum + t))
    (( t < min )) && min=$t
    (( t > max )) && max=$t
  done
  local avg=$((sum / ITERATIONS))

  printf "  %-40s avg=%4dms  min=%4dms  max=%4dms\n" "$label" "$avg" "$min" "$max"
}

echo "cc-agents-md benchmark ($ITERATIONS iterations per scenario)"
echo "Loader: $LOADER"
echo ""

# --- Scenario 1: No AGENTS.md ---
tmpdir=$(mktemp -d)
git -C "$tmpdir" init -q
echo "Scenarios:"
bench "No AGENTS.md (baseline)" "$tmpdir"
rm -rf "$tmpdir"

# --- Scenario 2: Single small file (10 lines) ---
tmpdir=$(mktemp -d)
git -C "$tmpdir" init -q
printf '%s\n' $(seq 1 10) > "$tmpdir/AGENTS.md"
bench "1 file, 10 lines" "$tmpdir"
rm -rf "$tmpdir"

# --- Scenario 3: Single medium file (200 lines) ---
tmpdir=$(mktemp -d)
git -C "$tmpdir" init -q
for i in $(seq 1 200); do echo "Line $i of the AGENTS.md file with some content"; done > "$tmpdir/AGENTS.md"
bench "1 file, 200 lines (threshold)" "$tmpdir"
rm -rf "$tmpdir"

# --- Scenario 4: Single large file (1000 lines, read instruction) ---
tmpdir=$(mktemp -d)
git -C "$tmpdir" init -q
for i in $(seq 1 1000); do echo "Line $i of a very large AGENTS.md specification document"; done > "$tmpdir/AGENTS.md"
bench "1 file, 1000 lines (read instr)" "$tmpdir"
rm -rf "$tmpdir"

# --- Scenario 5: 3 nested files (monorepo) ---
tmpdir=$(mktemp -d)
git -C "$tmpdir" init -q
echo "# Root guidelines" > "$tmpdir/AGENTS.md"
mkdir -p "$tmpdir/packages/frontend"
for i in $(seq 1 50); do echo "Frontend rule $i"; done > "$tmpdir/packages/frontend/AGENTS.md"
mkdir -p "$tmpdir/packages/frontend/src/components"
for i in $(seq 1 30); do echo "Component rule $i"; done > "$tmpdir/packages/frontend/src/components/AGENTS.md"
bench "3 nested files (monorepo)" "$tmpdir/packages/frontend/src/components"
rm -rf "$tmpdir"

# --- Scenario 6: Cached (second run, same files) ---
tmpdir=$(mktemp -d)
git -C "$tmpdir" init -q
for i in $(seq 1 100); do echo "Line $i"; done > "$tmpdir/AGENTS.md"
# Prime the cache
CLAUDE_PROJECT_DIR="$tmpdir" bash "$LOADER" >/dev/null 2>&1 || true
bench "1 file, 100 lines (cached)" "$tmpdir"
rm -rf "$tmpdir"

echo ""
echo "Done."
