param(
  [ValidateSet('dashboard', 'scheduler', 'refresh', 'live-oi', 'logs', 'status', 'down')]
  [string]$Action = 'dashboard'
)

$ErrorActionPreference = 'Stop'
$dashboardPort = if ($env:DASHBOARD_PORT) { $env:DASHBOARD_PORT } else { '8080' }

switch ($Action) {
  'dashboard' {
    docker compose up -d --build dashboard scheduler
    Write-Host "Dashboard: http://localhost:$dashboardPort"
  }
  'scheduler' {
    docker compose up -d --build scheduler dashboard
    Write-Host "Scheduler started. Dashboard: http://localhost:$dashboardPort"
  }
  'refresh' {
    docker compose up -d --build dashboard scheduler
    docker compose --profile collector run --rm -e RUN_LIVE_OI=false collector
    Write-Host "Price/data refresh completed. Dashboard: http://localhost:$dashboardPort"
  }
  'live-oi' {
    docker compose up -d --build dashboard scheduler
    docker compose --profile collector run --rm -e RUN_LIVE_OI=true collector
    Write-Host "Live OI collection completed. Dashboard: http://localhost:$dashboardPort"
  }
  'logs' {
    docker compose logs -f dashboard
  }
  'status' {
    docker compose ps
    Invoke-WebRequest -UseBasicParsing "http://localhost:$dashboardPort/healthz" | Select-Object StatusCode, Content
    if (Test-Path 'runtime/scheduler/heartbeat.json') {
      Write-Host 'Scheduler heartbeat:'
      Get-Content 'runtime/scheduler/heartbeat.json'
    }
  }
  'down' {
    docker compose down
  }
}
