#!/usr/bin/env python3
"""Summarize collected CHZZK telemetry for the automatic update operator loop."""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
from pathlib import Path
from typing import Any

DEFAULT_STATE_DIR = Path("/var/lib/chzzk-telemetry")


def parse_since(value: str) -> dt.datetime:
    if value.startswith("-") and value.endswith("h"):
        return dt.datetime.now(dt.UTC) - dt.timedelta(hours=int(value[1:-1]))
    if value.startswith("-") and value.endswith("d"):
        return dt.datetime.now(dt.UTC) - dt.timedelta(days=int(value[1:-1]))
    return dt.datetime.fromisoformat(value.replace("Z", "+00:00"))


def load_reports(state_dir: Path, since: dt.datetime) -> list[dict[str, Any]]:
    reports: list[dict[str, Any]] = []
    for path in sorted(state_dir.glob("reports-*.ndjson")):
        for line in path.read_text(encoding="utf-8").splitlines():
            if not line.strip():
                continue
            try:
                report = json.loads(line)
                received = dt.datetime.fromisoformat(str(report.get("receivedAt", "")).replace("Z", "+00:00"))
            except Exception:
                continue
            if received >= since:
                reports.append(report)
    return reports


def summarize(reports: list[dict[str, Any]]) -> dict[str, Any]:
    event_types = collections.Counter(str(report.get("eventType")) for report in reports)
    versions = collections.Counter(str(report.get("extensionVersion")) for report in reports)
    qualities: collections.Counter[str] = collections.Counter()
    decisions: collections.Counter[str] = collections.Counter()
    structure_hashes: collections.Counter[str] = collections.Counter()
    last_errors: list[str] = []
    class_tokens: collections.Counter[str] = collections.Counter()

    for report in reports:
        raw_diagnostics = report.get("diagnostics")
        diagnostics: dict[str, Any] = raw_diagnostics if isinstance(raw_diagnostics, dict) else {}
        qualities.update({k: int(v) for k, v in (diagnostics.get("qualities") or {}).items()})
        decisions.update({k: int(v) for k, v in (diagnostics.get("decisionsByReason") or {}).items()})
        raw_session_rules = diagnostics.get("sessionRules")
        session_rules: dict[str, Any] = raw_session_rules if isinstance(raw_session_rules, dict) else {}
        if session_rules.get("lastError"):
            last_errors.append(str(session_rules["lastError"])[:300])

        raw_structure = report.get("structure")
        structure: dict[str, Any] = raw_structure if isinstance(raw_structure, dict) else {}
        if structure.get("structureHash"):
            structure_hashes[str(structure["structureHash"])] += 1
        for item in structure.get("classSummary") or []:
            if isinstance(item, dict) and item.get("token"):
                class_tokens[str(item["token"])] += int(item.get("count") or 1)

    return {
        "decisionReasons": decisions.most_common(30),
        "eventTypes": event_types.most_common(30),
        "lastErrors": last_errors[-20:],
        "observedQualities": qualities.most_common(30),
        "reportCount": len(reports),
        "structureHashes": structure_hashes.most_common(20),
        "topClassTokens": class_tokens.most_common(50),
        "versions": versions.most_common(20),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    parser.add_argument("--since", default="-24h")
    args = parser.parse_args()
    data = summarize(load_reports(args.state_dir, parse_since(args.since)))
    print(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
