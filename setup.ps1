# Standalone runtime installer for Audiobook Studio (Windows).
# Downloads the pinned, checksummed audio.cpp Vulkan runtime + OmniVoice model
# from versions.json into runtime\ — the studio then manages the TTS server
# itself as a child process. No CUDA/ROCm/PyTorch; Vulkan comes with the GPU driver.
#
#   powershell -ExecutionPolicy Bypass -File setup.ps1              # full install
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -SkipModel   # runtime only
#   powershell -ExecutionPolicy Bypass -File setup.ps1 -Force       # re-download
#
# Windows PowerShell 5.1+. Linux: setup.sh. Needs ~4 GB free disk.

#Requires -Version 5.1
[CmdletBinding()]
param(
    [switch]$SkipModel,
    [switch]$Force
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
    [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12
} catch { }

$root = $PSScriptRoot
if (-not $root) { $root = (Get-Location).Path }
$versions = Get-Content -Path (Join-Path $root 'versions.json') -Raw | ConvertFrom-Json
$cacheDir = Join-Path $root 'runtime\downloads'
New-Item -ItemType Directory -Force -Path $cacheDir | Out-Null

function Get-Sha256([string]$Path) {
    (Get-FileHash -Path $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Get-CachedArtifact($spec, [string]$label) {
    $dest = Join-Path $cacheDir $spec.filename
    if (-not $Force -and (Test-Path $dest)) {
        if ((Get-Sha256 $dest) -eq $spec.sha256) {
            Write-Host "[ok] $label already cached (checksum matches)"
            return $dest
        }
        Write-Host "[..] cached copy failed checksum, re-downloading"
    } else {
        Write-Host "[..] downloading $label"
    }
    $curl = Get-Command curl.exe -ErrorAction SilentlyContinue
    if ($curl) {
        & $curl.Source -sSL --fail -o $dest $spec.url
        if ($LASTEXITCODE -ne 0) { throw "Download failed: $($spec.url)" }
    } else {
        Invoke-WebRequest -Uri $spec.url -OutFile $dest -UseBasicParsing
    }
    $actual = Get-Sha256 $dest
    if ($actual -ne $spec.sha256) {
        throw ("Checksum mismatch for {0}:`n  expected: {1}`n  actual:   {2}" -f $label, $spec.sha256, $actual)
    }
    Write-Host "[ok] $label downloaded (checksum matches)"
    $dest
}

Write-Host "=== Audiobook Studio - TTS runtime setup ==="

# --- 1. audio.cpp Vulkan runtime ---
$asset = $versions.audio_cpp.assets.'windows-x64'
$runtime = Get-CachedArtifact $asset "audio.cpp runtime"
$stampPath = Join-Path $root 'runtime\.setup-stamp.json'
$stampOk = $false
if (-not $Force -and (Test-Path $stampPath)) {
    try {
        $stamp = Get-Content -Path $stampPath -Raw | ConvertFrom-Json
        $stampOk = ($stamp.runtime_sha256 -eq $asset.sha256)
    } catch { $stampOk = $false }
}
if ($stampOk) {
    Write-Host "[ok] runtime already installed"
} else {
    Write-Host "[..] extracting runtime -> runtime\bin\"
    $tmp = Join-Path $cacheDir 'extract-runtime'
    if (Test-Path $tmp) { Remove-Item -Recurse -Force $tmp }
    Expand-Archive -Path $runtime -DestinationPath $tmp -Force
    New-Item -ItemType Directory -Force -Path (Join-Path $root 'runtime\bin') | Out-Null
    Copy-Item -Path (Join-Path $tmp '*') -Destination (Join-Path $root 'runtime\bin') -Recurse -Force
    Remove-Item -Recurse -Force $tmp
    @{
        runtime_sha256 = $asset.sha256
        installed_at   = (Get-Date).ToUniversalTime().ToString('o')
    } | ConvertTo-Json | Set-Content -Path $stampPath -Encoding UTF8
    Write-Host "[ok] runtime installed"
}

# --- 2. OmniVoice GGUF model ---
if (-not $SkipModel) {
    $modelSpec = $versions.omnivoice_gguf.precision.'q8_0'
    $modelDir = Join-Path $root ("runtime\models\" + $versions.omnivoice_gguf.dir)
    New-Item -ItemType Directory -Force -Path $modelDir | Out-Null
    $modelDest = Join-Path $modelDir $modelSpec.filename
    $modelOk = $false
    if (-not $Force -and (Test-Path $modelDest)) {
        if ((Get-Sha256 $modelDest) -eq $modelSpec.sha256) {
            Write-Host "[ok] model already installed (checksum matches)"
            $modelOk = $true
        } else {
            Write-Host "[..] installed model failed checksum, re-downloading"
        }
    }
    if (-not $modelOk) {
        $modelCache = Get-CachedArtifact $modelSpec "OmniVoice q8_0 model"
        Move-Item -Path $modelCache -Destination $modelDest -Force
        if ((Get-Sha256 $modelDest) -ne $modelSpec.sha256) { throw 'Model install failed final checksum' }
        Write-Host "[ok] model installed -> $modelDest"
    }

    # --- 3. ASR model (auto-transcript for voice preparation) ---
    $asrSpec = $versions.asr_gguf.'q8_0'
    $asrDir = Join-Path $root ("runtime\models\" + $versions.asr_gguf.dir)
    New-Item -ItemType Directory -Force -Path $asrDir | Out-Null
    $asrDest = Join-Path $asrDir $asrSpec.filename
    $asrOk = $false
    if (-not $Force -and (Test-Path $asrDest)) {
        if ((Get-Sha256 $asrDest) -eq $asrSpec.sha256) {
            Write-Host "[ok] ASR model already installed (checksum matches)"
            $asrOk = $true
        } else {
            Write-Host "[..] installed ASR model failed checksum, re-downloading"
        }
    }
    if (-not $asrOk) {
        $asrCache = Get-CachedArtifact $asrSpec "CrisperWhisper ASR model"
        Move-Item -Path $asrCache -Destination $asrDest -Force
        if ((Get-Sha256 $asrDest) -ne $asrSpec.sha256) { throw 'ASR model install failed final checksum' }
        Write-Host "[ok] ASR model installed -> $asrDest"
    }

    # --- 4. Forced aligner (word-level transcript verification for cloning) ---
    $alignSpec = $versions.aligner_gguf.f16
    $alignDir = Join-Path $root ("runtime\models\" + $versions.aligner_gguf.dir)
    New-Item -ItemType Directory -Force -Path $alignDir | Out-Null
    $alignDest = Join-Path $alignDir $alignSpec.filename
    $alignOk = $false
    if (-not $Force -and (Test-Path $alignDest)) {
        if ((Get-Sha256 $alignDest) -eq $alignSpec.sha256) {
            Write-Host "[ok] forced aligner already installed (checksum matches)"
            $alignOk = $true
        } else {
            Write-Host "[..] installed forced aligner failed checksum, re-downloading"
        }
    }
    if (-not $alignOk) {
        $alignCache = Get-CachedArtifact $alignSpec "MMS forced aligner model"
        Move-Item -Path $alignCache -Destination $alignDest -Force
        if ((Get-Sha256 $alignDest) -ne $alignSpec.sha256) { throw 'Forced aligner install failed final checksum' }
        Write-Host "[ok] forced aligner installed -> $alignDest"
    }
}

Write-Host '=== done — the studio will start this runtime automatically ==='
