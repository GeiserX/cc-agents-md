# cc-agents-md: Loads AGENTS.md files for Claude Code SessionStart hook.
# PowerShell equivalent of loader.sh for Windows systems.
# Walks from $env:CLAUDE_PROJECT_DIR up to git root, outputs root-first.
# Small files are inlined fully; large files get a read instruction.

$ErrorActionPreference = 'SilentlyContinue'

# Validate inline threshold
$threshold = $env:AGENTS_MD_INLINE_THRESHOLD
if (-not $threshold -or $threshold -notmatch '^\d+$') { $threshold = 200 }
$threshold = [int]$threshold

# Resolve project directory
$project = if ($env:CLAUDE_PROJECT_DIR) { $env:CLAUDE_PROJECT_DIR } else { Get-Location }
$project = (Resolve-Path $project -ErrorAction SilentlyContinue).Path
if (-not $project) { exit 0 }

# Find git root or use project dir
$root = $project
try {
  $gitRoot = git -C $project rev-parse --show-toplevel 2>$null
  if ($LASTEXITCODE -eq 0 -and $gitRoot) { $root = $gitRoot.Trim() }
} catch {}

# Walk from project dir up to root, collecting AGENTS.md paths
$files = @()
$dir = $project
while ($true) {
  $candidate = Join-Path $dir 'AGENTS.md'
  if (Test-Path $candidate -PathType Leaf) {
    # Skip symlinks/junctions
    $item = Get-Item $candidate -Force
    if (-not $item.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)) {
      $files += $candidate
    }
  }
  if ($dir -eq $root) { break }
  $parent = Split-Path $dir -Parent
  if (-not $parent -or $parent -eq $dir) { break }
  $dir = $parent
}

if ($files.Count -eq 0) { exit 0 }

# Reverse: root first, deeper last
[Array]::Reverse($files)

# Output: inline small files, read instruction for large ones
foreach ($f in $files) {
  $rel = $f
  $normalRoot = $root.Replace('/', '\')
  $normalF = $f.Replace('/', '\')
  if ($normalF.StartsWith($normalRoot)) {
    $rel = $normalF.Substring($normalRoot.Length).TrimStart('\')
    if (-not $rel) { $rel = 'AGENTS.md' }
  }

  $content = @(Get-Content $f -ErrorAction SilentlyContinue)
  $lines = $content.Count

  if ($lines -le $threshold) {
    Write-Output "# AGENTS.md - $rel"
    Write-Output ""
    Get-Content $f -Raw -ErrorAction SilentlyContinue
    Write-Output ""
  } else {
    Write-Output "# AGENTS.md - $rel ($lines lines)"
    Write-Output "# Read the full file for project instructions: $f"
    Write-Output ""
  }
}

exit 0
