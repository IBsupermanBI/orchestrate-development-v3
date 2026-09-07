#!/usr/bin/env python3
"""Read-only Windows/macOS/Linux preflight for the portable orchestration runtime."""

from __future__ import annotations

import argparse
import json
import platform
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any, Dict, Optional

sys.dont_write_bytecode = True

from orchestration_state import project_root


def command_receipt(name: str) -> Dict[str, Any]:
    launcher = shutil.which(name)
    if not launcher:
        return {"path": None, "launch": "missing", "version": None}
    try:
        result = subprocess.run([launcher, "--version"], capture_output=True, text=True, timeout=10, check=False)
        output = ((result.stdout or "") + (result.stderr or "")).strip().splitlines()
        return {
            "path": launcher,
            "launch": "proven" if result.returncode == 0 else "blocked",
            "version": output[0] if output else None,
        }
    except (OSError, subprocess.TimeoutExpired) as exc:
        return {"path": launcher, "launch": "blocked", "version": None, "error": str(exc)}


def load_json(path: Path) -> Optional[Dict[str, Any]]:
    if not path.is_file():
        return None
    try:
        with path.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
        return value if isinstance(value, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--working-directory", default=str(Path.cwd()))
    args = parser.parse_args()
    root = project_root(args.working_directory)
    skill_root = Path(__file__).resolve().parent.parent
    manifest_path = skill_root / "install-manifest.json"
    active_path = root / ".codex" / "hooks.json"
    manifest = load_json(manifest_path)
    active = load_json(active_path)
    if active is None:
        active_state = "missing" if not active_path.exists() else "invalid-json"
    else:
        active_state = "present-custom-or-merged"
    hook_asset = manifest.get("hook_asset") if manifest else None
    git = command_receipt("git")
    codex = command_receipt("codex")
    python_ready = sys.version_info >= (3, 8)
    receipt = {
        "platform": platform.system().lower(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "python_ready": python_ready,
        "project_root": str(root),
        "git": git,
        "codex": codex,
        "hook_template": "not-published" if hook_asset is None else "published",
        "project_hook": active_state,
        "ready_for_hook_scripts": python_ready and git.get("launch") == "proven",
        "ready_for_spark_probe": python_ready and git.get("launch") == "proven" and codex.get("launch") == "proven",
        "fallback": None if codex.get("launch") == "proven" else "LUNA",
        "mutations": False,
    }
    print("PORTABILITY_RECEIPT " + json.dumps(receipt, separators=(",", ":"), ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
