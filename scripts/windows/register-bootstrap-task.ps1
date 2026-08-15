[CmdletBinding(SupportsShouldProcess)]
param(
    [ValidateNotNullOrEmpty()]
    [string]$TaskName = 'Luvira Memory Bootstrap',

    [string]$McpPath = '',

    [switch]$Unregister
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$DefaultMcpDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$McpDirectory = if ([string]::IsNullOrWhiteSpace($McpPath)) {
    $DefaultMcpDirectory
}
else {
    [IO.Path]::GetFullPath($McpPath)
}
$BootstrapPath = Join-Path $McpDirectory 'scripts\windows\bootstrap.ps1'
$PowerShellExecutable = 'powershell.exe'
$ActionArguments = "-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$BootstrapPath`""
$TaskDescription = 'Starts the local Luvira Memory stack after user logon and exits when all services are ready.'
$CurrentUser = [Security.Principal.WindowsIdentity]::GetCurrent().Name

function Resolve-UserIdentity {
    param(
        [Parameter(Mandatory)]
        [string]$UserId
    )

    try {
        return ([Security.Principal.NTAccount]::new($UserId)).Translate(
            [Security.Principal.SecurityIdentifier]
        ).Value
    }
    catch {
        return $UserId.ToLowerInvariant()
    }
}

function Get-TaskFingerprint {
    param(
        [Parameter(Mandatory)]
        [object]$Task
    )

    $action = @($Task.Actions)[0]
    $trigger = @($Task.Triggers)[0]
    return [ordered]@{
        description = [string]$Task.Description
        action_execute = [string]$action.Execute
        action_arguments = [string]$action.Arguments
        action_working_directory = [string]$action.WorkingDirectory
        trigger_type = [string]$trigger.CimClass.CimClassName
        trigger_user = Resolve-UserIdentity -UserId ([string]$trigger.UserId)
        principal_user = Resolve-UserIdentity -UserId ([string]$Task.Principal.UserId)
        principal_logon_type = [string]$Task.Principal.LogonType
        principal_run_level = [string]$Task.Principal.RunLevel
        multiple_instances = [string]$Task.Settings.MultipleInstances
        hidden = [bool]$Task.Settings.Hidden
        start_when_available = [bool]$Task.Settings.StartWhenAvailable
        disallow_on_battery = [bool]$Task.Settings.DisallowStartIfOnBatteries
        stop_on_battery = [bool]$Task.Settings.StopIfGoingOnBatteries
        execution_time_limit = [string]$Task.Settings.ExecutionTimeLimit
    }
}

function Test-TaskMatches {
    param(
        [Parameter(Mandatory)]
        [object]$Current,

        [Parameter(Mandatory)]
        [object]$Intended
    )

    $currentFingerprint = Get-TaskFingerprint -Task $Current
    $intendedFingerprint = Get-TaskFingerprint -Task $Intended
    return ($currentFingerprint | ConvertTo-Json -Compress) -eq ($intendedFingerprint | ConvertTo-Json -Compress)
}

$existing = Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue

if ($Unregister) {
    if ($null -eq $existing) {
        Write-Output "Task '$TaskName' is not registered."
        exit 0
    }
    if ($PSCmdlet.ShouldProcess($TaskName, 'Unregister scheduled task')) {
        Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
        Write-Output "Task '$TaskName' was unregistered."
    }
    exit 0
}

if (-not (Test-Path -LiteralPath $BootstrapPath -PathType Leaf)) {
    throw [IO.FileNotFoundException]::new('The bootstrap script was not found.', $BootstrapPath)
}

$action = New-ScheduledTaskAction -Execute $PowerShellExecutable -Argument $ActionArguments -WorkingDirectory $McpDirectory
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $CurrentUser
$principal = New-ScheduledTaskPrincipal -UserId $CurrentUser -LogonType Interactive -RunLevel Limited
$settings = New-ScheduledTaskSettingsSet `
    -MultipleInstances IgnoreNew `
    -ExecutionTimeLimit (New-TimeSpan -Minutes 15) `
    -StartWhenAvailable `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -Hidden
$intended = New-ScheduledTask `
    -Action $action `
    -Trigger $trigger `
    -Principal $principal `
    -Settings $settings `
    -Description $TaskDescription

if ($null -ne $existing -and (Test-TaskMatches -Current $existing -Intended $intended)) {
    Write-Output "Task '$TaskName' already has the intended configuration."
    exit 0
}

$operation = if ($null -eq $existing) { 'Register scheduled task' } else { 'Update scheduled task' }
if ($PSCmdlet.ShouldProcess($TaskName, $operation)) {
    Register-ScheduledTask -TaskName $TaskName -InputObject $intended -Force | Out-Null
    Write-Output "Task '$TaskName' was registered for user '$CurrentUser'."
}

exit 0
