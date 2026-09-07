param(
    [ValidateSet('LauncherProbe', 'ModelProbe', 'Run')]
    [string]$Mode = 'Run',
    [string]$PromptFile,
    [string]$WorkingDirectory = (Get-Location).Path,
    [ValidateSet('read-only', 'workspace-write')]
    [string]$Sandbox = 'workspace-write',
    [string]$InvokerGoal = 'unknown',
    [Parameter(Mandatory = $true)][string]$RootSessionId,
    [string[]]$OwnedPath = @(),
    [string]$CallId,
    [string]$ReceiptPath,
    [switch]$TelemetryFixture
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
Import-Module (Join-Path $PSScriptRoot 'OrchestrationState.psm1') -Force

function Get-PropertyValue {
    param($Object, [string]$Name, $Default = $null)
    if ($null -eq $Object) { return $Default }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $Default }
    return $property.Value
}

function Assert-PathInsideRoot {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root,
        [switch]$MustExist
    )

    $candidate = if ([System.IO.Path]::IsPathRooted($Path)) {
        [System.IO.Path]::GetFullPath($Path)
    }
    else {
        [System.IO.Path]::GetFullPath((Join-Path $Root $Path))
    }
    $rootPrefix = $Root.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if ($candidate -ne $Root -and -not $candidate.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the authorized project root: $candidate"
    }
    if ($MustExist -and -not (Test-Path -LiteralPath $candidate)) {
        throw "Required path does not exist: $candidate"
    }
    return $candidate
}

function Get-LimitInfo {
    param([string]$Text)

    $limitPattern = '(?i)(out of (?:usage )?limits?|usage limit (?:reached|exceeded)|you(?:''ve| have) hit (?:your )?(?:(?:5\s*h|7\s*d|5[- ]?hour|7[- ]?day|weekly) )?(?:usage )?limit|rate limit (?:reached|exceeded)|quota (?:reached|exceeded|exhausted)|insufficient_quota|too many requests|weekly limit (?:reached|exceeded))'
    if ($Text -notmatch $limitPattern) {
        return [pscustomobject]@{ Exhausted = $false; Bucket = $null }
    }
    $bucket = 'unknown'
    if ($Text -match '(?i)(\b5\s*h\b|5[- ]?hour|five[- ]?hour)') {
        $bucket = '5h'
    }
    elseif ($Text -match '(?i)(\b7\s*d\b|7[- ]?day|seven[- ]?day|weekly|week limit)') {
        $bucket = '7d'
    }
    return [pscustomobject]@{ Exhausted = $true; Bucket = $bucket }
}

function Save-Receipt {
    param(
        [Parameter(Mandatory = $true)]$Receipt,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $directory = Split-Path -Parent $Path
    New-Item -ItemType Directory -Force -Path $directory | Out-Null
    $encoding = New-Object System.Text.UTF8Encoding($false)
    [System.IO.File]::WriteAllText($Path, ($Receipt | ConvertTo-Json -Depth 20), $encoding)
}

function Write-TimesheetEvent {
    param([string]$Path, $Event)
    $target = [System.IO.Path]::GetFullPath($Path).ToLowerInvariant()
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try { $digest = ($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($target)) | ForEach-Object { $_.ToString('x2') }) -join '' } finally { $sha.Dispose() }
    [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))) | Out-Null
    $lockPath = [IO.Path]::GetFullPath($Path) + '.lock'
    $deadline = [DateTimeOffset]::UtcNow.AddMilliseconds(1500)
    $lock = $null
    while ($null -eq $lock) {
        try { $lock = [IO.File]::Open($lockPath, 'CreateNew', 'Write', 'None') }
        catch [IO.IOException] {
            if ([DateTimeOffset]::UtcNow -ge $deadline) { throw [TimeoutException]::new('Timed out acquiring timesheet lock.') }
            try { if (([DateTimeOffset]::UtcNow - [IO.File]::GetLastWriteTimeUtc($lockPath)).TotalSeconds -gt 30) { [IO.File]::Delete($lockPath) } } catch { }
            Start-Sleep -Milliseconds 20
        }
    }
    try {
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName([IO.Path]::GetFullPath($Path))) | Out-Null
        $bytes = (New-Object Text.UTF8Encoding($false)).GetBytes((($Event | ConvertTo-Json -Compress -Depth 20) + "`n"))
        $stream = [IO.File]::Open($Path, 'Append', 'Write', 'Read')
        try { $stream.Write($bytes, 0, $bytes.Length) } finally { $stream.Dispose() }
    } finally { $lock.Dispose(); try { [IO.File]::Delete($lockPath) } catch { } }
}

function Get-BindingState {
    param($Receipt)
    $requested = Get-PropertyValue $Receipt 'requested_model'
    $effective = Get-PropertyValue $Receipt 'effective_model'
    if ($requested -and $effective) { if ($requested -eq $effective) { return 'VERIFIED' }; return 'MISMATCH' }
    $proof = [string](Get-PropertyValue $Receipt 'binding_proof' '')
    if ($proof.StartsWith('explicit-model-argument') -or (Get-PropertyValue $Receipt 'status') -in @('skipped_limit_exhausted', 'available')) { return 'CONFIG_PINNED' }
    return 'UNVERIFIED'
}

function Complete-SparkAttempt {
    param([string]$ProjectRoot, $Receipt, [string]$ReceiptPath, [switch]$SkipLedger)
    $timesheetPath = if ($env:CODEX_TIMESHEET_PATH) { [IO.Path]::GetFullPath($env:CODEX_TIMESHEET_PATH) } else { $codexDirectory = if ($env:CODEX_HOME) { $env:CODEX_HOME } else { Join-Path ([Environment]::GetFolderPath('UserProfile')) '.codex' }; Join-Path $codexDirectory ('timesheets\events-' + [DateTimeOffset]::UtcNow.ToString('yyyy-MM') + '.jsonl') }
    $event = [pscustomobject][ordered]@{
        schema_version = 3; workflow = 'orchestrate-development-v3'; orchestration_version = 3; event = 'spark_completed'; source = 'orchestrated_spark_adapter'; recorded_at = [DateTimeOffset]::UtcNow.ToString('o'); date = [DateTimeOffset]::Now.ToString('yyyy-MM-dd')
        project = Split-Path -Leaf $ProjectRoot; project_root = $ProjectRoot; session_id = $null; turn_id = $null; call_id = (Get-PropertyValue $Receipt 'call_id'); started_at = (Get-PropertyValue $Receipt 'started_at'); ended_at = (Get-PropertyValue $Receipt 'completed_at')
        requested_model = (Get-PropertyValue $Receipt 'requested_model'); requested_effort = $null; effective_model = (Get-PropertyValue $Receipt 'effective_model'); effective_effort = $null; model = (Get-PropertyValue $Receipt 'effective_model'); binding_state = Get-BindingState $Receipt
        parent_session_id = $env:CODEX_SESSION_ID; root_session_id = (Get-PropertyValue $Receipt 'root_session_id'); role = 'SPARK_TOOL'; route = 'SPARK_TOOL'; stage_id = (Get-PropertyValue $Receipt 'stage_id'); goal_id = (Get-PropertyValue $Receipt 'invoker_goal'); lifetime = $null; invoker_goal = (Get-PropertyValue $Receipt 'invoker_goal'); interaction_class = 'SPARK'; usage_scope = 'spark_call'; usage_source = 'adapter'; usage_additive = $true; event_id = ('spark-' + (Get-PropertyValue $Receipt 'call_id')); observed_model = (Get-PropertyValue $Receipt 'effective_model')
        turn_usage = $null; goal_usage = (Get-PropertyValue $Receipt 'usage'); session_usage = $null; token_usage = (Get-PropertyValue $Receipt 'usage'); usage_kind = 'adapter_delta'; outcome = (Get-PropertyValue $Receipt 'status'); status = (Get-PropertyValue $Receipt 'status')
        validation_status = (Get-PropertyValue $Receipt 'validation_status' 'UNVERIFIED'); fallback = (Get-PropertyValue $Receipt 'fallback'); wall_time_seconds = (Get-PropertyValue $Receipt 'wall_time_seconds'); exit_code = (Get-PropertyValue $Receipt 'exit_code'); platform_adapter = (Get-PropertyValue $Receipt 'platform_adapter')
    }
    try { Write-TimesheetEvent -Path $timesheetPath -Event $event; $Receipt | Add-Member telemetry_write_status 'written' -Force } catch { $Receipt | Add-Member telemetry_write_status ('failed:' + $_.Exception.GetType().Name) -Force }
    if ($ReceiptPath) { Save-Receipt -Receipt $Receipt -Path $ReceiptPath }
    if (-not $SkipLedger) { Update-SparkLedger -ProjectRoot $ProjectRoot -Receipt $Receipt }
    [Console]::Out.WriteLine('SPARK_RECEIPT ' + ($Receipt | ConvertTo-Json -Compress -Depth 20))
}

function Update-SparkLedger {
    param(
        [Parameter(Mandatory = $true)][string]$ProjectRoot,
        [Parameter(Mandatory = $true)]$Receipt
    )

    $rootSessionId = Get-PropertyValue $Receipt 'root_session_id'
    $statePath = if ($rootSessionId) { Get-OrchestrationStatePath -ProjectRoot $ProjectRoot -SessionId $rootSessionId } else { $null }
    if (-not $statePath -or -not (Test-Path -LiteralPath $statePath)) {
        return
    }
    $null = Invoke-OrchestrationStateUpdate -Path $statePath -Update {
        param($state)
        $state.spark.calls = @($state.spark.calls) + $Receipt
        if ($Receipt.status -in @('limit_exhausted', 'skipped_limit_exhausted')) {
            $state.spark.availability = 'limited'
            $state.spark.limit_state = 'exhausted'
            $state.spark.limit_bucket = $Receipt.limit_bucket
        }
        elseif ($Receipt.status -in @('available', 'verified', 'returned_untrusted')) {
            $state.spark.availability = 'available'
            if ($state.spark.limit_state -ne 'exhausted') {
                $state.spark.limit_state = 'available'
                $state.spark.limit_bucket = $null
            }
        }
        Add-OrchestrationEvent -State $state -Type 'SPARK_CALL' -Data @{ call_id = $Receipt.call_id; status = $Receipt.status; fallback = $Receipt.fallback }
        return $state
    }
}

try {
    $projectRoot = Get-OrchestrationProjectRoot -Cwd $WorkingDirectory
    $workingRoot = Assert-PathInsideRoot -Path $WorkingDirectory -Root $projectRoot -MustExist
    if (-not $CallId) {
        $CallId = 'spark-' + [DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssfff') + '-' + ([guid]::NewGuid().ToString('N').Substring(0, 6))
    }
    if ($CallId -notmatch '^[A-Za-z0-9_.-]+$') {
        throw 'CallId may contain only letters, digits, dot, underscore, and hyphen.'
    }

    $artifactRoot = Join-Path $projectRoot ".scratch\orchestration-spark\$CallId"
    New-Item -ItemType Directory -Force -Path $artifactRoot | Out-Null
    if (-not $ReceiptPath) {
        $ReceiptPath = Join-Path $artifactRoot 'receipt.json'
    }
    else {
        $ReceiptPath = Assert-PathInsideRoot -Path $ReceiptPath -Root $projectRoot
    }

    $validatedOwnedPaths = @()
    foreach ($path in $OwnedPath) {
        $validatedOwnedPaths += Assert-PathInsideRoot -Path $path -Root $projectRoot
    }

    if ($TelemetryFixture) {
        $now = [DateTimeOffset]::UtcNow.ToString('o')
        $receipt = [pscustomobject][ordered]@{
            call_id = $CallId; mode = $Mode; status = 'fixture_completed'; requested_model = 'gpt-5.3-codex-spark'; effective_model = 'gpt-5.3-codex-spark'
            binding_proof = 'test-fixture-exposed-model'; invoker_goal = $InvokerGoal; root_session_id = $RootSessionId; started_at = $now; completed_at = $now; wall_time_seconds = 0; exit_code = 0
            usage = [pscustomobject]@{ input_tokens = 7; output_tokens = 3; total_tokens = 10 }; validation_status = 'PASSED'; fallback = $null; task_should_continue = $true; platform_adapter = 'powershell-windows'
        }
        Complete-SparkAttempt -ProjectRoot $projectRoot -Receipt $receipt -ReceiptPath $ReceiptPath -SkipLedger
        exit 0
    }

    $activeStatePath = Get-OrchestrationStatePath -ProjectRoot $projectRoot -SessionId $RootSessionId
    if (Test-Path -LiteralPath $activeStatePath) {
        $activeState = Read-OrchestrationState -Path $activeStatePath
        if ($activeState.spark.limit_state -eq 'exhausted' -and $Mode -ne 'LauncherProbe') {
            $receipt = [pscustomobject][ordered]@{
                call_id                 = $CallId
                mode                    = $Mode
                status                  = 'skipped_limit_exhausted'
                requested_model         = 'gpt-5.3-codex-spark'
                binding_proof           = 'not-attempted-current-run-limit-receipt'
                sandbox                 = $Sandbox
                invoker_goal            = $InvokerGoal
                root_session_id         = $RootSessionId
                owned_paths             = $validatedOwnedPaths
                started_at              = [DateTimeOffset]::UtcNow.ToString('o')
                completed_at            = [DateTimeOffset]::UtcNow.ToString('o')
                wall_time_seconds       = 0
                exit_code               = 0
                turn_completed          = $false
                usage                   = $null
                limit_bucket            = $activeState.spark.limit_bucket
                fallback                = 'LUNA'
                task_should_continue    = $true
                acceptance_owner        = 'ROOT_ORCHESTRATOR'
                economic_cost_assumption = 0
                artifact_directory      = $artifactRoot
                platform_adapter        = 'powershell-windows'
            }
            Complete-SparkAttempt -ProjectRoot $projectRoot -Receipt $receipt -ReceiptPath $ReceiptPath
            exit 0
        }
    }

    $launcher = Get-Command codex -ErrorAction Stop
    $startedAt = [DateTimeOffset]::UtcNow
    $stopwatch = [System.Diagnostics.Stopwatch]::StartNew()
    $eventsPath = Join-Path $artifactRoot 'events.jsonl'
    $stderrPath = Join-Path $artifactRoot 'stderr.txt'
    $lastMessagePath = Join-Path $artifactRoot 'last-message.txt'
    $exitCode = 0
    $turnCompleted = $false
    $usage = $null
    $effectiveModel = $null
    $combinedOutput = ''

    if ($Mode -eq 'LauncherProbe') {
        $previousErrorAction = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $version = & $launcher.Source --version 2>&1
            $exitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previousErrorAction
        }
        $combinedOutput = $version -join "`n"
        [System.IO.File]::WriteAllText($lastMessagePath, $combinedOutput, (New-Object System.Text.UTF8Encoding($false)))
    }
    else {
        if ($Mode -eq 'ModelProbe') {
            $promptText = 'Return exactly SPARK_MODEL_OK. Do not inspect or modify files, plan, create a Goal, invoke skills, or delegate.'
            $Sandbox = 'read-only'
        }
        else {
            if (-not $PromptFile) {
                throw 'Run mode requires -PromptFile.'
            }
            $resolvedPrompt = Assert-PathInsideRoot -Path $PromptFile -Root $projectRoot -MustExist
            $promptBytes = (Get-Item -LiteralPath $resolvedPrompt).Length
            if ($promptBytes -gt 131072) {
                throw "Spark prompt exceeds the 128 KiB adapter envelope: $promptBytes bytes."
            }
            $taskPrompt = Get-Content -Raw -LiteralPath $resolvedPrompt
            $promptText = @"
You are Spark acting as a bounded deterministic tool under the v3 root or implementation worker, or as a read-only lookup for Terra.
Execute exactly the supplied deterministic operation. Do not create a Goal or plan, invoke skills, delegate, redesign, broaden scope, or perform final acceptance. Stop without changes on ambiguity, missing context, risk, or scope expansion. Return only result, changed paths, validation attempted, and uncertainty.

$taskPrompt
"@
        }

        $arguments = @(
            'exec', '--ephemeral', '--ignore-user-config', '--json', '--disable', 'hooks',
            '--model', 'gpt-5.3-codex-spark', '--sandbox', $Sandbox, '--cd', $workingRoot,
            '--config', 'model_reasoning_summary="none"',
            '--config', 'model_supports_reasoning_summaries=false',
            '--output-last-message', $lastMessagePath, '-'
        )
        $previousErrorAction = $ErrorActionPreference
        $ErrorActionPreference = 'Continue'
        try {
            $promptText | & $launcher.Source @arguments 1> $eventsPath 2> $stderrPath
            $exitCode = $LASTEXITCODE
        }
        finally {
            $ErrorActionPreference = $previousErrorAction
        }

        $eventLines = if (Test-Path -LiteralPath $eventsPath) { @(Get-Content -LiteralPath $eventsPath) } else { @() }
        foreach ($line in $eventLines) {
            try {
                $parsed = $line | ConvertFrom-Json
                if ((Get-PropertyValue -Object $parsed -Name 'type' -Default '') -eq 'turn.completed') {
                    $turnCompleted = $true
                    $candidateUsage = Get-PropertyValue -Object $parsed -Name 'usage'
                    if ($null -ne $candidateUsage) { $usage = $candidateUsage }
                }
                $eventModel = Get-PropertyValue -Object $parsed -Name 'model'
                if ($eventModel -is [string] -and $eventModel) { $effectiveModel = $eventModel }
            }
            catch {
                # Keep raw JSONL for diagnostics; a malformed non-terminal line is not enough to discard a completed turn.
            }
        }
        $combinedOutput = (($eventLines -join "`n") + "`n" + $(if (Test-Path -LiteralPath $stderrPath) { Get-Content -Raw -LiteralPath $stderrPath } else { '' }) + "`n" + $(if (Test-Path -LiteralPath $lastMessagePath) { Get-Content -Raw -LiteralPath $lastMessagePath } else { '' }))
    }

    $stopwatch.Stop()
    $completedAt = [DateTimeOffset]::UtcNow
    $limitInfo = Get-LimitInfo -Text $combinedOutput
    $lastMessage = if (Test-Path -LiteralPath $lastMessagePath) { (Get-Content -Raw -LiteralPath $lastMessagePath).Trim() } else { '' }

    if ($limitInfo.Exhausted) {
        $status = 'limit_exhausted'
        $fallback = 'LUNA'
        $taskShouldContinue = $true
        $bindingProof = 'limit-response-from-spark-route'
    }
    elseif ($Mode -eq 'LauncherProbe' -and $exitCode -eq 0) {
        $status = 'available'
        $fallback = $null
        $taskShouldContinue = $true
        $bindingProof = 'codex-launcher-version'
    }
    elseif ($Mode -eq 'ModelProbe' -and $exitCode -eq 0 -and $turnCompleted -and $lastMessage -eq 'SPARK_MODEL_OK') {
        $status = 'verified'
        $fallback = $null
        $taskShouldContinue = $true
        $bindingProof = 'explicit-model-argument+turn.completed+expected-marker'
    }
    elseif ($Mode -eq 'Run' -and $exitCode -eq 0 -and $turnCompleted -and $lastMessage) {
        $status = 'returned_untrusted'
        $fallback = $null
        $taskShouldContinue = $true
        $bindingProof = 'explicit-model-argument+turn.completed'
    }
    else {
        $status = 'launch_or_output_failed'
        $fallback = 'LUNA'
        $taskShouldContinue = $true
        $bindingProof = 'failed-or-incomplete'
    }

    $receipt = [pscustomobject][ordered]@{
        call_id                  = $CallId
        mode                     = $Mode
        status                   = $status
        requested_model          = 'gpt-5.3-codex-spark'
        effective_model          = $effectiveModel
        binding_proof            = $bindingProof
        sandbox                  = $Sandbox
        invoker_goal             = $InvokerGoal
        root_session_id          = $RootSessionId
        owned_paths              = $validatedOwnedPaths
        started_at               = $startedAt.ToString('o')
        completed_at             = $completedAt.ToString('o')
        wall_time_seconds        = [math]::Round($stopwatch.Elapsed.TotalSeconds, 3)
        exit_code                = $exitCode
        turn_completed           = $turnCompleted
        usage                    = $usage
        limit_bucket             = $limitInfo.Bucket
        fallback                 = $fallback
        task_should_continue     = $taskShouldContinue
        acceptance_owner         = 'ROOT_ORCHESTRATOR'
        economic_cost_assumption = 0
        artifact_directory       = $artifactRoot
        last_message_path        = $lastMessagePath
        platform_adapter         = 'powershell-windows'
        validation_status        = $(if ($status -eq 'verified') { 'PASSED' } elseif ($status -eq 'available') { 'NOT_APPLICABLE' } else { 'UNVERIFIED' })
    }
    Complete-SparkAttempt -ProjectRoot $projectRoot -Receipt $receipt -ReceiptPath $ReceiptPath
    exit 0
}
catch {
    $failure = [pscustomobject][ordered]@{
        call_id              = $CallId
        mode                 = $Mode
        status               = 'adapter_error'
        requested_model      = 'gpt-5.3-codex-spark'
        root_session_id       = $RootSessionId
        fallback             = 'LUNA'
        task_should_continue = $true
        error                = $_.Exception.Message
        platform_adapter     = 'powershell-windows'
    }
    try {
        $failureRoot = Get-OrchestrationProjectRoot -Cwd (Get-Location).Path
        $now = [DateTimeOffset]::UtcNow.ToString('o')
        $failure | Add-Member started_at $now -Force; $failure | Add-Member completed_at $now -Force
        $failure | Add-Member wall_time_seconds $null -Force; $failure | Add-Member exit_code 2 -Force; $failure | Add-Member usage $null -Force
        $failure | Add-Member invoker_goal 'unknown' -Force; $failure | Add-Member validation_status 'NOT_RUN' -Force
        Complete-SparkAttempt -ProjectRoot $failureRoot -Receipt $failure -ReceiptPath $null -SkipLedger
    } catch {
        $failure | Add-Member telemetry_write_status 'failed:unavailable' -Force
        [Console]::Out.WriteLine('SPARK_RECEIPT ' + ($failure | ConvertTo-Json -Compress -Depth 10))
    }
    exit 2
}
