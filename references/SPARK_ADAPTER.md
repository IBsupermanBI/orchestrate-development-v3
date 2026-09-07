# Spark Tool Adapter

Load this reference only when a node is routed to `SPARK_TOOL`.

## No custom-agent profile

Do not create or select a `spark-worker.toml` for this workflow. Spark is an ephemeral CLI tool, not a native subagent. The bundled adapter explicitly selects `gpt-5.3-codex-spark`, ignores user configuration, omits a reasoning-effort override, disables recursive hooks, captures binding telemetry, and applies Luna fallback. A global or project Spark agent profile is a different execution route and cannot replace this contract.

## Admission gate

Use Spark only when every answer is yes:

- Is the requested result one exact code transformation or deterministic lookup?
- Are owned paths and symbols already known?
- Can success be checked with one focused command or an exact diff condition?
- Is architecture, product meaning, risk acceptance, external state, auth, privacy, persistence, migration, concurrency, and final review out of scope?
- Can the task stop rather than guess when supplied context is insufficient?
- Will the supervising root, Astra, or Luna worker inspect the result before root acceptance?

Reject Spark for broad reconnaissance, repository-wide review, ambiguous bugs, planning, semantic data decisions, flaky diagnosis, integration ownership, or anything requiring another agent or skill.

## Context envelope

The model window is 128k, but do not target that maximum. Prefer a working envelope below about 32k input tokens:

- one objective;
- no parent conversation or orchestration skill body;
- no more than three directly owned files unless they are tiny;
- exact file, symbol, and contract pointers;
- the smallest relevant excerpts or permission to read only named paths;
- one expected validation command;
- no raw logs, broad plans, or unrelated documentation.

## Adapter selection

Run capability preflight once per orchestration run and execution layer. A host-level success is historical evidence, not proof that a root task or a particular Luna task can launch the same executable through its current sandbox:

```text
SPARK_CAPABILITY_RECEIPT
parent_permission_mode: auto|full-access|read-only|unknown
root_cli_launcher: proven|blocked
root_cli_model: verified|unverified
worker_cli_launcher: proven|unknown|mismatch|not-needed
app_model: verified|system-error|unverified
summary_suppression: verified|unverified
limit_state: available|5h-exhausted|7d-exhausted|exhausted-unknown|unknown
execution_owner: ROOT_BROKER|WORKER|BLOCKED
```

Prefer the CLI adapter when the `codex` launcher runs from `PATH` in the selected execution layer and summary suppression is verified. Finding `codex.exe` or proving it in another task is insufficient. Use the app-task adapter only when the current app/runtime has a successful Spark receipt; do not repeatedly reprobe a known App system error.

Prefer `WORKER` after one successful launcher probe from the exact supervising Astra or Luna process. A worker may consider Spark after creating its micro-plan whenever a step passes the admission gate. Root may use Spark for an already frozen mechanical operation. Terra may invoke Spark only with a read-only sandbox for an explicitly authorized deterministic lookup and cannot request or accept a transformation. Prefer `ROOT_BROKER` when the child layer is unknown or blocked. A user-selected full-access mode can improve process availability and is inherited by subagents, but it does not prove CLI authentication, model availability, summary compatibility, remaining Spark quota, or the nested CLI sandbox.

While Spark edits, the supervising root, Astra, or Luna worker transfers the writer lease for the named paths and waits. It must not edit the same paths concurrently.

## Root-broker protocol

When an Astra or Luna worker is authorized to use Spark but `execution_owner` is `ROOT_BROKER`, it does not spawn a nested task. After binding its Goal and micro-plan, it sends:

```text
SPARK_BROKER_REQUEST
invoker_goal: <Goal ID>
result: <one exact observable change>
owned_paths_symbols: <maximum three narrow targets>
read_scope: <smallest required scope>
change: <mechanical ordered instruction>
validate: <one focused command or exact diff condition>
writer_lease: yielded
stop_conditions: <ambiguity, missing context, risk, scope expansion>
```

The primary verifies the request against the parent packet and current writer map, invokes one Spark attempt, and returns a compact `SPARK_BROKER_RECEIPT` with binding proof, changed paths, validation state, wall time, usage when exposed, and fallback. The requesting supervisor then inspects the shared diff and owns acceptance. Do not relay raw JSON event streams or the parent conversation.

If the primary cannot run Spark either, return `SPARK_CAPABILITY_BLOCKED` and route the exact operation to Luna. Do not ask Luna to keep probing the same launcher.

## Limit exhaustion

Spark uses a separate pool but still has 5-hour and 7-day limits. Treat a response mentioning an exhausted usage quota, rate limit, weekly limit, 5h window, or 7d window as `SPARK_LIMIT_EXHAUSTED`, not as a failed Luna Goal.

- Do not retry Spark in the same orchestration run after a limit receipt.
- Record `limit_bucket: 5h | 7d | unknown` and preserve runtime text only in the adapter artifact, not the parent context.
- Return `fallback: LUNA` and `task_should_continue: true`.
- Route the exact operation to Luna using the same acceptance criteria. Terra remains read-only; root keeps decision and acceptance ownership.
- Do not escalate to Terra merely because Spark quota ended.
- A later orchestration run may perform one fresh capability probe because the limit window may have reset.

## App-task adapter

Use a visible Codex task only when the current app is known to bind the model without unsupported fields:

```text
model: gpt-5.3-codex-spark
thinking/reasoning override: omit
title: [DEV][SPARK][KNN][TOOL] <exact-operation>
Goal/update_plan: do not use
```

Initial prompt:

```text
Execute exactly one bounded code operation.
Result: <exact observable diff>
Owned paths/symbols: <maximum three narrow targets>
Read: only the named targets and directly required imports/types.
Change: <mechanical ordered instruction>
Validate: <one focused command or exact diff check>.
Stop without changes if anything is ambiguous, missing, risky, or outside scope.
Do not plan, create a Goal, call update_plan, invoke skills, delegate, redesign, broaden scope, or perform final acceptance.
Return only: result; changed paths; validation; uncertainty.
```

If the task fails with an unsupported `reasoning.summary` parameter, record `SPARK_APP_SUMMARY_UNSUPPORTED` and do not retry the same adapter.

## CLI adapter

Use the bundled [Invoke-OrchestratedSpark.ps1](../scripts/Invoke-OrchestratedSpark.ps1) on Windows or [invoke_orchestrated_spark.py](../scripts/invoke_orchestrated_spark.py) through `python3` on macOS/Linux rather than assembling `codex exec` manually. Both make Spark behave like an ephemeral tool, resolve the launcher from `PATH`, apply the same safe fixed flags, store raw JSON outside agent context, detect limit exhaustion, update the same optional JSON hook ledger, and return one compact `SPARK_RECEIPT`.

Each completed, skipped, or failed adapter attempt also appends one schema-v3 `spark_completed` event to `CODEX_TIMESHEET_PATH`, or `$CODEX_HOME/timesheets/events-YYYY-MM.jsonl` when unset. It uses a fail-open append protocol: telemetry failure does not change Spark status, fallback, or exit semantics. The event excludes prompts, outputs, owned paths, artifact paths, secrets, and economic-price estimates. Adapter usage remains separate from host and subagent usage. Legacy ledger helpers are retained for adapter compatibility only; do not activate an orchestration guard or require ledger acceptance transitions. The supervisor records acceptance in its normal working record.

Launch one non-interactive run with:

- model `gpt-5.3-codex-spark`;
- ephemeral session;
- ignored user config so parent model and effort defaults are not inherited;
- the narrowest safe sandbox (`read-only` for discovery, `workspace-write` for an authorized edit);
- `model_reasoning_summary="none"`;
- `model_supports_reasoning_summaries=false`;
- JSON events for binding, result, timing, and token telemetry;
- hooks disabled inside the nested Spark session to prevent recursive lifecycle handling;
- no persistent profile, default-agent change, Goal, micro-plan, MCP dependency, or reasoning-effort override.

Probe the launcher once from the execution layer selected by the capability receipt (`WORKER` or `ROOT_BROKER`), not specifically from Luna:

```powershell
& .agents/skills/orchestrate-development-v3/scripts/Invoke-OrchestratedSpark.ps1 `
  -Mode LauncherProbe `
  -RootSessionId <root-session-id> `
  -InvokerGoal <Goal-ID>
```

For a real operation, write the compact packet under `.scratch` and invoke:

```powershell
& .agents/skills/orchestrate-development-v3/scripts/Invoke-OrchestratedSpark.ps1 `
  -Mode Run `
  -RootSessionId <root-session-id> `
  -PromptFile .scratch/spark-packet.txt `
  -InvokerGoal <Goal-ID> `
  -OwnedPath <path-one>,<path-two> `
  -Sandbox workspace-write
```

macOS/Linux equivalents:

```bash
python3 .agents/skills/orchestrate-development-v3/scripts/invoke_orchestrated_spark.py \
  --mode LauncherProbe \
  --root-session-id <root-session-id> \
  --invoker-goal <Goal-ID>

python3 .agents/skills/orchestrate-development-v3/scripts/invoke_orchestrated_spark.py \
  --mode Run \
  --root-session-id <root-session-id> \
  --prompt-file .scratch/spark-packet.txt \
  --invoker-goal <Goal-ID> \
  --owned-path <path-one> \
  --owned-path <path-two> \
  --sandbox workspace-write
```

The adapter internally uses the equivalent of `codex exec --ephemeral --ignore-user-config --json --disable hooks --model gpt-5.3-codex-spark` with summary suppression and no reasoning-effort override. The project orchestration guard is not required or installed. Run capability probes in the actual environment; unavailable flags, authentication or model access trigger the normal Luna fallback.

Do not pass `--yolo`, bypass approvals inside the nested CLI, ignore project safety rules, or write outside the authorized workspace. An outer full-access mode is valid only when the user selected it before orchestration; it does not relax Git, secret, deployment, destructive-action, or project-instruction gates. A successful operation still requires exit code zero, one expected agent result, and a `turn.completed` event. Non-fatal shell-snapshot or model-refresh warnings after a successful `turn.completed` do not invalidate the result. If CLI authentication, outer sandbox approval, inner sandboxing, model availability, summary suppression, or output validation fails, use the receipt's Luna fallback.

Package installation and syntax checks do not establish live Spark availability. Each execution environment must run its own capability probe. An app-task route additionally requires an explicit user request to create a separate task; never create one automatically as fallback.

## Acceptance and accounting

Spark never accepts its own result. The supervising root, Astra, or Luna worker must inspect the exact diff and run or confirm focused validation before incorporating it. Terra may inspect only a read-only lookup result.

Record:

```text
Spark call ID
Invoker: ROOT | ASTRA | LUNA | TERRA_READ_ONLY
Adapter: APP | CLI
Execution owner: ROOT_BROKER | WORKER
Parent permission mode: auto | full-access | read-only | unknown
Bound model evidence
Owned paths
Created/completed wall time
Result: accepted | rejected | launch-failed | validation-failed
Validation owner and signal
Limit state and bucket: available | 5h | 7d | unknown
Fallback, if any
Runtime usage: exact value | not exposed
Economic cost: observed value only; otherwise unknown
```
