[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$EnvFile = '',

    [string]$CodexExecutable = 'codex',

    [Parameter(ValueFromRemainingArguments)]
    [string[]]$CodexArguments = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$CredentialName = 'LUVIRA_MCP_API_KEY'
$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
# Client Credential Rollout finalization: defaults to a Codex-only credential
# file, not the multi-client shared .env, so a plain `start-codex.ps1` (no
# -EnvFile) never resolves to a credential another client also holds.
$CredentialFile = if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    Join-Path $RepositoryRoot '.env.codex'
}
else {
    [IO.Path]::GetFullPath($EnvFile)
}

function Read-DotEnvValue {
    param(
        [Parameter(Mandatory)]
        [string]$Path,

        [Parameter(Mandatory)]
        [string]$Name
    )

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw [IO.FileNotFoundException]::new('The credential file was not found.')
    }

    $result = $null
    foreach ($rawLine in Get-Content -LiteralPath $Path) {
        $line = $rawLine.Trim()
        if ($line.Length -eq 0 -or $line.StartsWith('#')) {
            continue
        }

        if ($line -notmatch '^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$') {
            continue
        }

        if ($Matches[1] -cne $Name) {
            continue
        }

        $value = $Matches[2].Trim()
        if ($value.Length -ge 1 -and ($value[0] -eq '"' -or $value[0] -eq "'")) {
            $quote = $value[0]
            if ($value.Length -lt 2 -or $value[$value.Length - 1] -ne $quote) {
                throw [FormatException]::new('The required credential has malformed quotes.')
            }
            $value = $value.Substring(1, $value.Length - 2)
        }

        $result = $value
    }

    return $result
}

$credential = $null
$originalCredential = $null
$hadOriginalCredential = Test-Path -LiteralPath "Env:$CredentialName"
$exitCode = 1

try {
    $credential = Read-DotEnvValue -Path $CredentialFile -Name $CredentialName
    if ([string]::IsNullOrWhiteSpace($credential)) {
        throw [InvalidOperationException]::new('Required credential LUVIRA_MCP_API_KEY was not found.')
    }

    if ($hadOriginalCredential) {
        $originalCredential = [Environment]::GetEnvironmentVariable($CredentialName, 'Process')
    }
    [Environment]::SetEnvironmentVariable($CredentialName, $credential, 'Process')

    $codexCommand = Get-Command $CodexExecutable -ErrorAction Stop
    & $codexCommand @CodexArguments
    $exitCode = $LASTEXITCODE
}
catch {
    $safeMessages = @(
        'The credential file was not found.',
        'The required credential has malformed quotes.',
        'Required credential LUVIRA_MCP_API_KEY was not found.'
    )
    if ($safeMessages -contains $_.Exception.Message) {
        Write-Error $_.Exception.Message
    }
    else {
        Write-Error 'Codex could not be started.'
    }
    $exitCode = 1
}
finally {
    if ($hadOriginalCredential) {
        [Environment]::SetEnvironmentVariable($CredentialName, $originalCredential, 'Process')
    }
    else {
        Remove-Item -LiteralPath "Env:$CredentialName" -ErrorAction SilentlyContinue
    }
    $credential = $null
    $originalCredential = $null
}

exit $exitCode
