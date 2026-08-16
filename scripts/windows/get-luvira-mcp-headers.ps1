[CmdletBinding(PositionalBinding = $false)]
param()

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$ExpectedServerName = 'luvira-memory'
$ExpectedServerUrl = 'http://127.0.0.1:8765/mcp'
$CredentialName = 'LUVIRA_MCP_API_KEY'
$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))
$CredentialFile = Join-Path $RepositoryRoot '.env'

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

try {
    $serverName = [Environment]::GetEnvironmentVariable('CLAUDE_CODE_MCP_SERVER_NAME', 'Process')
    if (-not [string]::IsNullOrWhiteSpace($serverName) -and $serverName -cne $ExpectedServerName) {
        throw [InvalidOperationException]::new('Unexpected MCP server name.')
    }

    $serverUrl = [Environment]::GetEnvironmentVariable('CLAUDE_CODE_MCP_SERVER_URL', 'Process')
    if (-not [string]::IsNullOrWhiteSpace($serverUrl) -and $serverUrl -cne $ExpectedServerUrl) {
        throw [InvalidOperationException]::new('Unexpected MCP server URL.')
    }

    $credential = Read-DotEnvValue -Path $CredentialFile -Name $CredentialName
    if ([string]::IsNullOrWhiteSpace($credential)) {
        throw [InvalidOperationException]::new('The required credential was not found.')
    }

    $headers = [ordered]@{
        Authorization = "Bearer $credential"
    }
    [Console]::Out.WriteLine(($headers | ConvertTo-Json -Compress))
}
catch {
    [Console]::Error.WriteLine('Luvira MCP authorization headers could not be generated.')
    exit 1
}
finally {
    $credential = $null
}

