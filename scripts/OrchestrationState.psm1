Set-StrictMode -Version Latest

$script:OrchestrationRoutes = @{
    ASTRA_WORKER = @('gpt-6-astra', 'low')
    LUNA_WORKER = @('gpt-5.6-luna', 'xhigh')
    SOL_REVIEWER = @('gpt-5.6-sol', 'medium')
    LUNA_VALIDATOR = @('gpt-5.6-luna', 'xhigh')
    TERRA_GATE = @('gpt-5.6-terra', 'high')
}

function Get-OrchestrationProjectRoot {
    param([Parameter(Mandatory = $true)][string]$Cwd)

    $resolved = [System.IO.Path]::GetFullPath($Cwd)
    try {
        $git = Get-Command git -ErrorAction Stop
        $candidate = & $git.Source -C $resolved rev-parse --show-toplevel 2>$null | Select-Object -First 1
        if ($LASTEXITCODE -eq 0 -and $candidate) {
            return [System.IO.Path]::GetFullPath($candidate.Trim())
        }
    }
    catch {
        # Fall back to the supplied working directory when Git is unavailable.
    }

    return $resolved
}

function ConvertTo-OrchestrationSafeName {
    param([Parameter(Mandatory = $true)][string]$Value)

    return [regex]::Replace($Value, '[^A-Za-z0-9_.-]', '_')
}

function Get-OrchestrationStateDirectory {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)

    return Join-Path $ProjectRoot '.scratch\orchestration-hooks'
}

function Get-OrchestrationStatePath {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)][string]$SessionId
    )

    $safeSession = ConvertTo-OrchestrationSafeName -Value $SessionId
    return Join-Path (Get-OrchestrationStateDirectory -ProjectRoot $ProjectRoot) "state-orchestrate-development-v3-$safeSession.json"
}

function Read-OrchestrationState {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path)) {
        return $null
    }

    return Get-Content -Raw -LiteralPath $Path | ConvertFrom-Json
}

function Write-OrchestrationState {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$State
    )

    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $State.updated_at = [DateTimeOffset]::UtcNow.ToString('o')
    $json = $State | ConvertTo-Json -Depth 20
    $temporaryPath = "$Path.$PID.tmp"
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($temporaryPath, $json, $encoding)
    Move-Item -Force -LiteralPath $temporaryPath -Destination $Path
}

function Get-OrchestrationMutexName {
    param([Parameter(Mandatory = $true)][string]$Path)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        $bytes = [System.Text.Encoding]::UTF8.GetBytes($Path.ToLowerInvariant())
        $hash = [System.BitConverter]::ToString($sha.ComputeHash($bytes)).Replace('-', '')
        return "Local\CodexOrchestration_$($hash.Substring(0, 24))"
    }
    finally {
        $sha.Dispose()
    }
}

function Invoke-OrchestrationStateUpdate {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][scriptblock]$Update)
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($Path)) | Out-Null
    $lockPath = $Path + '.lock'
    $deadline = [DateTimeOffset]::UtcNow.AddMilliseconds(700)
    $lock = $null
    while ($null -eq $lock) {
        try { $lock = [IO.File]::Open($lockPath, 'CreateNew', 'Write', 'None') }
        catch [IO.IOException] {
            if ([DateTimeOffset]::UtcNow -ge $deadline) { throw 'Orchestration ledger lock timeout' }
            try { if (([DateTimeOffset]::UtcNow - [IO.File]::GetLastWriteTimeUtc($lockPath)).TotalSeconds -gt 30) { [IO.File]::Delete($lockPath) } } catch { }
            Start-Sleep -Milliseconds 20
        }
    }
    try {
        $state = Read-OrchestrationState -Path $Path
        $changed = & $Update $state
        if ($null -ne $changed) { $state = $changed }
        if ($null -ne $state) { Write-OrchestrationState -Path $Path -State $state }
        return $state
    } finally { $lock.Dispose(); [IO.File]::Delete($lockPath) }
}

function New-OrchestrationState {
    param(
        [Parameter(Mandatory = $true)][string]$SessionId,
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [string]$PermissionMode = 'unknown'
    )

    $now = [DateTimeOffset]::UtcNow.ToString('o')
    return [pscustomobject][ordered]@{
        schema_version  = 3
        skill           = 'orchestrate-development-v3'
        workflow        = 'orchestrate-development-v3'
        orchestration_version = 3
        session_id      = $SessionId
        root_session_id = $SessionId
        project_root    = $ProjectRoot
        permission_mode = $PermissionMode
        active          = $true
        phase           = 'ARMED'
        created_at      = $now
        updated_at      = $now
        tasks           = [pscustomobject]@{}
        closeout        = [pscustomobject][ordered]@{
            ready             = $false
            heavy_validation  = 'unknown'
            plan_synchronized = $false
            docs_state        = 'unknown'
        }
        spark           = [pscustomobject][ordered]@{
            availability = 'unknown'
            limit_state  = 'unknown'
            limit_bucket = $null
            calls        = @()
        }
        events          = @()
    }
}

function Get-NormalizedTaskMetadata {
    param([string]$Role, [string]$Model, [string]$Effort, [string]$Lifetime, [string]$Profile, [int]$NativeDepth = 1)
    if ($Lifetime -notin @('LEAF', 'PROCESS')) { throw "Unsupported task lifetime: $Lifetime" }
    if ($NativeDepth -ne 1) { throw 'V3 native workers must be direct root children at depth 1.' }
    if ($Lifetime -eq 'PROCESS' -and $Role -notin @('ASTRA_WORKER', 'LUNA_WORKER')) { throw 'PROCESS requires ASTRA_WORKER or LUNA_WORKER.' }
    $pinned = $null
    if ($Profile -eq 'astra-low-worker') { $pinned = @('ASTRA_WORKER', 'gpt-6-astra', 'low') }
    elseif ($Profile -eq 'luna-xhigh-worker') { $pinned = @('LUNA_WORKER', 'gpt-5.6-luna', 'xhigh') }
    elseif ($Profile -eq 'terra-high-gate') { $pinned = @('TERRA_GATE', 'gpt-5.6-terra', 'high') }
    if ($pinned) {
        if ($Role -ne $pinned[0] -or $Model -notin @('', 'unknown', $pinned[1]) -or $Effort -notin @('', 'unknown', $pinned[2])) { throw 'Pinned profile does not match requested role/model/effort.' }
        return [pscustomobject]@{ role = $Role; model = $pinned[1]; effort = $pinned[2]; profile = $Profile; binding_state = 'CONFIG_PINNED' }
    }
    throw 'Exact known profile required; generic workers cannot substitute pinned routes.'

}

function Test-OrchestrationTaskCanDelegate {
    param($State, [string]$ParentTaskId)
    if (-not $ParentTaskId) {
        $active = @(Get-OrchestrationTasks $State | Where-Object { -not $_.parent_task_id -and $_.state -notin @('ACCEPTED', 'REJECTED', 'RETIRED', 'ARCHIVED') })
        return [pscustomobject]@{ allowed = ($active.Count -lt 5); reason = 'root active-child ceiling reached'; native_depth = 1 }
    }
    return [pscustomobject]@{ allowed = $false; reason = 'v3 workers cannot create native subagents'; native_depth = 0 }
}

function Get-OrchestrationTask {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$TaskId
    )

    if ($null -eq $State.tasks) {
        return $null
    }
    $property = $State.tasks.PSObject.Properties[$TaskId]
    if ($null -eq $property) {
        return $null
    }
    return $property.Value
}

function Set-OrchestrationTask {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$TaskId,
        [Parameter(Mandatory = $true)]$Task
    )

    if ($null -eq $State.tasks) {
        $State.tasks = [pscustomobject]@{}
    }
    $property = $State.tasks.PSObject.Properties[$TaskId]
    if ($null -eq $property) {
        $State.tasks | Add-Member -MemberType NoteProperty -Name $TaskId -Value $Task
    }
    else {
        $property.Value = $Task
    }
}

function Get-OrchestrationTasks {
    param([Parameter(Mandatory = $true)]$State)

    if ($null -eq $State.tasks) {
        return @()
    }
    return @($State.tasks.PSObject.Properties | ForEach-Object { $_.Value })
}

function Add-OrchestrationEvent {
    param(
        [Parameter(Mandatory = $true)]$State,
        [Parameter(Mandatory = $true)][string]$Type,
        [hashtable]$Data = @{}
    )

    $entry = [ordered]@{
        at   = [DateTimeOffset]::UtcNow.ToString('o')
        type = $Type
    }
    foreach ($key in $Data.Keys) {
        $entry[$key] = $Data[$key]
    }
    $events = @($State.events) + [pscustomobject]$entry
    if ($events.Count -gt 200) {
        $events = @($events | Select-Object -Last 200)
    }
    $State.events = $events
}

function Get-LatestOrchestrationStatePath {
    param([Parameter(Mandatory = $true)][string]$ProjectRoot)

    $directory = Get-OrchestrationStateDirectory -ProjectRoot $ProjectRoot
    if (-not (Test-Path -LiteralPath $directory)) {
        return $null
    }

    $candidates = foreach ($file in Get-ChildItem -LiteralPath $directory -Filter 'state-*.json' -File) {
        try {
            $state = Read-OrchestrationState -Path $file.FullName
            if ($state.active -eq $true -and $state.skill -eq 'orchestrate-development-v3') {
                [pscustomobject]@{ Path = $file.FullName; UpdatedAt = [DateTimeOffset]$state.updated_at }
            }
        }
        catch {
            # Ignore corrupt unrelated state here; exact-session hooks still report their own failure.
        }
    }

    $latest = $candidates | Sort-Object UpdatedAt -Descending | Select-Object -First 1
    if ($null -eq $latest) {
        return $null
    }
    return $latest.Path
}

Export-ModuleMember -Function @(
    'Get-OrchestrationProjectRoot',
    'Get-OrchestrationStateDirectory',
    'Get-OrchestrationStatePath',
    'Read-OrchestrationState',
    'Write-OrchestrationState',
    'Invoke-OrchestrationStateUpdate',
    'New-OrchestrationState',
    'Get-OrchestrationTask',
    'Set-OrchestrationTask',
    'Get-OrchestrationTasks',
    'Add-OrchestrationEvent',
    'Get-LatestOrchestrationStatePath',
    'Get-NormalizedTaskMetadata',
    'Test-OrchestrationTaskCanDelegate'
)
