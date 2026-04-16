# cc-agents-md: Loads AGENTS.md files for Claude Code SessionStart hook.
# PowerShell equivalent of loader.sh for Windows systems.
# Walks from $env:CLAUDE_PROJECT_DIR up to git root, outputs root-first.
# Supports .agents-md.json config for custom patterns, exclusions, and caching.
# Small files are inlined fully; large files get a read instruction.

$ErrorActionPreference = 'SilentlyContinue'

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

# --- Load .agents-md.json config ---
$threshold = if ($env:AGENTS_MD_INLINE_THRESHOLD -and $env:AGENTS_MD_INLINE_THRESHOLD -match '^\d+$') {
  [int]$env:AGENTS_MD_INLINE_THRESHOLD
} else { 200 }
$patterns = @('AGENTS.md')
$excludeDirs = @()
$cacheEnabled = $true

$configPath = Join-Path $root '.agents-md.json'
if (Test-Path $configPath -PathType Leaf) {
  try {
    $cfg = Get-Content $configPath -Raw | ConvertFrom-Json
    if ($cfg.threshold -and $cfg.threshold -gt 0) { $threshold = [int]$cfg.threshold }
    if ($cfg.patterns -and $cfg.patterns.Count -gt 0) { $patterns = @($cfg.patterns) }
    if ($cfg.exclude) { $excludeDirs = @($cfg.exclude) }
    if ($cfg.cache -eq $false) { $cacheEnabled = $false }
  } catch {}
}

if ($env:AGENTS_MD_PATTERNS) { $patterns = $env:AGENTS_MD_PATTERNS -split ',' }
if ($env:AGENTS_MD_EXCLUDE) { $excludeDirs = $env:AGENTS_MD_EXCLUDE -split ',' }
if ($env:AGENTS_MD_CACHE -eq '0') { $cacheEnabled = $false }

# --- Collect matching files ---
$files = @()
$dir = $project
$normalRoot = $root.Replace('/', '\')
while ($true) {
  $dirBase = Split-Path $dir -Leaf
  $excluded = $false
  foreach ($ex in $excludeDirs) {
    if ($ex -and $dirBase -eq $ex) { $excluded = $true; break }
  }

  if (-not $excluded) {
    foreach ($pat in $patterns) {
      $candidate = Join-Path $dir $pat
      if (Test-Path $candidate -PathType Leaf) {
        $item = Get-Item $candidate -Force
        if (-not $item.Attributes.HasFlag([System.IO.FileAttributes]::ReparsePoint)) {
          $files += $candidate
        }
      }
    }
  }

  $normalDir = $dir.Replace('/', '\')
  if ($normalDir -eq $normalRoot) { break }
  $parent = Split-Path $dir -Parent
  if (-not $parent -or $parent -eq $dir) { break }
  $dir = $parent
}

if ($files.Count -eq 0) { exit 0 }

# Reverse: root first, deeper last
[Array]::Reverse($files)

# --- Caching ---
$cacheDir = Join-Path $env:USERPROFILE '.claude' 'cc-agents-md-cache'

if ($cacheEnabled) {
  $cacheInput = ''
  foreach ($f in $files) {
    $mtime = (Get-Item $f -Force).LastWriteTimeUtc.Ticks
    $cacheInput += "${f}:${mtime}:"
  }

  $sha = [System.Security.Cryptography.SHA256]::Create()
  $hashBytes = $sha.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($cacheInput))
  $cacheHash = -join ($hashBytes | ForEach-Object { $_.ToString('x2') })
  $sha.Dispose()

  $cacheFile = Join-Path $cacheDir $cacheHash
  if (Test-Path $cacheFile -PathType Leaf) {
    Get-Content $cacheFile -Raw
    exit 0
  }
}

# --- Assemble output ---
$output = ''
foreach ($f in $files) {
  $rel = $f
  $normalF = $f.Replace('/', '\')
  if ($normalF.StartsWith($normalRoot)) {
    $rel = $normalF.Substring($normalRoot.Length).TrimStart('\')
    if (-not $rel) { $rel = $patterns[0] }
  }

  $content = @(Get-Content $f -ErrorAction SilentlyContinue)
  $lines = $content.Count

  if ($lines -le $threshold) {
    $output += "# AGENTS.md — $rel`n`n"
    $output += ($content -join "`n") + "`n`n"
  } else {
    $output += "# AGENTS.md — $rel ($lines lines)`n"
    $output += "# Read the full file for project instructions: $f`n`n"
  }
}

Write-Output $output

# --- Write cache ---
if ($cacheEnabled -and $cacheHash) {
  if (-not (Test-Path $cacheDir)) { New-Item -ItemType Directory -Path $cacheDir -Force | Out-Null }
  Set-Content -Path $cacheFile -Value $output -NoNewline -ErrorAction SilentlyContinue

  # Prune old cache files (keep newest 20)
  $cacheFiles = Get-ChildItem $cacheDir -File -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending |
    Select-Object -Skip 20
  foreach ($old in $cacheFiles) { Remove-Item $old.FullName -Force -ErrorAction SilentlyContinue }
}

exit 0
