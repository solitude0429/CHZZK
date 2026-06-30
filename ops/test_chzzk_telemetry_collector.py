#!/usr/bin/env python3
from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

MODULE_PATH = Path(__file__).with_name("chzzk-telemetry-collector.py")
spec = importlib.util.spec_from_file_location("chzzk_telemetry_collector", MODULE_PATH)
collector = importlib.util.module_from_spec(spec)
assert spec.loader is not None
spec.loader.exec_module(collector)


def safe_report() -> dict:
    return {
        "addonId": "chzzk@solitude0429.local",
        "eventType": "diagnostics-summary",
        "extensionVersion": "0.0.5",
        "schemaVersion": 1,
        "scope": "chzzk-live",
        "sentAt": "2026-01-01T00:00:00Z",
    }


class CollectorTests(unittest.TestCase):
    def setUp(self) -> None:
        collector.RATE_LIMIT_STATE.clear()

    def test_sanitize_report_rejects_signed_query_values(self) -> None:
        report = safe_report()
        report["diagnostics"] = {
            "samples": [{"url": "https://cdn.example/live/chunklist_720p.m3u8?Policy=secret"}],
        }
        with self.assertRaisesRegex(ValueError, "sensitive"):
            collector.sanitize_report(report)

    def test_sanitize_report_accepts_redacted_structure_summary(self) -> None:
        report = safe_report()
        report["structure"] = {
            "classSummary": [{"count": 2, "token": "live_area"}],
            "featureCounts": {"video": 1},
            "routeShape": "/live/[redacted]",
            "selectorSample": ["div.live_area"],
            "structureHash": "abc123",
            "tagCounts": {"div": 12},
        }
        clean = collector.sanitize_report(report)
        self.assertEqual(clean["structure"]["routeShape"], "/live/[redacted]")
        self.assertNotIn("Policy=", json.dumps(clean))

    def test_rate_limiter_blocks_after_limit(self) -> None:
        self.assertFalse(collector.is_rate_limited("127.0.0.1", now=10, window_seconds=60, max_reports=2))
        self.assertFalse(collector.is_rate_limited("127.0.0.1", now=11, window_seconds=60, max_reports=2))
        self.assertTrue(collector.is_rate_limited("127.0.0.1", now=12, window_seconds=60, max_reports=2))
        self.assertFalse(collector.is_rate_limited("127.0.0.1", now=80, window_seconds=60, max_reports=2))

    def test_atomic_append_writes_single_lines(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "reports.ndjson"
            collector.atomic_append(path, '{"ok": true}')
            collector.atomic_append(path, '{"ok": false}')
            self.assertEqual(path.read_text(encoding="utf-8").splitlines(), ['{"ok": true}', '{"ok": false}'])


if __name__ == "__main__":
    unittest.main()
