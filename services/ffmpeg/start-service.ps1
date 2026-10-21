<#
.SYNOPSIS
  Starts the Node.js FFmpeg Rendering Server and ngrok tunnel on Windows,
  preventing system sleep while running.
#>

$ErrorActionPreference = "Stop"
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
Set-Location $ScriptDir

# Prevent Windows 11 ThinkPad from going into sleep mode while script runs
Write-Host "Configuring Windows execution state to prevent sleep..." -ForegroundColor Cyan
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public class SleepUtil {
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
    public const uint ES_CONTINUOUS = 0x80000000;
    public const uint ES_SYSTEM_REQUIRED = 0x00000001;
    public const uint ES_AWAYMODE_REQUIRED = 0x00000040;
}
"@
[SleepUtil]::SetThreadExecutionState([SleepUtil]::ES_CONTINUOUS -bor [SleepUtil]::ES_SYSTEM_REQUIRED -bor [SleepUtil]::ES_AWAYMODE_REQUIRED) | Out-Null

Write-Host "==========================================================" -ForegroundColor Green
Write-Host "   Local FFmpeg Rendering Server for AWS n8n              " -ForegroundColor Green
Write-Host "==========================================================" -ForegroundColor Green

# 1. Start or verify Node.js server
$serverProc = Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object {
    try {
        $cmd = (Get-CimInstance Win32_Process -Filter "ProcessId = $($_.Id)").CommandLine
        $cmd -match "server\.js"
    } catch { $false }
}

if (-not $serverProc) {
    Write-Host "Starting Node.js rendering server on port 8787..." -ForegroundColor Yellow
    $serverProc = Start-Process -FilePath "node" -ArgumentList "server.js" -WorkingDirectory $ScriptDir -PassThru
    Start-Sleep -Seconds 2
} else {
    Write-Host "Node.js rendering server is already running (PID: $($serverProc.Id))." -ForegroundColor Cyan
}

# 2. Check / Start ngrok tunnel
$ngrokProc = Get-Process -Name ngrok -ErrorAction SilentlyContinue
if (-not $ngrokProc) {
    Write-Host "Starting ngrok tunnel for port 8787..." -ForegroundColor Yellow
    Start-Process -FilePath "ngrok" -ArgumentList "http 8787" -PassThru | Out-Null
    Start-Sleep -Seconds 3
} else {
    Write-Host "ngrok process is already running." -ForegroundColor Cyan
}

# 3. Retrieve public ngrok URL
$publicUrl = ""
try {
    $tunnels = (Invoke-RestMethod http://127.0.0.1:4040/api/tunnels).tunnels
    $rendererTunnel = $tunnels | Where-Object { $_.config.addr -match "8787" }
    if (-not $rendererTunnel -and $tunnels.Count -gt 0) {
        $rendererTunnel = $tunnels[0]
    }
    if ($rendererTunnel) {
        $publicUrl = $rendererTunnel.public_url
    }
} catch {
    Write-Warning "Could not connect to ngrok web inspection API at http://127.0.0.1:4040"
}

# Read API Key
$apiKey = ""
if (Test-Path ".env") {
    $envContent = Get-Content ".env"
    foreach ($line in $envContent) {
        if ($line -match "^RENDER_API_KEY=(.+)$") {
            $apiKey = $matches[1].Trim()
        }
    }
}

Write-Host "`nServer Status:" -ForegroundColor Green
Write-Host "  Local Port    : 8787"
Write-Host "  Health URL    : http://127.0.0.1:8787/health"
if ($publicUrl) {
    Write-Host "  Public ngrok  : $publicUrl" -ForegroundColor Green
    Write-Host "  Public Health : $publicUrl/health" -ForegroundColor Green
}
Write-Host "  Bearer API Key: $apiKey" -ForegroundColor Yellow
Write-Host "`nKeep this window open while rendering workflows run." -ForegroundColor White
Write-Host "Press Ctrl+C to stop." -ForegroundColor Gray

while ($true) {
    Start-Sleep -Seconds 60
}
