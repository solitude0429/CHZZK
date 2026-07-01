#!/usr/bin/env python3
"""Summarize collected CHZZK telemetry for the automatic update operator loop.

All report values are untrusted data. The summary emits bounded counters and error
categories only; it never forwards raw page error strings into operator context.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import os
import re
from pathlib import Path
from typing import Any

DEFAULT_STATE_DIR = Path("/var/lib/chzzk-telemetry")
DEFAULT_MAX_REPORTS = 10_000
ERROR_CATEGORY_RE = re.compile(r"^error:[a-z0-9-]{1,80}$")


def parse_since(value: str) -> dt.datetime:
    if value.startswith("-") and value.endswith("h"):
        return dt.datetime.now(dt.UTC) - dt.timedelta(hours=int(value[1:-1]))
    if value.startswith("-") and value.endswith("d"):
        return dt.datetime.now(dt.UTC) - dt.timedelta(days=int(value[1:-1]))
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.UTC)
    return parsed.astimezone(dt.UTC)


def iter_report_lines(state_dir: Path) -> Any:
    for path in sorted(state_dir.glob("reports-*.ndjson")):
        try:
            with path.open("r", encoding="utf-8") as handle:
                for line in handle:
                    yield line
        except OSError:
            continue


def load_reports(state_dir: Path, since: dt.datetime, *, max_reports: int = DEFAULT_MAX_REPORTS) -> list[dict[str, Any]]:
    reports: list[dict[str, Any]] = []
    for line in iter_report_lines(state_dir):
        if not line.strip():
            continue
        try:
            report = json.loads(line)
            received = dt.datetime.fromisoformat(str(report.get("receivedAt", "")).replace("Z", "+00:00"))
            if received.tzinfo is None:
                received = received.replace(tzinfo=dt.UTC)
            received = received.astimezone(dt.UTC)
        except Exception:
            continue
        if received >= since:
            reports.append(report)
            if len(reports) >= max_reports:
                break
    return reports


def safe_counter_items(counter: collections.Counter[str], limit: int) -> list[list[Any]]:
    return [[key, value] for key, value in counter.most_common(limit)]


def summarize(reports: list[dict[str, Any]]) -> dict[str, Any]:
    event_types: collections.Counter[str] = collections.Counter()
    versions: collections.Counter[str] = collections.Counter()
    qualities: collections.Counter[str] = collections.Counter()
    decisions: collections.Counter[str] = collections.Counter()
    structure_hashes: collections.Counter[str] = collections.Counter()
    error_categories: collections.Counter[str] = collections.Counter()
    class_tokens: collections.Counter[str] = collections.Counter()

    for report in reports:
        event_types[str(report.get("eventType"))[:80]] += 1
        versions[str(report.get("extensionVersion"))[:40]] += 1
        raw_diagnostics = report.get("diagnostics")
        diagnostics: dict[str, Any] = raw_diagnostics if isinstance(raw_diagnostics, dict) else {}
        qualities.update({str(k)[:40]: int(v) for k, v in (diagnostics.get("qualities") or {}).items()})
        decisions.update({str(k)[:80]: int(v) for k, v in (diagnostics.get("decisionsByReason") or {}).items()})
        raw_session_rules = diagnostics.get("sessionRules")
        session_rules: dict[str, Any] = raw_session_rules if isinstance(raw_session_rules, dict) else {}
        last_error = str(session_rules.get("lastError") or "")[:80]
        if ERROR_CATEGORY_RE.fullmatch(last_error):
            error_categories[last_error] += 1
        elif last_error:
            error_categories["error:other-redacted"] += 1

        raw_structure = report.get("structure")
        structure: dict[str, Any] = raw_structure if isinstance(raw_structure, dict) else {}
        if structure.get("structureHash"):
            structure_hashes[str(structure["structureHash"])[:32]] += 1
        for item in structure.get("classSummary") or []:
            if isinstance(item, dict) and item.get("token"):
                class_tokens[str(item["token"])[:80]] += min(max(int(item.get("count") or 1), 0), 100_000)

    return {
        "decisionReasons": safe_counter_items(decisions, 30),
        "errorCategories": safe_counter_items(error_categories, 20),
        "eventTypes": safe_counter_items(event_types, 30),
        "observedQualities": safe_counter_items(qualities, 30),
        "reportCount": len(reports),
        "structureHashes": safe_counter_items(structure_hashes, 20),
        "topClassTokens": safe_counter_items(class_tokens, 50),
        "untrustedValuesAreDataOnly": True,
        "versions": safe_counter_items(versions, 20),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--max-reports", type=int, default=int(os.environ.get("CHZZK_TELEMETRY_SUMMARY_MAX_REPORTS", DEFAULT_MAX_REPORTS)))
    parser.add_argument("--since", default="-24h")
    parser.add_argument("--state-dir", type=Path, default=DEFAULT_STATE_DIR)
    args = parser.parse_args()
    data = summarize(load_reports(args.state_dir, parse_since(args.since), max_reports=args.max_reports))
    print(json.dumps(data, ensure_ascii=False, indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
