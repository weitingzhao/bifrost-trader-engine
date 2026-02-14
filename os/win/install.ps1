# Install dependencies when pip/python are not on PATH (Windows).
# Run from project root: .\os\win\install.ps1

$ErrorActionPreference = "Stop"
$projectRoot = (Split-Path (Split-Path $PSScriptRoot -Parent) -Parent)
Set-Location $projectRoot

$pipArgs = "install", "-r", "requirements.txt"

# Try py -m pip (Windows launcher)
try {
    $null = Get-Command py -ErrorAction Stop
    Write-Host "Using: py -m pip install -r requirements.txt"
    py -m pip @pipArgs
    exit 0
} catch {
    # continue
}

# Try python -m pip
try {
    $null = Get-Command python -ErrorAction Stop
    Write-Host "Using: python -m pip install -r requirements.txt"
    python -m pip @pipArgs
    exit 0
} catch {
    # continue
}

# Try python3
try {
    $null = Get-Command python3 -ErrorAction Stop
    Write-Host "Using: python3 -m pip install -r requirements.txt"
    python3 -m pip @pipArgs
    exit 0
} catch {
    # continue
}

# Common Windows Python locations
$paths = @(
    "$env:LOCALAPPDATA\Programs\Python\Python*\python.exe",
    "$env:APPDATA\Local\Programs\Python\Python*\python.exe",
    "${env:ProgramFiles}\Python*\python.exe"
)
foreach ($pattern in $paths) {
    $found = Get-Item $pattern -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($found) {
        $pip = Join-Path (Split-Path $found.FullName) "Scripts\pip.exe"
        if (Test-Path $pip) {
            Write-Host "Using: $pip install -r requirements.txt"
            & $pip @pipArgs
            exit 0
        }
        Write-Host "Using: $($found.FullName) -m pip install -r requirements.txt"
        & $found.FullName -m pip @pipArgs
        exit 0
    }
}

Write-Host "Could not find Python or pip. Install Python from https://www.python.org/downloads/ and check 'Add Python to PATH'." -ForegroundColor Red
exit 1
