# Runs the dashboard on THIS PC (instead of the VPS). It reaches out to the
# VPS over SSH to run commands, exactly like before local mode existed — no
# Node process runs on the VPS at all, so the game server keeps all the CPU.
# Keep this window open while you use the dashboard; close it to stop.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$cfg = Get-Content (Join-Path $root 'config.json') -Raw | ConvertFrom-Json
$guiPort = if ($cfg.guiPort) { $cfg.guiPort } else { 4173 }

Set-Location $root

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  throw "Node.js isn't installed on this PC. Install it from https://nodejs.org (LTS), then run this again."
}

if (-not (Test-Path (Join-Path $root 'node_modules'))) {
  Write-Host "Installing dependencies (first run only)..." -ForegroundColor Cyan
  & npm install
  if ($LASTEXITCODE -ne 0) { throw "npm install failed" }
}

Write-Host ""
Write-Host "Starting the dashboard locally -> http://localhost:$guiPort" -ForegroundColor Cyan
Write-Host "Keep this window open while you use it. Close it to stop." -ForegroundColor DarkGray
Write-Host ""

Start-Job -ScriptBlock {
  param($p)
  for ($i = 0; $i -lt 60; $i++) {
    Start-Sleep -Seconds 1
    try { $c = New-Object Net.Sockets.TcpClient('127.0.0.1', $p); $c.Close(); Start-Process "http://localhost:$p"; break } catch {}
  }
} -ArgumentList $guiPort | Out-Null

& node server.js
