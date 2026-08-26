$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
    throw "Node.js was not found. Install Node.js 20 LTS or newer first."
}

if (-not (Get-Command npm -ErrorAction SilentlyContinue)) {
    throw "npm was not found. Reinstall Node.js with npm included."
}

$nodeMajor = [int]((& node --version).TrimStart("v").Split(".")[0])
if ($nodeMajor -lt 20) {
    throw "Node.js 20 or newer is required."
}

& npm install --omit=dev
if ($LASTEXITCODE -ne 0) {
    throw "npm install failed."
}

if (-not (Test-Path -LiteralPath ".env")) {
    Copy-Item -LiteralPath ".env.example" -Destination ".env"
    Write-Host "Created .env. Configure it before starting the bridge."
} else {
    Write-Host ".env already exists and was not overwritten."
}

& npm run check
if ($LASTEXITCODE -ne 0) {
    throw "Code validation failed."
}

Write-Host "Installation completed. Configure .env, then run .\start.ps1"

