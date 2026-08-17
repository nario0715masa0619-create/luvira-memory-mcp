[CmdletBinding(PositionalBinding = $false)]
param(
    [string]$EnvFile = '',

    [string]$OpenRouterEnvFile = '',

    [string]$KimiExecutable = 'kimi',

    [string]$KimiModel = 'deepseek/deepseek-chat',

    [Parameter(ValueFromRemainingArguments)]
    [string[]]$KimiArguments = @()
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

$LuviraCredentialName = 'LUVIRA_MCP_API_KEY'
$OpenRouterCredentialName = 'OPENROUTER_KEY'
$RepositoryRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..\..'))

$LuviraCredentialFile = if ([string]::IsNullOrWhiteSpace($EnvFile)) {
    Join-Path $RepositoryRoot '.env'
}
else {
    [IO.Path]::GetFullPath($EnvFile)
}

# LibreChat is a sibling checkout under the same parent directory as this
# repository (see docs/windows-setup.md, "Required repositories"). Override
# with -OpenRouterEnvFile for a non-standard layout.
$OpenRouterCredentialFile = if ([string]::IsNullOrWhiteSpace($OpenRouterEnvFile)) {
    Join-Path (Split-Path $RepositoryRoot -Parent) 'LibreChat\.env'
}
else {
    [IO.Path]::GetFullPath($OpenRouterEnvFile)
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

function Set-ScopedEnvironmentVariable {
    param(
        [Parameter(Mandatory)]
        [string]$Name,

        [Parameter(Mandatory)]
        [AllowEmptyString()]
        [string]$Value
    )

    $hadOriginal = Test-Path -LiteralPath "Env:$Name"
    $original = if ($hadOriginal) { [Environment]::GetEnvironmentVariable($Name, 'Process') } else { $null }
    [Environment]::SetEnvironmentVariable($Name, $Value, 'Process')
    return [pscustomobject]@{ Name = $Name; HadOriginal = $hadOriginal; Original = $original }
}

function Restore-ScopedEnvironmentVariable {
    param(
        [Parameter(Mandatory)]
        [psobject]$State
    )

    if ($State.HadOriginal) {
        [Environment]::SetEnvironmentVariable($State.Name, $State.Original, 'Process')
    }
    else {
        Remove-Item -LiteralPath "Env:$($State.Name)" -ErrorAction SilentlyContinue
    }
}

$luviraCredential = $null
$openRouterCredential = $null
$scopedStates = [System.Collections.Generic.List[psobject]]::new()
$exitCode = 1

try {
    $luviraCredential = Read-DotEnvValue -Path $LuviraCredentialFile -Name $LuviraCredentialName
    if ([string]::IsNullOrWhiteSpace($luviraCredential)) {
        throw [InvalidOperationException]::new('Required credential LUVIRA_MCP_API_KEY was not found.')
    }

    $openRouterCredential = Read-DotEnvValue -Path $OpenRouterCredentialFile -Name $OpenRouterCredentialName
    if ([string]::IsNullOrWhiteSpace($openRouterCredential)) {
        throw [InvalidOperationException]::new('Required credential OPENROUTER_KEY was not found.')
    }

    # Luvira Memory MCP authentication (read by mcp.json's bearerTokenEnvVar).
    $scopedStates.Add((Set-ScopedEnvironmentVariable -Name $LuviraCredentialName -Value $luviraCredential))

    # Kimi Code CLI's own LLM backend, defined in-memory via the KIMI_MODEL_*
    # channel (https://moonshotai.github.io/kimi-code/en/configuration/env-vars.html
    # -- "Define a model from environment variables"). Nothing is written to
    # config.toml; the synthesized provider exists only for this process.
    $scopedStates.Add((Set-ScopedEnvironmentVariable -Name 'KIMI_MODEL_NAME' -Value $KimiModel))
    $scopedStates.Add((Set-ScopedEnvironmentVariable -Name 'KIMI_MODEL_API_KEY' -Value $openRouterCredential))
    $scopedStates.Add((Set-ScopedEnvironmentVariable -Name 'KIMI_MODEL_BASE_URL' -Value 'https://openrouter.ai/api/v1'))
    $scopedStates.Add((Set-ScopedEnvironmentVariable -Name 'KIMI_MODEL_PROVIDER_TYPE' -Value 'openai'))

    $kimiCommand = Get-Command $KimiExecutable -ErrorAction Stop
    & $kimiCommand @KimiArguments
    $exitCode = $LASTEXITCODE
}
catch {
    $safeMessages = @(
        'The credential file was not found.',
        'The required credential has malformed quotes.',
        'Required credential LUVIRA_MCP_API_KEY was not found.',
        'Required credential OPENROUTER_KEY was not found.'
    )
    if ($safeMessages -contains $_.Exception.Message) {
        Write-Error $_.Exception.Message
    }
    else {
        Write-Error 'Kimi Code CLI could not be started.'
    }
    $exitCode = 1
}
finally {
    for ($i = $scopedStates.Count - 1; $i -ge 0; $i--) {
        Restore-ScopedEnvironmentVariable -State $scopedStates[$i]
    }
    $luviraCredential = $null
    $openRouterCredential = $null
}

exit $exitCode
