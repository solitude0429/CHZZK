#!/usr/bin/env python3
"""Authenticated CHZZK telemetry collector for the private WireGuard-only update host.

The collector accepts HMAC-signed, sanitized reports from the CHZZK Firefox
extension and stores newline-delimited JSON under /var/lib/chzzk-telemetry. It
intentionally has no GitHub credentials and does not perform code changes by
itself.
"""

from __future__ import annotations

import argparse
import datetime as dt
import hashlib
import hmac
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
from urllib.parse import urlparse

DEFAULT_BIND = "127.0.0.1"
DEFAULT_PORT = 18181
DEFAULT_STATE_DIR = Path("/var/lib/chzzk-telemetry")
MAX_BODY_BYTES = 64_000
MAX_GLOBAL_REPORTS_PER_MINUTE = 600
MAX_REPORT_FILE_BYTES = 10_000_000
MAX_REPORTS_PER_MINUTE = 60
RATE_LIMIT_MAX_REPORTS = int(os.environ.get("CHZZK_TELEMETRY_RATE_MAX_REPORTS", "120"))
RATE_LIMIT_WINDOW_SECONDS = int(os.environ.get("CHZZK_TELEMETRY_RATE_WINDOW_SECONDS", "60"))
SIGNATURE_TOLERANCE_SECONDS = 300
RETENTION_DAYS = 14
AUTH_SCHEME = "hmac-sha256-v1"
SENSITIVE_RE = re.compile(
    r"([?&](Policy|Signature|Key-Pair-Id|Expires|token|auth|session)=)|"
    r"\b(policy|signature|key-pair-id|expires|token|auth|session|secret|credential|jwt|cookie)\b",
    re.I,
)
HOST_RE = re.compile(r"^[a-z0-9_.:@-]+$", re.I)
SCRIPT_ERROR_RE = re.compile(r"\b(referenceerror|typeerror|syntaxerror|rangeerror|evalerror)\b", re.I)
NETWORK_ERROR_RE = re.compile(r"\b(network|fetch|timeout|http\s*\d{3}|connection|cors|dns)\b", re.I)
INSTALL_ID_RE = re.compile(r"^[A-Za-z0-9_.:@-]{1,120}$")
QUALITY_RE = re.compile(r"(?:^|[^0-9])(\d{3,4}p)(?:[^0-9]|$)", re.I)
CLIENT_RATE_LIMIT_LOCK = threading.Lock()
CLIENT_RATE_LIMIT_STATE: dict[str, list[float]] = {}


class AuthError(Exception):
    status = HTTPStatus.UNAUTHORIZED
    public_error = "unauthorized"


class RateLimitError(AuthError):
    status = HTTPStatus.TOO_MANY_REQUESTS
    public_error = "rate_limited"


class StorageQuotaError(Exception):
    pass


def utc_now() -> str:
    return dt.datetime.now(dt.UTC).isoformat().replace("+00:00", "Z")


def parse_utc_timestamp(value: str) -> dt.datetime:
    parsed = dt.datetime.fromisoformat(value.replace("Z", "+00:00"))
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=dt.UTC)
    return parsed.astimezone(dt.UTC)


def install_hash(secret: bytes, install_id: str) -> str:
    return hmac.new(secret, install_id.encode("utf-8"), hashlib.sha256).hexdigest()[:24]


def atomic_append(path: Path, line: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("a", encoding="utf-8") as handle:
        handle.write(line)
        handle.write("\n")


def is_client_rate_limited(
    client: str,
    *,
    now: float | None = None,
    window_seconds: int = RATE_LIMIT_WINDOW_SECONDS,
    max_reports: int = RATE_LIMIT_MAX_REPORTS,
) -> bool:
    current = time.time() if now is None else now
    cutoff = current - window_seconds
    key = client or "unknown"
    with CLIENT_RATE_LIMIT_LOCK:
        recent = [timestamp for timestamp in CLIENT_RATE_LIMIT_STATE.get(key, []) if timestamp >= cutoff]
        if len(recent) >= max_reports:
            CLIENT_RATE_LIMIT_STATE[key] = recent
            return True
        recent.append(current)
        CLIENT_RATE_LIMIT_STATE[key] = recent
        return False


def client_key(handler: BaseHTTPRequestHandler) -> str:
    if getattr(handler.server, "trust_proxy", False):
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


def sanitize_url(value: Any, *, max_len: int = 500) -> str | None:
    if value is None:
        return None
    text = str(value)[:max_len]
    try:
        parsed = urlparse(text)
    except Exception:
        return re.sub(r"[?#].*$", "?[redacted]", text)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return "[redacted-url]"
    hostname = (parsed.hostname or "").lower()
    if not hostname:
        return "[redacted-url]"
    try:
        port = parsed.port
    except ValueError:
        return "[redacted-url]"
    safe_netloc = f"{hostname}:{port}" if port is not None else hostname
    quality_match = QUALITY_RE.search(parsed.path)
    extension_match = re.search(r"\.([a-z0-9]{2,8})$", parsed.path, re.I)
    suffix = ".".join(
        part
        for part in [
            quality_match.group(1).lower() if quality_match else None,
            extension_match.group(1).lower() if extension_match else None,
        ]
        if part
    )
    return f"{parsed.scheme}://{safe_netloc}/[redacted-path]{('/' + suffix) if suffix else ''}"


def sanitize_error_text(value: Any) -> str | None:
    if value is None:
        return None
    text = str(value)[:300]
    if re.fullmatch(r"error:[a-z0-9-]{1,80}", text):
        return text
    if re.search(r"https?://[^\s)]+", text, re.I) and SENSITIVE_RE.search(text):
        return "error:url-with-sensitive-material"
    if SENSITIVE_RE.search(text):
        return "error:sensitive-material"
    script_match = SCRIPT_ERROR_RE.search(text)
    if script_match:
        kind = script_match.group(1).lower().replace("error", "") or "exception"
        return f"error:script-{kind}"
    if NETWORK_ERROR_RE.search(text):
        return "error:network"
    return "error:page-exception" if text else None


def sanitize_text(value: Any, *, max_len: int = 500) -> str | None:
    if value is None:
        return None
    text = str(value)[:max_len]
    text = re.sub(r"https?://[^\s)]+", lambda match: sanitize_url(match.group(0)) or "[redacted-url]", text)
    text = re.sub(r"[A-Za-z0-9_+/=-]{32,}", "[redacted-token]", text)
    return text


def iter_string_values(value: Any):
    if isinstance(value, str):
        yield value
    elif isinstance(value, dict):
        for child in value.values():
            yield from iter_string_values(child)
    elif isinstance(value, list):
        for child in value:
            yield from iter_string_values(child)


def assert_no_sensitive_material(value: Any) -> None:
    serialized = json.dumps(value, ensure_ascii=False, sort_keys=True)
    if len(serialized.encode("utf-8")) > MAX_BODY_BYTES:
        raise ValueError("report contains disallowed sensitive material")
    if any(SENSITIVE_RE.search(text) for text in iter_string_values(value)):
        raise ValueError("report contains disallowed sensitive material")


def verify_request_auth(headers: Any, body: bytes, secret: bytes) -> str:
    if not secret:
        raise AuthError("auth_not_configured")
    install_id = str(headers.get("x-chzzk-telemetry-install-id") or "").strip()
    timestamp = str(headers.get("x-chzzk-telemetry-timestamp") or "").strip()
    signature_header = str(headers.get("x-chzzk-telemetry-signature") or "").strip()
    if not INSTALL_ID_RE.fullmatch(install_id) or not timestamp or not signature_header.startswith("v1="):
        raise AuthError("missing_auth")
    try:
        signed_at = parse_utc_timestamp(timestamp)
    except Exception as exc:
        raise AuthError("bad_timestamp") from exc
    age = abs((dt.datetime.now(dt.UTC) - signed_at).total_seconds())
    if age > SIGNATURE_TOLERANCE_SECONDS:
        raise AuthError("stale_signature")
    supplied = signature_header.removeprefix("v1=")
    if not re.fullmatch(r"[a-f0-9]{64}", supplied, re.I):
        raise AuthError("bad_signature")
    expected = hmac.new(secret, timestamp.encode("utf-8") + b"." + body, hashlib.sha256).hexdigest()
    if not hmac.compare_digest(expected, supplied.lower()):
        raise AuthError("bad_signature")
    return install_id


def sanitize_report(report: dict[str, Any], *, install_id: str, secret: bytes) -> dict[str, Any]:
    if report.get("schemaVersion") != 1:
        raise ValueError("unsupported schemaVersion")
    if report.get("scope") != "chzzk-live":
        raise ValueError("unsupported scope")
    if report.get("installId") != install_id:
        raise ValueError("installId mismatch")
    if (report.get("auth") or {}).get("scheme") != AUTH_SCHEME:
        raise ValueError("unsupported auth scheme")

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
        "installIdHash": install_hash(secret, install_id),
        "receivedAt": utc_now(),
        "schemaVersion": 1,
        "scope": "chzzk-live",
        "sentAt": sanitize_text(report.get("sentAt"), max_len=80),
    }

    if diagnostics:
        redirect_state = diagnostics.get("runtimeRedirects") if isinstance(diagnostics.get("runtimeRedirects"), dict) else {}
        legacy_session_rules = diagnostics.get("sessionRules") if isinstance(diagnostics.get("sessionRules"), dict) else {}
        if not redirect_state and legacy_session_rules:
            redirect_state = legacy_session_rules
        clean["diagnostics"] = {
            "decisionsByReason": sanitize_numeric_map(diagnostics.get("decisionsByReason")),
            "generatedAt": sanitize_text(diagnostics.get("generatedAt"), max_len=80),
            "qualities": sanitize_numeric_map(diagnostics.get("qualities")),
            "runtimeRedirects": {
                "activeTabCount": len(redirect_state.get("activeTabIds") or []),
                "lastError": sanitize_error_text(redirect_state.get("lastError")),
                "targetCount": len(redirect_state.get("targetsByTab") or {}),
                "updatedAt": sanitize_text(redirect_state.get("updatedAt"), max_len=80),
            },
            "totalHlsRequests": min(max(int(diagnostics.get("totalHlsRequests") or 0), 0), 1_000_000),
        }
        samples = diagnostics.get("samples") if isinstance(diagnostics.get("samples"), list) else []
        clean["diagnostics"]["samples"] = [
            {
                "quality": sanitize_text(sample.get("quality"), max_len=16),
                "seenAt": sanitize_text(sample.get("seenAt"), max_len=80),
                "type": sanitize_text(sample.get("type"), max_len=40),
                "url": sanitize_url(sample.get("url"), max_len=500),
            }
            for sample in samples[:20]
            if isinstance(sample, dict)
        ]

    if structure:
        clean["structure"] = {
            "classSummary": [
                {
                    "count": min(max(int(item.get("count") or 0), 0), 100_000),
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


def enforce_storage_limits(state_dir: Path, report_path: Path, *, max_file_bytes: int, retention_days: int) -> None:
    cutoff = dt.datetime.now(dt.UTC) - dt.timedelta(days=retention_days)
    for path in state_dir.glob("reports-*.ndjson"):
        try:
            date_text = path.stem.removeprefix("reports-")
            file_day = dt.datetime.strptime(date_text, "%Y%m%d").replace(tzinfo=dt.UTC)
        except Exception:
            continue
        if file_day < cutoff:
            path.unlink(missing_ok=True)
    if report_path.exists() and report_path.stat().st_size > max_file_bytes:
        raise StorageQuotaError("report_file_quota_exceeded")


def ensure_within_rate_limits(server: Any, install_id: str) -> None:
    bucket = int(time.time() // 60)
    with server.rate_lock:  # type: ignore[attr-defined]
        if server.rate_bucket != bucket:  # type: ignore[attr-defined]
            server.rate_bucket = bucket  # type: ignore[attr-defined]
            server.global_rate_count = 0  # type: ignore[attr-defined]
            server.install_rate_counts = {}  # type: ignore[attr-defined]
        install_counts = server.install_rate_counts  # type: ignore[attr-defined]
        install_counts[install_id] = int(install_counts.get(install_id, 0)) + 1
        server.global_rate_count += 1  # type: ignore[attr-defined]
        if install_counts[install_id] > server.max_reports_per_minute:  # type: ignore[attr-defined]
            raise RateLimitError("install_rate_limited")
        if server.global_rate_count > server.max_global_reports_per_minute:  # type: ignore[attr-defined]
            raise RateLimitError("global_rate_limited")


class Handler(BaseHTTPRequestHandler):
    server_version = "CHZZKTelemetry/1.1"

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
            self._json(HTTPStatus.OK, {"authConfigured": bool(self.server.hmac_secret), "ok": True})  # type: ignore[attr-defined]
            return
        self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not_found"})

    def do_POST(self) -> None:  # noqa: N802
        if self.path != "/report":
            self._json(HTTPStatus.NOT_FOUND, {"ok": False, "error": "not_found"})
            return
        if is_client_rate_limited(client_key(self)):
            self._json(HTTPStatus.TOO_MANY_REQUESTS, {"ok": False, "error": "rate_limited"})
            return
        try:
            length = int(self.headers.get("content-length") or "0")
        except ValueError:
            length = 0
        if length <= 0 or length > self.server.max_body_bytes:  # type: ignore[attr-defined]
            self._json(HTTPStatus.REQUEST_ENTITY_TOO_LARGE, {"ok": False, "error": "bad_length"})
            return
        try:
            raw = self.rfile.read(length)
            install_id = verify_request_auth(self.headers, raw, self.server.hmac_secret)  # type: ignore[attr-defined]
            ensure_within_rate_limits(self.server, install_id)
            incoming = json.loads(raw.decode("utf-8"))
            if not isinstance(incoming, dict):
                raise ValueError("payload must be object")
            clean = sanitize_report(incoming, install_id=install_id, secret=self.server.hmac_secret)  # type: ignore[attr-defined]
            day = dt.datetime.now(dt.UTC).strftime("%Y%m%d")
            state_dir: Path = self.server.state_dir  # type: ignore[attr-defined]
            report_path = state_dir / f"reports-{day}.ndjson"
            line = json.dumps(clean, ensure_ascii=False, sort_keys=True)
            with self.server.write_lock:  # type: ignore[attr-defined]
                enforce_storage_limits(
                    state_dir,
                    report_path,
                    max_file_bytes=self.server.max_report_file_bytes,  # type: ignore[attr-defined]
                    retention_days=self.server.retention_days,  # type: ignore[attr-defined]
                )
                atomic_append(report_path, line)
        except RateLimitError as exc:
            self._json(exc.status, {"ok": False, "error": exc.public_error})
            return
        except AuthError as exc:
            self._json(exc.status, {"ok": False, "error": exc.public_error})
            return
        except StorageQuotaError:
            self._json(HTTPStatus.INSUFFICIENT_STORAGE, {"ok": False, "error": "storage_quota"})
            return
        except Exception as exc:  # noqa: BLE001
            self._json(HTTPStatus.BAD_REQUEST, {"ok": False, "error": str(exc)[:200]})
            return
        self._json(HTTPStatus.OK, {"ok": True})


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--bind", default=os.environ.get("CHZZK_TELEMETRY_BIND", DEFAULT_BIND))
    parser.add_argument("--max-body-bytes", type=int, default=int(os.environ.get("CHZZK_TELEMETRY_MAX_BODY_BYTES", MAX_BODY_BYTES)))
    parser.add_argument(
        "--max-global-reports-per-minute",
        type=int,
        default=int(os.environ.get("CHZZK_TELEMETRY_MAX_GLOBAL_REPORTS_PER_MINUTE", MAX_GLOBAL_REPORTS_PER_MINUTE)),
    )
    parser.add_argument(
        "--max-report-file-bytes",
        type=int,
        default=int(os.environ.get("CHZZK_TELEMETRY_MAX_REPORT_FILE_BYTES", MAX_REPORT_FILE_BYTES)),
    )
    parser.add_argument(
        "--max-reports-per-minute",
        type=int,
        default=int(os.environ.get("CHZZK_TELEMETRY_MAX_REPORTS_PER_MINUTE", MAX_REPORTS_PER_MINUTE)),
    )
    parser.add_argument("--port", type=int, default=int(os.environ.get("CHZZK_TELEMETRY_PORT", DEFAULT_PORT)))
    parser.add_argument("--retention-days", type=int, default=int(os.environ.get("CHZZK_TELEMETRY_RETENTION_DAYS", RETENTION_DAYS)))
    parser.add_argument("--state-dir", type=Path, default=Path(os.environ.get("CHZZK_TELEMETRY_STATE_DIR", DEFAULT_STATE_DIR)))
    parser.add_argument(
        "--trust-proxy",
        action="store_true",
        default=os.environ.get("CHZZK_TELEMETRY_TRUST_PROXY", "0") == "1",
        help="trust reverse-proxy supplied X-Forwarded-For for per-client rate limiting",
    )
    args = parser.parse_args()

    args.state_dir.mkdir(parents=True, exist_ok=True)
    httpd = ThreadingHTTPServer((args.bind, args.port), Handler)
    httpd.global_rate_count = 0  # type: ignore[attr-defined]
    httpd.hmac_secret = os.environ.get("CHZZK_TELEMETRY_HMAC_SECRET", "").strip().encode("utf-8")  # type: ignore[attr-defined]
    httpd.install_rate_counts = {}  # type: ignore[attr-defined]
    httpd.max_body_bytes = args.max_body_bytes  # type: ignore[attr-defined]
    httpd.max_global_reports_per_minute = args.max_global_reports_per_minute  # type: ignore[attr-defined]
    httpd.max_report_file_bytes = args.max_report_file_bytes  # type: ignore[attr-defined]
    httpd.max_reports_per_minute = args.max_reports_per_minute  # type: ignore[attr-defined]
    httpd.rate_bucket = int(time.time() // 60)  # type: ignore[attr-defined]
    httpd.rate_lock = threading.Lock()  # type: ignore[attr-defined]
    httpd.retention_days = args.retention_days  # type: ignore[attr-defined]
    httpd.state_dir = args.state_dir  # type: ignore[attr-defined]
    httpd.trust_proxy = args.trust_proxy  # type: ignore[attr-defined]
    httpd.write_lock = threading.Lock()  # type: ignore[attr-defined]
    print(
        f"listening on {args.bind}:{args.port}; state_dir={args.state_dir}; "
        f"auth_configured={bool(getattr(httpd, 'hmac_secret', b''))}",
        flush=True,
    )
    httpd.serve_forever()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
