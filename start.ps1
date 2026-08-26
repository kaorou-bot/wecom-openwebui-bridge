$ErrorActionPreference = "Stop"
Set-Location -LiteralPath $PSScriptRoot

if (-not (Test-Path -LiteralPath ".env")) {
    throw ".env is missing. Run .\install.ps1 and configure .env first."
}

& node "index.js"
if ($LASTEXITCODE -ne 0) {
    throw "Bridge exited with code $LASTEXITCODE"
}

