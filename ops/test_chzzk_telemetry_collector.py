#!/usr/bin/env python3
from __future__ import annotations

import datetime as dt
import hashlib
import hmac
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

SECRET = b"test-secret"
INSTALL_ID = "test-install"


def safe_report() -> dict:
    return {
        "addonId": "chzzk@solitude0429.local",
        "auth": {"scheme": collector.AUTH_SCHEME},
        "eventType": "diagnostics-summary",
        "extensionVersion": "0.0.8",
        "installId": INSTALL_ID,
        "schemaVersion": 1,
        "scope": "chzzk-live",
        "sentAt": "2026-01-01T00:00:00Z",
    }


class CollectorTests(unittest.TestCase):
    def setUp(self) -> None:
        collector.CLIENT_RATE_LIMIT_STATE.clear()

    def test_sanitize_report_redacts_signed_query_values(self) -> None:
        report = safe_report()
        report["diagnostics"] = {
            "samples": [{"url": "https://user:pass@cdn.example/live/chunklist_720p.m3u8?Policy=secret"}],
        }
        clean = collector.sanitize_report(report, install_id=INSTALL_ID, secret=SECRET)
        serialized = json.dumps(clean)
        self.assertIn("https://cdn.example/[redacted-path]/720p.m3u8", serialized)
        self.assertNotIn("Policy=", serialized)
        self.assertNotIn("user:pass", serialized)
        self.assertNotIn(INSTALL_ID, serialized)
        self.assertIn("installIdHash", clean)

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
        clean = collector.sanitize_report(report, install_id=INSTALL_ID, secret=SECRET)
        self.assertEqual(clean["structure"]["routeShape"], "/live/[redacted]")
        self.assertNotIn("Policy=", json.dumps(clean))

    def test_verify_request_auth_accepts_matching_signature(self) -> None:
        body = json.dumps(safe_report(), separators=(",", ":")).encode()
        timestamp = dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z")
        signature = hmac.new(SECRET, timestamp.encode("utf-8") + b"." + body, hashlib.sha256).hexdigest()
        headers = {
            "x-chzzk-telemetry-install-id": INSTALL_ID,
            "x-chzzk-telemetry-signature": f"v1={signature}",
            "x-chzzk-telemetry-timestamp": timestamp,
        }
        self.assertEqual(collector.verify_request_auth(headers, body, SECRET), INSTALL_ID)

    def test_rate_limiter_blocks_after_limit(self) -> None:
        self.assertFalse(collector.is_client_rate_limited("127.0.0.1", now=10, window_seconds=60, max_reports=2))
        self.assertFalse(collector.is_client_rate_limited("127.0.0.1", now=11, window_seconds=60, max_reports=2))
        self.assertTrue(collector.is_client_rate_limited("127.0.0.1", now=12, window_seconds=60, max_reports=2))
        self.assertFalse(collector.is_client_rate_limited("127.0.0.1", now=80, window_seconds=60, max_reports=2))

    def test_atomic_append_writes_single_lines(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "reports.ndjson"
            collector.atomic_append(path, '{"ok": true}')
            collector.atomic_append(path, '{"ok": false}')
            self.assertEqual(path.read_text(encoding="utf-8").splitlines(), ['{"ok": true}', '{"ok": false}'])


if __name__ == "__main__":
    unittest.main()
