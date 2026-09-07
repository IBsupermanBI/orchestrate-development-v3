#!/usr/bin/env python3
"""macOS/Linux bounded Spark CLI adapter with receipts and Luna fallback."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import shutil
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

sys.dont_write_bytecode = True

from orchestration_state import (
    add_event,
    latest_active_state_path,
    project_root,
    read_state,
    state_path,
    update_state,
    utc_now,
)


MODEL = "gpt-5.3-codex-spark"


def path_inside(path: str, root: Path, must_exist: bool = False) -> Path:
    candidate = Path(path).expanduser()
    if not candidate.is_absolute():
        candidate = root / candidate
    candidate = candidate.resolve()
    try:
        common = Path(os.path.commonpath([str(candidate), str(root)]))
    except ValueError as exc:
        raise ValueError("Path is outside the authorized project root: " + str(candidate)) from exc
    if common != root:
        raise ValueError("Path is outside the authorized project root: " + str(candidate))
    if must_exist and not candidate.exists():
        raise ValueError("Required path does not exist: " + str(candidate))
    return candidate


def limit_info(text: str) -> Tuple[bool, Optional[str]]:
    limit_pattern = re.compile(
        r"(?:out of (?:usage )?limits?|usage limit (?:reached|exceeded)|"
        r"you(?:'ve| have) hit (?:your )?(?:(?:5\s*h|7\s*d|5[- ]?hour|7[- ]?day|weekly) )?(?:usage )?limit|"
        r"rate limit (?:reached|exceeded)|quota (?:reached|exceeded|exhausted)|"
        r"insufficient_quota|too many requests|weekly limit (?:reached|exceeded))",
        re.IGNORECASE,
    )
    if not limit_pattern.search(text):
        return False, None
    if re.search(r"(?:\b5\s*h\b|5[- ]?hour|five[- ]?hour)", text, re.IGNORECASE):
        return True, "5h"
    if re.search(r"(?:\b7\s*d\b|7[- ]?day|seven[- ]?day|weekly|week limit)", text, re.IGNORECASE):
        return True, "7d"
    return True, "unknown"


def save_receipt(receipt: Dict[str, Any], path: Path) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(path.name + "." + str(os.getpid()) + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(receipt, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
    os.replace(temporary, path)


def append_timesheet_event(path: Path, event: Dict[str, Any]) -> None:
    """Append one JSONL event using the global timesheet hook lock protocol."""
    target = path.expanduser().resolve()
    target.parent.mkdir(parents=True, exist_ok=True)
    digest = hashlib.sha256(str(target).lower().encode("utf-8")).hexdigest()[:24]
    lock_path = Path(str(target) + ".lock")
    deadline = time.monotonic() + 1.5
    descriptor: Optional[int] = None
    while descriptor is None:
        try:
            descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
        except FileExistsError:
            if time.monotonic() >= deadline:
                raise TimeoutError("Timed out acquiring timesheet lock.")
            try:
                if time.time() - lock_path.stat().st_mtime > 30:
                    lock_path.unlink()
            except FileNotFoundError:
                pass
            time.sleep(0.02)
    try:
        with target.open("a", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(event, separators=(",", ":"), ensure_ascii=False) + "\n")
    finally:
        try:
            os.close(descriptor)
        finally:
            try:
                lock_path.unlink()
            except FileNotFoundError:
                pass


def binding_state(receipt: Dict[str, Any]) -> str:
    effective = receipt.get("effective_model")
    requested = receipt.get("requested_model")
    if effective and requested:
        return "VERIFIED" if effective == requested else "MISMATCH"
    if receipt.get("status") in ("skipped_limit_exhausted", "available"):
        return "CONFIG_PINNED" if requested else "UNVERIFIED"
    if receipt.get("binding_proof", "").startswith("explicit-model-argument"):
        return "CONFIG_PINNED"
    return "UNVERIFIED"


def spark_timesheet_event(root: Path, receipt: Dict[str, Any]) -> Dict[str, Any]:
    return {
        "schema_version": 3,
        "workflow": "orchestrate-development-v3",
        "orchestration_version": 3,
        "event": "spark_completed",
        "source": "orchestrated_spark_adapter",
        "recorded_at": utc_now(),
        "date": datetime.now().astimezone().date().isoformat(),
        "project": root.name,
        "project_root": str(root),
        "session_id": None,
        "turn_id": None,
        "call_id": receipt.get("call_id"),
        "started_at": receipt.get("started_at"),
        "ended_at": receipt.get("completed_at"),
        "requested_model": receipt.get("requested_model"),
        "requested_effort": None,
        "effective_model": receipt.get("effective_model"),
        "model": receipt.get("effective_model"),
        "effective_effort": None,
        "binding_state": binding_state(receipt),
        "parent_session_id": os.getenv("CODEX_SESSION_ID"),
        "root_session_id": receipt.get("root_session_id"),
        "role": "SPARK_TOOL",
        "route": "SPARK_TOOL",
        "stage_id": receipt.get("stage_id"),
        "goal_id": receipt.get("invoker_goal"),
        "lifetime": None,
        "invoker_goal": receipt.get("invoker_goal"),
        "interaction_class": "SPARK",
        "usage_scope": "spark_call",
        "usage_source": "adapter",
        "usage_additive": True,
        "event_id": "spark-" + str(receipt.get("call_id")),
        "observed_model": receipt.get("effective_model"),
        "turn_usage": None,
        "goal_usage": receipt.get("usage"),
        "session_usage": None,
        "token_usage": receipt.get("usage"),
        "usage_kind": "adapter_delta",
        "outcome": receipt.get("status"),
        "status": receipt.get("status"),
        "validation_status": receipt.get("validation_status", "UNVERIFIED"),
        "fallback": receipt.get("fallback"),
        "wall_time_seconds": receipt.get("wall_time_seconds"),
        "exit_code": receipt.get("exit_code"),
        "platform_adapter": receipt.get("platform_adapter"),
    }


def record_completed_attempt(root: Path, receipt: Dict[str, Any], receipt_path: Optional[Path], *, skip_ledger: bool = False) -> None:
    timesheet_path = Path(os.environ["CODEX_TIMESHEET_PATH"]) if os.getenv("CODEX_TIMESHEET_PATH") else Path(os.getenv("CODEX_HOME") or Path.home() / ".codex") / "timesheets" / ("events-" + datetime.now(timezone.utc).strftime("%Y-%m") + ".jsonl")
    try:
        append_timesheet_event(timesheet_path, spark_timesheet_event(root, receipt))
        receipt["telemetry_write_status"] = "written"
    except (OSError, TimeoutError, ValueError) as exc:
        receipt["telemetry_write_status"] = "failed:" + type(exc).__name__
    if receipt_path is not None:
        save_receipt(receipt, receipt_path)
    if not skip_ledger:
        update_spark_ledger(root, receipt)
    emit_receipt(receipt)


def update_spark_ledger(root: Path, receipt: Dict[str, Any]) -> None:
    root_session_id = receipt.get("root_session_id")
    path = state_path(root, str(root_session_id)) if root_session_id else None
    if path is None:
        return

    def apply(state: Optional[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
        if state is None:
            return None
        spark = state.setdefault("spark", {})
        spark["calls"] = list(spark.get("calls") or []) + [receipt]
        status = receipt.get("status")
        if status in ("limit_exhausted", "skipped_limit_exhausted"):
            spark.update({"availability": "limited", "limit_state": "exhausted", "limit_bucket": receipt.get("limit_bucket")})
        elif status in ("available", "verified", "returned_untrusted"):
            spark["availability"] = "available"
            if spark.get("limit_state") != "exhausted":
                spark.update({"limit_state": "available", "limit_bucket": None})
        add_event(state, "SPARK_CALL", call_id=receipt.get("call_id"), status=status, fallback=receipt.get("fallback"))
        return state

    update_state(path, apply)


def emit_receipt(receipt: Dict[str, Any]) -> None:
    print("SPARK_RECEIPT " + json.dumps(receipt, separators=(",", ":"), ensure_ascii=False))


def call_id_now() -> str:
    timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S%f")[:-3]
    return "spark-" + timestamp + "-" + uuid.uuid4().hex[:6]


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("LauncherProbe", "ModelProbe", "Run"), default="Run")
    parser.add_argument("--prompt-file")
    parser.add_argument("--working-directory", default=str(Path.cwd()))
    parser.add_argument("--sandbox", choices=("read-only", "workspace-write"), default="workspace-write")
    parser.add_argument("--invoker-goal", default="unknown")
    parser.add_argument("--root-session-id", required=True)
    parser.add_argument("--owned-path", action="append", default=[])
    parser.add_argument("--call-id")
    parser.add_argument("--receipt-path")
    parser.add_argument("--telemetry-fixture", action="store_true", help=argparse.SUPPRESS)
    return parser.parse_args()


def main() -> int:
    args = parse_args()
    root = project_root(args.working_directory)
    working_root = path_inside(args.working_directory, root, must_exist=True)
    call_id = args.call_id or call_id_now()
    if not re.fullmatch(r"[A-Za-z0-9_.-]+", call_id):
        raise ValueError("Call ID may contain only letters, digits, dot, underscore, and hyphen.")
    artifact_root = root / ".scratch" / "orchestration-spark" / call_id
    artifact_root.mkdir(parents=True, exist_ok=True)
    receipt_path = path_inside(args.receipt_path, root) if args.receipt_path else artifact_root / "receipt.json"
    owned_paths = [str(path_inside(item, root)) for item in args.owned_path]

    if args.telemetry_fixture:
        now = utc_now()
        receipt = {
            "call_id": call_id, "mode": args.mode, "status": "fixture_completed",
            "requested_model": MODEL, "effective_model": MODEL,
            "binding_proof": "test-fixture-exposed-model", "invoker_goal": args.invoker_goal, "root_session_id": args.root_session_id,
            "started_at": now, "completed_at": now, "wall_time_seconds": 0,
            "exit_code": 0, "usage": {"input_tokens": 7, "output_tokens": 3, "total_tokens": 10},
            "validation_status": "PASSED", "fallback": None, "task_should_continue": True,
            "platform_adapter": "python3-posix",
        }
        record_completed_attempt(root, receipt, receipt_path, skip_ledger=True)
        return 0

    active_path = state_path(root, args.root_session_id)
    if not active_path.is_file():
        active_path = None
    active_state = read_state(active_path) if active_path else None
    if active_state and (active_state.get("spark") or {}).get("limit_state") == "exhausted" and args.mode != "LauncherProbe":
        now = utc_now()
        receipt = {
            "call_id": call_id,
            "mode": args.mode,
            "status": "skipped_limit_exhausted",
            "requested_model": MODEL,
            "binding_proof": "not-attempted-current-run-limit-receipt",
            "sandbox": args.sandbox,
            "invoker_goal": args.invoker_goal,
            "root_session_id": args.root_session_id,
            "owned_paths": owned_paths,
            "started_at": now,
            "completed_at": now,
            "wall_time_seconds": 0,
            "exit_code": 0,
            "turn_completed": False,
            "usage": None,
            "limit_bucket": (active_state.get("spark") or {}).get("limit_bucket"),
            "fallback": "LUNA",
            "task_should_continue": True,
            "acceptance_owner": "ROOT_ORCHESTRATOR",
            "economic_cost_assumption": 0,
            "artifact_directory": str(artifact_root),
            "platform_adapter": "python3-posix",
        }
        record_completed_attempt(root, receipt, receipt_path)
        return 0

    launcher = shutil.which("codex")
    if not launcher:
        now = utc_now()
        receipt = {
            "call_id": call_id,
            "mode": args.mode,
            "status": "launch_or_output_failed",
            "requested_model": MODEL,
            "binding_proof": "launcher-not-found-in-path",
            "sandbox": args.sandbox,
            "invoker_goal": args.invoker_goal,
            "root_session_id": args.root_session_id,
            "owned_paths": owned_paths,
            "started_at": now,
            "completed_at": now,
            "wall_time_seconds": 0,
            "exit_code": None,
            "turn_completed": False,
            "usage": None,
            "limit_bucket": None,
            "fallback": "LUNA",
            "task_should_continue": True,
            "acceptance_owner": "ROOT_ORCHESTRATOR",
            "economic_cost_assumption": 0,
            "artifact_directory": str(artifact_root),
            "platform_adapter": "python3-posix",
        }
        record_completed_attempt(root, receipt, receipt_path)
        return 0

    started_at = utc_now()
    started_clock = time.monotonic()
    events_path = artifact_root / "events.jsonl"
    stderr_path = artifact_root / "stderr.txt"
    last_message_path = artifact_root / "last-message.txt"
    exit_code = 0
    turn_completed = False
    usage = None
    effective_model = None
    combined_output = ""
    sandbox = args.sandbox

    if args.mode == "LauncherProbe":
        result = subprocess.run([launcher, "--version"], capture_output=True, text=True, check=False)
        exit_code = result.returncode
        combined_output = (result.stdout or "") + (result.stderr or "")
        last_message_path.write_text(combined_output, encoding="utf-8")
    else:
        if args.mode == "ModelProbe":
            prompt_text = "Return exactly SPARK_MODEL_OK. Do not inspect or modify files, plan, create a Goal, invoke skills, or delegate."
            sandbox = "read-only"
        else:
            if not args.prompt_file:
                raise ValueError("Run mode requires --prompt-file.")
            prompt_path = path_inside(args.prompt_file, root, must_exist=True)
            prompt_bytes = prompt_path.stat().st_size
            if prompt_bytes > 131072:
                raise ValueError("Spark prompt exceeds the 128 KiB adapter envelope: " + str(prompt_bytes) + " bytes.")
            task_prompt = prompt_path.read_text(encoding="utf-8")
            prompt_text = (
                "You are Spark acting as a bounded deterministic tool under the v3 root or implementation worker, or as a read-only lookup for Terra.\n"
                "Execute exactly the supplied deterministic operation. Do not create a Goal or plan, invoke skills, delegate, redesign, broaden scope, or perform final acceptance. Stop without changes on ambiguity, missing context, risk, or scope expansion. Return only result, changed paths, validation attempted, and uncertainty.\n\n"
                + task_prompt
            )
        command = [
            launcher,
            "exec",
            "--ephemeral",
            "--ignore-user-config",
            "--json",
            "--disable",
            "hooks",
            "--model",
            MODEL,
            "--sandbox",
            sandbox,
            "--cd",
            str(working_root),
            "--config",
            'model_reasoning_summary="none"',
            "--config",
            "model_supports_reasoning_summaries=false",
            "--output-last-message",
            str(last_message_path),
            "-",
        ]
        with events_path.open("w", encoding="utf-8", newline="\n") as stdout_handle, stderr_path.open("w", encoding="utf-8", newline="\n") as stderr_handle:
            process = subprocess.Popen(command, stdin=subprocess.PIPE, stdout=stdout_handle, stderr=stderr_handle, text=True)
            process.communicate(prompt_text)
            exit_code = process.returncode
        event_lines = events_path.read_text(encoding="utf-8").splitlines() if events_path.is_file() else []
        for line in event_lines:
            try:
                parsed = json.loads(line)
                if isinstance(parsed, dict) and parsed.get("type") == "turn.completed":
                    turn_completed = True
                    if parsed.get("usage") is not None:
                        usage = parsed.get("usage")
                if isinstance(parsed, dict) and isinstance(parsed.get("model"), str):
                    effective_model = parsed.get("model")
            except json.JSONDecodeError:
                continue
        combined_output = "\n".join(event_lines)
        if stderr_path.is_file():
            combined_output += "\n" + stderr_path.read_text(encoding="utf-8", errors="replace")
        if last_message_path.is_file():
            combined_output += "\n" + last_message_path.read_text(encoding="utf-8", errors="replace")

    wall_time = round(time.monotonic() - started_clock, 3)
    completed_at = utc_now()
    exhausted, bucket = limit_info(combined_output)
    last_message = last_message_path.read_text(encoding="utf-8", errors="replace").strip() if last_message_path.is_file() else ""
    if exhausted:
        status, fallback, proof = "limit_exhausted", "LUNA", "limit-response-from-spark-route"
    elif args.mode == "LauncherProbe" and exit_code == 0:
        status, fallback, proof = "available", None, "codex-launcher-version"
    elif args.mode == "ModelProbe" and exit_code == 0 and turn_completed and last_message == "SPARK_MODEL_OK":
        status, fallback, proof = "verified", None, "explicit-model-argument+turn.completed+expected-marker"
    elif args.mode == "Run" and exit_code == 0 and turn_completed and last_message:
        status, fallback, proof = "returned_untrusted", None, "explicit-model-argument+turn.completed"
    else:
        status, fallback, proof = "launch_or_output_failed", "LUNA", "failed-or-incomplete"

    receipt = {
        "call_id": call_id,
        "mode": args.mode,
        "status": status,
        "requested_model": MODEL,
        "effective_model": effective_model,
        "binding_proof": proof,
        "sandbox": sandbox,
        "invoker_goal": args.invoker_goal,
        "root_session_id": args.root_session_id,
        "owned_paths": owned_paths,
        "started_at": started_at,
        "completed_at": completed_at,
        "wall_time_seconds": wall_time,
        "exit_code": exit_code,
        "turn_completed": turn_completed,
        "usage": usage,
        "limit_bucket": bucket,
        "fallback": fallback,
        "task_should_continue": True,
        "acceptance_owner": "ROOT_ORCHESTRATOR",
        "economic_cost_assumption": 0,
        "artifact_directory": str(artifact_root),
        "last_message_path": str(last_message_path),
        "platform_adapter": "python3-posix",
        "validation_status": "PASSED" if status == "verified" else ("NOT_APPLICABLE" if status == "available" else "UNVERIFIED"),
    }
    record_completed_attempt(root, receipt, receipt_path)
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, TimeoutError) as exc:
        failure = {
            "call_id": None,
            "mode": None,
            "status": "adapter_error",
            "requested_model": MODEL,
            "fallback": "LUNA",
            "task_should_continue": True,
            "error": str(exc),
            "platform_adapter": "python3-posix",
        }
        try:
            failure_root = project_root(str(Path.cwd()))
            failure["started_at"] = failure["completed_at"] = utc_now()
            failure["wall_time_seconds"] = None
            failure["exit_code"] = 2
            failure["usage"] = None
            failure["invoker_goal"] = "unknown"
            failure["validation_status"] = "NOT_RUN"
            record_completed_attempt(failure_root, failure, None)
        except Exception:
            failure["telemetry_write_status"] = "failed:unavailable"
            emit_receipt(failure)
        raise SystemExit(2)
