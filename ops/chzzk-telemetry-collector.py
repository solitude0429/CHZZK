#!/usr/bin/env python3
"""Minimal CHZZK telemetry collector for the private WireGuard-only update host.

The collector accepts sanitized reports from the CHZZK Firefox extension and stores
newline-delimited JSON under /var/lib/chzzk-telemetry. It intentionally has no
GitHub credentials and does not perform code changes by itself.
"""

from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import sys
import threading
import time
from http import HTTPStatus
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any

DEFAULT_BIND = "127.0.0.1"
DEFAULT_PORT = 18181
DEFAULT_STATE_DIR = Path("/var/lib/chzzk-telemetry")
MAX_BODY_BYTES = 64_000
RATE_LIMIT_WINDOW_SECONDS = int(os.environ.get("CHZZK_TELEMETRY_RATE_WINDOW_SECONDS", "60"))
RATE_LIMIT_MAX_REPORTS = int(os.environ.get("CHZZK_TELEMETRY_RATE_MAX_REPORTS", "120"))
SENSITIVE_RE = re.compile(r"[?&](Policy|Signature|Key-Pair-Id|Expires|token|auth|session)=", re.I)
HOST_RE = re.compile(r"^[a-z0-9_.:@-]+$", re.I)
WRITE_LOCK = threading.Lock()
RATE_LIMIT_LOCK = threading.Lock()
RATE_LIMIT_STATE: dict[str, list[float]] = {}


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z")


def atomic_append(path: Path, line: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with WRITE_LOCK:
        with path.open("a", encoding="utf-8") as handle:
            handle.write(f"{line}\n")


def is_rate_limited(
    client: str,
    *,
    now: float | None = None,
    window_seconds: int = RATE_LIMIT_WINDOW_SECONDS,
    max_reports: int = RATE_LIMIT_MAX_REPORTS,
) -> bool:
    current = time.time() if now is None else now
    cutoff = current - window_seconds
    key = client or "unknown"
    with RATE_LIMIT_LOCK:
        recent = [timestamp for timestamp in RATE_LIMIT_STATE.get(key, []) if timestamp >= cutoff]
        if len(recent) >= max_reports:
            RATE_LIMIT_STATE[key] = recent
            return True
        recent.append(current)
        RATE_LIMIT_STATE[key] = recent
        return False


def client_key(handler: BaseHTTPRequestHandler) -> str:
    forwarded = handler.headers.get("x-forwarded-for") or ""
    if forwarded:
        return forwarded.split(",", 1)[0].strip()[:120]
    host, _port = handler.client_address
    return str(host)[:120]


def sanitize_numeric_map(value: Any, *, max_entries: int = 120) -> dict[str, int]:
    if not isinstance(value, dict):
        return {}
    out: dict[str, int] = {}
    for key, raw in sorted(value.items())[:max_entries]:
        if not re.fullmatch(r"[A-Za-z0-9_.:-]{1,80}", str(key)):
            continue
        try:
            number = int(raw)
        except (TypeError, ValueError):
            continue
        if number < 0:
            continue
        out[str(key)] = min(number, 100_000)
    return out


def sanitize_text(value: Any, *, max_len: int = 500) -> str | None:
    if value is None:
        return None
    text = str(value)[:max_len]
    text = re.sub(r"https?://[^\s)]+", lambda m: re.sub(r"[?#].*$", "?[redacted]", m.group(0)), text)
    return text


def assert_no_sensitive_material(value: Any) -> None:
    serialized = json.dumps(value, ensure_ascii=False, sort_keys=True)
    if len(serialized.encode("utf-8")) > MAX_BODY_BYTES or SENSITIVE_RE.search(serialized):
        raise ValueError("report contains disallowed sensitive material")


def sanitize_report(report: dict[str, Any]) -> dict[str, Any]:
    assert_no_sensitive_material(report)
    if report.get("schemaVersion") != 1:
        raise ValueError("unsupported schemaVersion")
    if report.get("scope") != "chzzk-live":
        raise ValueError("unsupported scope")
    addon_id = str(report.get("addonId") or "")[:120]
    extension_version = str(report.get("extensionVersion") or "")[:40]
    event_type = str(report.get("eventType") or "")[:80]
    if not HOST_RE.fullmatch(addon_id) or not HOST_RE.fullmatch(extension_version):
        raise ValueError("invalid addon/version")
    if not re.fullmatch(r"[a-z0-9_.:-]{1,80}", event_type, re.I):
        raise ValueError("invalid eventType")

    diagnostics = report.get("diagnostics") if isinstance(report.get("diagnostics"), dict) else None
    structure = report.get("structure") if isinstance(report.get("structure"), dict) else None

    clean: dict[str, Any] = {
        "addonId": addon_id,
        "eventType": event_type,
        "extensionVersion": extension_version,
        "receivedAt": utc_now(),
        "schemaVersion": 1,
        "scope": "chzzk-live",
        "sentAt": sanitize_text(report.get("sentAt"), max_len=80),
    }

    if diagnostics:
        session_rules = diagnostics.get("sessionRules") if isinstance(diagnostics.get("sessionRules"), dict) else {}
        clean["diagnostics"] = {
            "decisionsByReason": sanitize_numeric_map(diagnostics.get("decisionsByReason")),
            "generatedAt": sanitize_text(diagnostics.get("generatedAt"), max_len=80),
            "qualities": sanitize_numeric_map(diagnostics.get("qualities")),
            "sessionRules": {
                "activeRuleCount": int(session_rules.get("activeRuleCount") or 0),
                "activeTabCount": int(session_rules.get("activeTabCount") or 0),
                "lastError": sanitize_text(session_rules.get("lastError"), max_len=500),
                "updatedAt": sanitize_text(session_rules.get("updatedAt"), max_len=80),
            },
            "totalHlsRequests": int(diagnostics.get("totalHlsRequests") or 0),
        }
        samples = diagnostics.get("samples") if isinstance(diagnostics.get("samples"), list) else []
        clean["diagnostics"]["samples"] = [
            {
                "quality": sanitize_text(sample.get("quality"), max_len=16),
                "seenAt": sanitize_text(sample.get("seenAt"), max_len=80),
                "type": sanitize_text(sample.get("type"), max_len=40),
                "url": sanitize_text(sample.get("url"), max_len=500),
            }
            for sample in samples[:20]
            if isinstance(sample, dict)
        ]

    if structure:
        clean["structure"] = {
            "classSummary": [
                {
                    "count": int(item.get("count") or 0),
                    "token": sanitize_text(item.get("token"), max_len=80),
                }
                for item in (structure.get("classSummary") or [])[:80]
                if isinstance(item, dict)
            ],
            "featureCounts": sanitize_numeric_map(structure.get("featureCounts")),
            "routeShape": "/live/[redacted]" if structure.get("routeShape") == "/live/[redacted]" else None,
            "selectorSample": [sanitize_text(item, max_len=120) for item in (structure.get("selectorSample") or [])[:120]],
            "structureHash": sanitize_text(structure.get("structureHash"), max_len=32),
            "tagCounts": sanitize_numeric_map(structure.get("tagCounts")),
        }

    assert_no_sensitive_material(clean)
    return clean


class Handler(BaseHTTPRequestHandler):
    server_version = "CHZZKTelemetry/1.0"

    def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
        sys.stderr.write(f"{self.address_string()} - {format % args}\n")

    def _json(self, status: HTTPStatus, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("cache-control", "no-store")
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:  # noqa: N802
        if self.path == "/healthz":
            self._json(HTTPStatus.OK, {"ok": True})
            return
        self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/report":
            self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not_found"})
            return
        if is_rate_limited(client_key(self)):
            self._json(HTTPStatus.TOO_MANY_REQUESTS, {"ok": False, "error": "rate_limited"})
            return
        try:
            length = int(self.headers.get("content-length") or "0")
        except ValueError:
            length = 0
        if length <= 0 or length > MAX_BODY_BYTES:
            self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"ok": False, "error": "bad_length"})
            return
        try:
            raw = self.rfile.read(length)
            incoming = json.loads(raw.decode("utf-8"))
            if not isinstance(incoming, dict):
                raise ValueError("payload must be object")
            clean = sanitize_report(incoming)
            day = dt.datetime.now(dt.UTC).strftime("%Y%m%d")
            state_dir: Path = self.server.state_dir  # type: ignore[attr-defined]
            atomic_append(state_dir / f"reports-{day}.ndjson", json.dumps(clean, ensure_ascii=False, sort_keys=True))
        except Exception as exc:  # noqa: BLE001
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)[:200]})
            return
        self._json(HTTPStatus.OK, {"ok": True})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", default=os.environ.get("CHZZK_TELEMETRY_BIND", DEFAULT_BIND))
    parser.add_argument("--port", type=int, default=int(os.environ.get("CHZZK_TELEMETRY_PORT", DEFAULT_PORT)))
    parser.add_argument("--state-dir", type=Path, default=Path(os.environ.get("CHZZK_TELEMETRY_STATE_DIR", DEFAULT_STATE_DIR)))
    args = parser.parse_args()

    args.state_dir.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer((args.bind, args.port), Handler)
    httpd.state_dir = args.state_dir  # type: ignore[attr-defined]
    print(f"listening on {args.bind}:{args.port}; state_dir={args.state_dir}", flush=True)
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
