#!/usr/bin/env python3
"""Emit actionable CHZZK telemetry context for the Hermes auto-update operator.

Prints NO_ACTION when no new telemetry summary is available. The Hermes cron prompt
uses this output to decide whether to patch/release or stay quiet.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import subprocess
from pathlib import Path
from typing import Any

DEFAULT_SUMMARY = "/usr/local/sbin/chzzk-telemetry-summary"
DEFAULT_REPO = "/tmp/chzzk"
DEFAULT_STATE = Path.home() / ".hermes" / "state" / "chzzk-telemetry-auto-loop.json"


def run_json(command: list[str]) -> dict[str, Any]:
    result = subprocess.run(command, check=True, text=True, capture_output=True)
    return json.loads(result.stdout)


def git_output(repo: str, args: list[str]) -> str | None:
    try:
        result = subprocess.run(["git", "-C", repo, *args], check=True, text=True, capture_output=True)
        return result.stdout.strip()
    except Exception:
        return None


def load_state(path: Path) -> dict[str, Any]:
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except Exception:
        return {}


def save_state(path: Path, state: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(state, indent=2, sort_keys=True), encoding="utf-8")


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--since", default="-6h")
    parser.add_argument("--repo", default=DEFAULT_REPO)
    parser.add_argument("--summary-cmd", default=DEFAULT_SUMMARY)
    parser.add_argument("--state", type=Path, default=DEFAULT_STATE)
    args = parser.parse_args()

    summary = run_json(["sudo", args.summary_cmd, f"--since={args.since}"])
    if int(summary.get("reportCount") or 0) <= 0:
        print("NO_ACTION")
        return 0

    digest = hashlib.sha256(json.dumps(summary, sort_keys=True).encode("utf-8")).hexdigest()
    state = load_state(args.state)
    if state.get("lastDigest") == digest:
        print("NO_ACTION")
        return 0

    state["lastDigest"] = digest
    save_state(args.state, state)

    payload = {
        "action": "review_chzzk_telemetry_and_update_if_safe",
        "currentBranch": git_output(args.repo, ["branch", "--show-current"]),
        "mainCommit": git_output(args.repo, ["rev-parse", "origin/main"]),
        "repo": args.repo,
        "summary": summary,
        "updateHost": "https://chzzk-updates.alpha-apple.dedyn.io/updates.json",
        "collectorHealth": "https://chzzk-report.alpha-apple.dedyn.io/healthz",
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
