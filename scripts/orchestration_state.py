#!/usr/bin/env python3
"""Dependency-free shared state helpers for macOS/Linux orchestration scripts."""

from __future__ import annotations

import json
import os
import re
import shutil
import subprocess
import time
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Dict, Iterator, List, Optional


ROUTES = {
    "SOL_REVIEWER": ("gpt-5.6-sol", "medium"),
    "LUNA_VALIDATOR": ("gpt-5.6-luna", "xhigh"),
    "ASTRA_WORKER": ("gpt-6-astra", "low"),
    "LUNA_WORKER": ("gpt-5.6-luna", "xhigh"),
    "TERRA_GATE": ("gpt-5.6-terra", "high"),
}
PROFILES = {
    "v3-sol-medium-reviewer": ("SOL_REVIEWER", "gpt-5.6-sol", "medium"),
    "v3-luna-xhigh-validator": ("LUNA_VALIDATOR", "gpt-5.6-luna", "xhigh"),
    "astra-low-worker": ("ASTRA_WORKER", "gpt-6-astra", "low"),
    "luna-xhigh-worker": ("LUNA_WORKER", "gpt-5.6-luna", "xhigh"),
    "terra-high-gate": ("TERRA_GATE", "gpt-5.6-terra", "high"),
}
TERMINAL_TASK_STATES = {"ACCEPTED", "REJECTED", "RETIRED", "ARCHIVED"}


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat()


def project_root(cwd: str) -> Path:
    resolved = Path(cwd).expanduser().resolve()
    git = shutil.which("git")
    if git:
        try:
            result = subprocess.run(
                [git, "-C", str(resolved), "rev-parse", "--show-toplevel"],
                capture_output=True,
                text=True,
                timeout=5,
                check=False,
            )
            if result.returncode == 0 and result.stdout.strip():
                return Path(result.stdout.strip()).resolve()
        except (OSError, subprocess.TimeoutExpired):
            pass
    return resolved


def safe_name(value: str) -> str:
    return re.sub(r"[^A-Za-z0-9_.-]", "_", value)


def state_directory(root: Path) -> Path:
    return root / ".scratch" / "orchestration-hooks"


def state_path(root: Path, session_id: str) -> Path:
    return state_directory(root) / ("state-orchestrate-development-v3-" + safe_name(session_id) + ".json")


def read_state(path: Path) -> Optional[Dict[str, Any]]:
    if not path.is_file():
        return None
    with path.open("r", encoding="utf-8") as handle:
        value = json.load(handle)
    if not isinstance(value, dict):
        raise ValueError("Orchestration state must be a JSON object: " + str(path))
    return value


def write_state(path: Path, state: Dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    state["updated_at"] = utc_now()
    temporary = path.with_name(path.name + "." + str(os.getpid()) + ".tmp")
    with temporary.open("w", encoding="utf-8", newline="\n") as handle:
        json.dump(state, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, path)


@contextmanager
def state_lock(path: Path, timeout_seconds: float = 10.0) -> Iterator[None]:
    """Shared exclusive lock-file protocol with the standalone Node guard."""

    lock_path = path.with_name(path.name + ".lock")
    deadline = time.monotonic() + timeout_seconds
    acquired = False
    while not acquired:
        try:
            lock_path.parent.mkdir(parents=True, exist_ok=True)
            descriptor = os.open(lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
            acquired = True
        except FileExistsError:
            try:
                age = time.time() - lock_path.stat().st_mtime
                if age > 30:
                    lock_path.unlink()
                    continue
            except (FileNotFoundError, OSError):
                pass
            if time.monotonic() >= deadline:
                raise TimeoutError("Timed out waiting for orchestration state lock: " + str(path))
            time.sleep(0.05)
    try:
        yield
    finally:
        os.close(descriptor)
        try:
            lock_path.unlink()
        except FileNotFoundError:
            pass


def update_state(
    path: Path, update: Callable[[Optional[Dict[str, Any]]], Optional[Dict[str, Any]]]
) -> Optional[Dict[str, Any]]:
    with state_lock(path):
        current = read_state(path)
        changed = update(current)
        state = changed if changed is not None else current
        if state is not None:
            write_state(path, state)
        return state


def new_state(session_id: str, root: Path, permission_mode: str = "unknown") -> Dict[str, Any]:
    now = utc_now()
    return {
        "schema_version": 3,
        "skill": "orchestrate-development-v3",
        "workflow": "orchestrate-development-v3",
        "orchestration_version": 3,
        "session_id": session_id,
        "root_session_id": session_id,
        "project_root": str(root),
        "permission_mode": permission_mode,
        "active": True,
        "phase": "ARMED",
        "created_at": now,
        "updated_at": now,
        "tasks": {},
        "closeout": {
            "ready": False,
            "heavy_validation": "unknown",
            "plan_synchronized": False,
            "docs_state": "unknown",
        },
        "spark": {
            "availability": "unknown",
            "limit_state": "unknown",
            "limit_bucket": None,
            "calls": [],
        },
        "events": [],
    }


def normalized_task_metadata(
    role: str, model: str, effort: str, lifetime: str, profile: str = "", native_depth: int = 1
) -> Dict[str, Any]:
    if lifetime not in ("LEAF", "PROCESS"):
        raise ValueError("Unsupported task lifetime: " + lifetime)
    if native_depth != 1:
        raise ValueError("V3 native workers must be direct root children at depth 1.")
    if lifetime == "PROCESS" and role not in ("ASTRA_WORKER", "LUNA_WORKER"):
        raise ValueError("PROCESS requires ASTRA_WORKER or LUNA_WORKER.")
    pinned = PROFILES.get(profile)
    if pinned:
        pinned_role, pinned_model, pinned_effort = pinned
        if role != pinned_role or (model not in ("", "unknown", pinned_model)) or (effort not in ("", "unknown", pinned_effort)):
            raise ValueError("Pinned profile does not match requested role/model/effort.")
        return {"role": role, "model": pinned_model, "effort": pinned_effort, "profile": profile, "binding_state": "CONFIG_PINNED"}
    raise ValueError("Exact known profile required; generic workers cannot substitute pinned routes.")


def task_can_delegate(state: Dict[str, Any], parent_task_id: Optional[str]) -> tuple[bool, str, int]:
    if not parent_task_id:
        active = [task for task in get_tasks(state) if task.get("parent_task_id") is None and task.get("state") not in TERMINAL_TASK_STATES]
        return (len(active) < 5, "root active-child ceiling reached", 1)
    return (False, "v3 workers cannot create native subagents", 0)


def get_task(state: Dict[str, Any], task_id: str) -> Optional[Dict[str, Any]]:
    tasks = state.get("tasks") or {}
    value = tasks.get(task_id)
    return value if isinstance(value, dict) else None


def set_task(state: Dict[str, Any], task_id: str, task: Dict[str, Any]) -> None:
    tasks = state.setdefault("tasks", {})
    tasks[task_id] = task


def get_tasks(state: Dict[str, Any]) -> List[Dict[str, Any]]:
    tasks = state.get("tasks") or {}
    return [value for value in tasks.values() if isinstance(value, dict)]


def add_event(state: Dict[str, Any], event_type: str, **data: Any) -> None:
    entry = {"at": utc_now(), "type": event_type}
    entry.update(data)
    events = list(state.get("events") or [])
    events.append(entry)
    state["events"] = events[-200:]


def latest_active_state_path(root: Path) -> Optional[Path]:
    directory = state_directory(root)
    if not directory.is_dir():
        return None
    candidates = []
    for path in directory.glob("state-*.json"):
        try:
            state = read_state(path)
            if state and state.get("active") is True and state.get("skill") == "orchestrate-development-v3":
                candidates.append((path.stat().st_mtime_ns, path))
        except (OSError, ValueError, json.JSONDecodeError):
            continue
    if not candidates:
        return None
    return max(candidates, key=lambda item: item[0])[1]
