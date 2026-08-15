# Windows automatic startup

The Windows bootstrap waits for Docker Desktop's engine, starts Mem0, Luvira
Memory MCP, and the core LibreChat services in order, verifies readiness, writes
an operational log, and exits. Docker restart policies handle service recovery
after bootstrap completion.

Docker Desktop must be configured to start when the user logs on. The scheduled
task does not launch or continuously monitor Docker Desktop.

## Register

Run from a normal, non-administrator PowerShell session:

```powershell
Set-Location <Documents>\luvira-memory-mcp
.\scripts\windows\register-bootstrap-task.ps1
```

The idempotent registration creates `Luvira Memory Bootstrap` for the current
user. Re-running the command is a no-op when the task already has the intended
configuration and safely updates it when the managed settings differ.

Preview registration without changing Task Scheduler:

```powershell
.\scripts\windows\register-bootstrap-task.ps1 -WhatIf
```

## Inspect and run

```powershell
Get-ScheduledTask -TaskName 'Luvira Memory Bootstrap'
Get-ScheduledTaskInfo -TaskName 'Luvira Memory Bootstrap'
Start-ScheduledTask -TaskName 'Luvira Memory Bootstrap'
```

Run bootstrap directly for troubleshooting:

```powershell
powershell.exe -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File "<Documents>\luvira-memory-mcp\scripts\windows\bootstrap.ps1"
```

Replace `<Documents>` with the current user's Documents path. Both scripts
derive the standard sibling repository layout from their own location. For a
non-standard layout, run `bootstrap.ps1` with `-McpPath`, `-Mem0Path`, and/or
`-LibreChatPath` overrides.

Review the current and previous logs:

```powershell
Get-Content .\logs\bootstrap.log -Tail 50
Get-Content .\logs\bootstrap.previous.log -Tail 50
```

## Disable or remove

Temporarily disable or re-enable the task:

```powershell
Disable-ScheduledTask -TaskName 'Luvira Memory Bootstrap'
Enable-ScheduledTask -TaskName 'Luvira Memory Bootstrap'
```

Remove the task through the registration script:

```powershell
.\scripts\windows\register-bootstrap-task.ps1 -Unregister
```

Removing the scheduled task does not stop or remove any running container,
volume, database, or Memory data.
