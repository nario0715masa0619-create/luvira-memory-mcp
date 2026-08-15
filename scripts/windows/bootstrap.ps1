[CmdletBinding()]
param(
    [string]$McpPath = '',

    [string]$Mem0Path = '',

    [string]$LibreChatPath = '',

    [ValidateRange(1, 3600)]
    [int]$DockerTimeoutSeconds = 180,

    [ValidateRange(1, 3600)]
    [int]$ServiceTimeoutSeconds = 240,

    [ValidateRange(1, 60)]
    [int]$RetryIntervalSeconds = 5,

    [ValidateRange(1, 20)]
    [int]$ComposeAttempts = 3,

    [ValidateRange(1024, 104857600)]
    [long]$LogMaxBytes = 5242880
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Resolve-ProjectPath {
    param(
        [string]$Override,

        [Parameter(Mandatory)]
        [string]$Default
    )

    $candidate = if ([string]::IsNullOrWhiteSpace($Override)) { $Default } else { $Override }
    return [IO.Path]::GetFullPath($candidate)
}

$DefaultMcpDirectory = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$DocumentsDirectory = Split-Path -Parent $DefaultMcpDirectory
$McpDirectory = Resolve-ProjectPath -Override $McpPath -Default $DefaultMcpDirectory
$Mem0Directory = Resolve-ProjectPath -Override $Mem0Path -Default (Join-Path $DocumentsDirectory 'mem0\server')
$LibreChatDirectory = Resolve-ProjectPath -Override $LibreChatPath -Default (Join-Path $DocumentsDirectory 'LibreChat')
$LogDirectory = Join-Path $McpDirectory 'logs'
$LogPath = Join-Path $LogDirectory 'bootstrap.log'
$PreviousLogPath = Join-Path $LogDirectory 'bootstrap.previous.log'
$MutexName = 'Local\LuviraMemoryBootstrap'
$script:CurrentPhase = 'bootstrap'
$script:MutexOwned = $false
$mutex = $null

function Initialize-Log {
    New-Item -ItemType Directory -Path $LogDirectory -Force | Out-Null
    if ((Test-Path -LiteralPath $LogPath) -and (Get-Item -LiteralPath $LogPath).Length -ge $LogMaxBytes) {
        Move-Item -LiteralPath $LogPath -Destination $PreviousLogPath -Force
    }
}

function Write-BootstrapLog {
    param(
        [Parameter(Mandatory)]
        [string]$Phase,

        [Parameter(Mandatory)]
        [string]$Action,

        [Parameter(Mandatory)]
        [ValidateSet('start', 'retry', 'success', 'failure', 'skipped')]
        [string]$Result,

        [int]$Attempt = 0,
        [int]$TimeoutSeconds = 0,
        [string]$Message = ''
    )

    $record = [ordered]@{
        timestamp = [DateTimeOffset]::Now.ToString('o')
        phase = $Phase
        action = $Action
        result = $Result
        attempt = $Attempt
        timeout_seconds = $TimeoutSeconds
        message = $Message
    }
    $line = $record | ConvertTo-Json -Compress
    Add-Content -LiteralPath $LogPath -Value $line -Encoding UTF8
    Write-Output $line
}

function Invoke-NativeWithTimeout {
    param(
        [Parameter(Mandatory)]
        [string]$FilePath,

        [Parameter(Mandatory)]
        [string[]]$Arguments,

        [Parameter(Mandatory)]
        [int]$TimeoutSeconds,

        [string]$WorkingDirectory = $McpDirectory
    )

    $startInfo = [Diagnostics.ProcessStartInfo]::new()
    $startInfo.FileName = $FilePath
    $startInfo.Arguments = $Arguments -join ' '
    $startInfo.WorkingDirectory = $WorkingDirectory
    $startInfo.UseShellExecute = $false
    $startInfo.CreateNoWindow = $true
    $startInfo.RedirectStandardOutput = $true
    $startInfo.RedirectStandardError = $true

    $process = [Diagnostics.Process]::new()
    $process.StartInfo = $startInfo
    try {
        if (-not $process.Start()) {
            return -1
        }
        $process.BeginOutputReadLine()
        $process.BeginErrorReadLine()
        if (-not $process.WaitForExit($TimeoutSeconds * 1000)) {
            $process.Kill()
            $process.WaitForExit()
            return -1
        }
        return $process.ExitCode
    }
    finally {
        $process.Dispose()
    }
}

function Test-DockerEngine {
    try {
        $dockerPath = (Get-Command docker -ErrorAction Stop).Source
        return (Invoke-NativeWithTimeout -FilePath $dockerPath -Arguments @('info') -TimeoutSeconds 10) -eq 0
    }
    catch {
        return $false
    }
}

function Wait-ForCondition {
    param(
        [Parameter(Mandatory)]
        [string]$Phase,

        [Parameter(Mandatory)]
        [string]$Action,

        [Parameter(Mandatory)]
        [int]$TimeoutSeconds,

        [Parameter(Mandatory)]
        [scriptblock]$Condition
    )

    $deadline = [DateTimeOffset]::Now.AddSeconds($TimeoutSeconds)
    $attempt = 0
    Write-BootstrapLog -Phase $Phase -Action $Action -Result start -TimeoutSeconds $TimeoutSeconds

    do {
        $attempt++
        if (& $Condition) {
            Write-BootstrapLog -Phase $Phase -Action $Action -Result success -Attempt $attempt -TimeoutSeconds $TimeoutSeconds
            return
        }

        if ([DateTimeOffset]::Now -ge $deadline) {
            Write-BootstrapLog -Phase $Phase -Action $Action -Result failure -Attempt $attempt -TimeoutSeconds $TimeoutSeconds -Message 'timeout'
            throw [TimeoutException]::new("Timed out during $Phase")
        }

        Write-BootstrapLog -Phase $Phase -Action $Action -Result retry -Attempt $attempt -TimeoutSeconds $TimeoutSeconds
        Start-Sleep -Seconds $RetryIntervalSeconds
    } while ($true)
}

function Invoke-ComposeUp {
    param(
        [Parameter(Mandatory)]
        [string]$Phase,

        [Parameter(Mandatory)]
        [string]$Directory,

        [Parameter(Mandatory)]
        [string[]]$Arguments
    )

    if (-not (Test-Path -LiteralPath $Directory -PathType Container)) {
        throw [IO.DirectoryNotFoundException]::new("Required project directory is missing for $Phase")
    }

    for ($attempt = 1; $attempt -le $ComposeAttempts; $attempt++) {
        Write-BootstrapLog -Phase $Phase -Action 'docker_compose_up' -Result start -Attempt $attempt -TimeoutSeconds $ServiceTimeoutSeconds
        $dockerPath = (Get-Command docker -ErrorAction Stop).Source
        $exitCode = Invoke-NativeWithTimeout -FilePath $dockerPath -Arguments (@('compose') + $Arguments) -TimeoutSeconds $ServiceTimeoutSeconds -WorkingDirectory $Directory

        if ($exitCode -eq 0) {
            Write-BootstrapLog -Phase $Phase -Action 'docker_compose_up' -Result success -Attempt $attempt -TimeoutSeconds $ServiceTimeoutSeconds
            return
        }

        if ($attempt -lt $ComposeAttempts) {
            Write-BootstrapLog -Phase $Phase -Action 'docker_compose_up' -Result retry -Attempt $attempt -TimeoutSeconds $ServiceTimeoutSeconds -Message "exit_code=$exitCode"
            Start-Sleep -Seconds $RetryIntervalSeconds
        }
    }

    Write-BootstrapLog -Phase $Phase -Action 'docker_compose_up' -Result failure -Attempt $ComposeAttempts -TimeoutSeconds $ServiceTimeoutSeconds -Message "exit_code=$exitCode"
    throw [InvalidOperationException]::new("Docker Compose failed during $Phase")
}

function Test-HttpReady {
    param(
        [Parameter(Mandatory)]
        [uri]$Uri,

        [Parameter(Mandatory)]
        [scriptblock]$ValidateBody
    )

    try {
        $response = Invoke-WebRequest -Uri $Uri -UseBasicParsing -TimeoutSec 5
        return $response.StatusCode -eq 200 -and (& $ValidateBody $response.Content)
    }
    catch {
        return $false
    }
}

function Start-LuviraMemoryStack {
    $script:CurrentPhase = 'docker_engine'
    Wait-ForCondition -Phase $script:CurrentPhase -Action 'wait_ready' -TimeoutSeconds $DockerTimeoutSeconds -Condition {
        Test-DockerEngine
    }

    $script:CurrentPhase = 'mem0'
    Invoke-ComposeUp -Phase $script:CurrentPhase -Directory $Mem0Directory -Arguments @(
        'up', '-d', '--wait', '--wait-timeout', $ServiceTimeoutSeconds.ToString()
    )
    Wait-ForCondition -Phase $script:CurrentPhase -Action 'wait_http_ready' -TimeoutSeconds $ServiceTimeoutSeconds -Condition {
        Test-HttpReady -Uri 'http://127.0.0.1:8888/openapi.json' -ValidateBody { param($body) -not [string]::IsNullOrWhiteSpace($body) }
    }

    $script:CurrentPhase = 'mcp'
    Invoke-ComposeUp -Phase $script:CurrentPhase -Directory $McpDirectory -Arguments @(
        'up', '-d', '--wait', '--wait-timeout', $ServiceTimeoutSeconds.ToString()
    )
    Wait-ForCondition -Phase $script:CurrentPhase -Action 'wait_http_ready' -TimeoutSeconds $ServiceTimeoutSeconds -Condition {
        Test-HttpReady -Uri 'http://127.0.0.1:8765/health/ready' -ValidateBody {
            param($body)
            try {
                return ($body | ConvertFrom-Json).status -eq 'ready'
            }
            catch {
                return $false
            }
        }
    }

    $script:CurrentPhase = 'librechat'
    Invoke-ComposeUp -Phase $script:CurrentPhase -Directory $LibreChatDirectory -Arguments @(
        'up', '-d', 'api', 'mongodb', 'meilisearch', 'vectordb', 'rag_api'
    )
    Wait-ForCondition -Phase $script:CurrentPhase -Action 'wait_http_ready' -TimeoutSeconds $ServiceTimeoutSeconds -Condition {
        Test-HttpReady -Uri 'http://127.0.0.1:3080/readyz' -ValidateBody { param($body) $body.Trim() -eq 'OK' }
    }
}

try {
    Initialize-Log
    $mutex = [Threading.Mutex]::new($false, $MutexName)
    try {
        $script:MutexOwned = $mutex.WaitOne(0)
    }
    catch [Threading.AbandonedMutexException] {
        $script:MutexOwned = $true
    }

    if (-not $script:MutexOwned) {
        Write-BootstrapLog -Phase 'bootstrap' -Action 'acquire_mutex' -Result skipped -Message 'another_instance_is_running'
        exit 0
    }

    Write-BootstrapLog -Phase 'bootstrap' -Action 'acquire_mutex' -Result success
    Start-LuviraMemoryStack
    Write-BootstrapLog -Phase 'bootstrap' -Action 'complete' -Result success -Message 'all_services_ready'
    exit 0
}
catch {
    if (Test-Path -LiteralPath $LogDirectory) {
        Write-BootstrapLog -Phase $script:CurrentPhase -Action 'bootstrap' -Result failure -Message $_.Exception.GetType().Name
    }
    exit 1
}
finally {
    if ($script:MutexOwned -and $null -ne $mutex) {
        $mutex.ReleaseMutex()
    }
    if ($null -ne $mutex) {
        $mutex.Dispose()
    }
}
