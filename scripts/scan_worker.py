#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
ReconLab scan worker (background job processor) - stdlib only.

Moves `scans` rows through the lifecycle:
    queued -> running (claim) -> progress steps -> findings rows inserted -> done
On any processing error the row is marked failed (failure_code=SCAN_FAILED).

Result rows are INERT PLACEHOLDERS for pipeline validation only. Each row is
clearly marked: title prefixed "[placeholder] ", fingerprint "placeholder:<kind>",
evidence_refs ["placeholder"]. No real scanning is performed and no security
payload / exploit content is produced. Real content producers are meant to be
plugged into the per-kind seam (HANDLERS) later.

Linking: every inserted findings row sets findings.scan = <scan id> (and
findings.target = scans.target when that relation is set), which is exactly what
GET /api/scans/{id}/findings filters on.

SECURITY NOTE: this dev worker authenticates as a PocketBase SUPERUSER
(auth-with-password) to obtain a token for REST writes. A production deployment
should use a dedicated, scoped service credential (e.g. a worker-only auth
collection / API rule limited to scans+findings+workers) instead of a superuser
token.

Usage:
    python scripts/scan_worker.py --url http://127.0.0.1:8090 --once
    python scripts/scan_worker.py --interval 3          # continuous loop
    python scripts/scan_worker.py --once --scan-id <id> # claim one specific queued scan
Env overrides: RECONLAB_PB_URL, RECONLAB_PB_EMAIL, RECONLAB_PB_PASSWORD
"""

import argparse
import datetime
import json
import os
import platform
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

WORKER_NAME = "scan-worker-local"
WORKER_VERSION = "0.1.0"


def log(msg):
    stamp = datetime.datetime.now().strftime("%H:%M:%S")
    print("[scan_worker %s] %s" % (stamp, msg))
    sys.stdout.flush()


def now_iso():
    # PocketBase date format (UTC)
    t = datetime.datetime.now(datetime.timezone.utc)
    return t.strftime("%Y-%m-%d %H:%M:%S.") + "%03dZ" % (t.microsecond // 1000)


def request(method, url, body=None, token=None):
    data = json.dumps(body).encode("utf-8") if body is not None else None
    headers = {"Content-Type": "application/json", "Accept": "application/json"}
    if token:
        headers["Authorization"] = token
    req = urllib.request.Request(url, data=data, headers=headers, method=method)
    try:
        with urllib.request.urlopen(req, timeout=20) as resp:
            raw = resp.read().decode("utf-8", "replace")
            return resp.status, (json.loads(raw) if raw else {})
    except urllib.error.HTTPError as exc:
        raw = exc.read().decode("utf-8", "replace")
        try:
            payload = json.loads(raw)
        except ValueError:
            payload = {"message": raw[:300]}
        return exc.code, payload


class ApiError(Exception):
    pass


class PB(object):
    def __init__(self, base, email, password):
        self.base = base.rstrip("/")
        self.email = email
        self.password = password
        self.token = None

    def auth(self):
        status, payload = request("POST", self.base + "/api/collections/_superusers/auth-with-password",
                                  {"identity": self.email, "password": self.password})
        if status != 200 or not payload.get("token"):
            raise ApiError("superuser auth failed (%s): %s" % (status, payload.get("message", payload)))
        self.token = payload["token"]

    def call(self, method, path, body=None, ok=(200,)):
        status, payload = request(method, self.base + path, body, self.token)
        if status == 401 and self.token:
            # token expired -> re-auth once
            self.auth()
            status, payload = request(method, self.base + path, body, self.token)
        if status not in ok:
            raise ApiError("%s %s -> %s: %s" % (method, path, status,
                                                json.dumps(payload, ensure_ascii=False)[:400]))
        return payload

    def list(self, collection, filt, sort=None, per_page=1):
        q = {"filter": filt, "perPage": str(per_page), "page": "1", "skipTotal": "1"}
        if sort:
            q["sort"] = sort
        return self.call("GET", "/api/collections/%s/records?%s" % (collection, urllib.parse.urlencode(q)))

    def get(self, collection, rid):
        return self.call("GET", "/api/collections/%s/records/%s" % (collection, rid))

    def create(self, collection, body):
        return self.call("POST", "/api/collections/%s/records" % collection, body, ok=(200, 201))

    def patch(self, collection, rid, body):
        return self.call("PATCH", "/api/collections/%s/records/%s" % (collection, rid), body)


# ───────────────────────── worker registration (optional) ─────────────────────────

def upsert_worker(pb):
    """Best effort: returns worker id or None."""
    try:
        body = {
            "name": WORKER_NAME,
            "hostname": socket.gethostname(),
            "os": platform.system(),
            "version": WORKER_VERSION,
            "caps": "placeholder:subdomain,port,http,dir,vuln,poc",
            "status": "online",
        }
        res = pb.list("workers", 'name = "%s"' % WORKER_NAME)
        items = res.get("items") or []
        if items:
            wid = items[0]["id"]
            pb.patch("workers", wid, body)
            log("worker registered (updated) id=%s" % wid)
        else:
            wid = pb.create("workers", body)["id"]
            log("worker registered (created) id=%s" % wid)
        return wid
    except Exception as exc:  # noqa: BLE001 - optional step
        log("worker upsert skipped: %s" % exc)
        return None


def set_worker_status(pb, wid, status):
    if not wid:
        return
    try:
        pb.patch("workers", wid, {"status": status})
    except Exception as exc:  # noqa: BLE001
        log("worker status update skipped: %s" % exc)


# ───────────────────────── per-kind seam ─────────────────────────

def _placeholder_row(kind, target, n, **fields):
    row = {
        "title": "[placeholder] %s result #%d for %s" % (kind, n, target),
        "severity": "info",
        "category": "placeholder-%s" % kind,
        "url": target,
        "service": "placeholder-service",
        "version": "0.0-placeholder",
        "fingerprint": "placeholder:%s" % kind,
        "cve_candidates": ["PLACEHOLDER-CVE-0000-0000"],
        "evidence_refs": ["placeholder"],
        "confidence": 0.1,
        "evidence": "[placeholder] inert pipeline-validation record; no scan was performed.",
    }
    row.update(fields)
    # enforce the markings regardless of overrides
    if not row["title"].startswith("[placeholder] "):
        row["title"] = "[placeholder] " + row["title"]
    row["fingerprint"] = "placeholder:%s" % kind
    row["evidence_refs"] = ["placeholder"]
    return row


def default_handler(ctx):
    """Steps progress and returns (stats, rows). Produces INERT placeholder rows only."""
    kind, target = ctx["kind"], ctx["target"]
    for pct in (25, 50, 75):
        ctx["progress"](pct)
        time.sleep(ctx["step_sleep"])

    if kind == "port":
        stats = {"ports_scanned": 1000, "open": 2, "placeholder": True}
        rows = [
            _placeholder_row(kind, target, 1, service="placeholder-http", version="1.0-placeholder",
                             cve_candidates=["PLACEHOLDER-CVE-0000-0001"], confidence=0.5,
                             severity="low"),
            _placeholder_row(kind, target, 2, service="placeholder-ssh", version="2.0-placeholder",
                             cve_candidates=["PLACEHOLDER-CVE-0000-0003"], confidence=0.3),
        ]
    elif kind == "subdomain":
        stats = {"subdomains": 2, "placeholder": True}
        rows = [_placeholder_row(kind, target, 1, service="placeholder-dns", version="n/a")]
    else:
        stats = {"checks": 2, "placeholder": True}
        rows = [_placeholder_row(kind, target, 1, cve_candidates=["PLACEHOLDER-CVE-0000-0002"],
                                 confidence=0.2)]
    return stats, rows


# kind -> handler(ctx) -> (stats dict, [row dict]). Plug real producers in here later.
HANDLERS = {
    "subdomain": default_handler,
    "port": default_handler,
    "http": default_handler,
    "dir": default_handler,
    "vuln": default_handler,
    "poc": default_handler,
}


# ───────────────────────── claim / process / complete ─────────────────────────

def claim(pb, wid, scan_id=None):
    filt = 'status = "queued"'
    if scan_id:
        # optional targeting (tests / manual re-drive); id is validated to PB's id charset
        if not scan_id.isalnum():
            raise ApiError("invalid --scan-id")
        filt += ' && id = "%s"' % scan_id
    res = pb.list("scans", filt, sort="created")
    items = res.get("items") or []
    if not items:
        return None
    rec = pb.get("scans", items[0]["id"])  # re-check
    if rec.get("status") != "queued":
        log("scan %s no longer queued (%s), skipping" % (rec.get("id"), rec.get("status")))
        return None
    body = {"status": "running", "started": now_iso(), "progress": 0}
    if wid:
        body["worker"] = wid
    rec = pb.patch("scans", rec["id"], body)
    log("claimed scan %s kind=%s target=%s" % (rec["id"], rec.get("kind"), rec.get("target_value")))
    return rec


def process(pb, scan, wid, step_sleep):
    sid = scan["id"]
    kind = scan.get("kind") or "unknown"
    target = scan.get("target_value") or scan.get("target") or scan.get("name") or ""
    try:
        def progress(pct):
            pb.patch("scans", sid, {"progress": pct})
            log("scan %s progress=%d" % (sid, pct))

        ctx = {"scan": scan, "kind": kind, "target": target,
               "progress": progress, "step_sleep": step_sleep}
        handler = HANDLERS.get(kind, default_handler)
        stats, rows = handler(ctx)

        created = []
        for row in rows:
            body = dict(row)
            body["scan"] = sid
            body["status"] = "new"
            if scan.get("target"):
                body["target"] = scan["target"]
            rec = pb.create("findings", body)
            created.append(rec["id"])
            log("scan %s inserted findings row %s: %s" % (sid, rec["id"], body["title"]))

        stats = dict(stats)
        stats["findings"] = len(created)
        pb.patch("scans", sid, {
            "status": "done", "progress": 100, "finished": now_iso(),
            "stats": json.dumps(stats), "message": "placeholder run complete",
        })
        log("scan %s done stats=%s" % (sid, json.dumps(stats)))
        return True
    except Exception as exc:  # noqa: BLE001
        msg = str(exc)[:240]
        log("scan %s FAILED: %s" % (sid, msg))
        try:
            pb.patch("scans", sid, {"status": "failed", "failure_code": "SCAN_FAILED",
                                    "message": msg, "finished": now_iso()})
        except Exception as exc2:  # noqa: BLE001
            log("scan %s could not be marked failed: %s" % (sid, exc2))
        return False


def main():
    parser = argparse.ArgumentParser(description="ReconLab scan worker (placeholder results)")
    parser.add_argument("--url", default=os.environ.get("RECONLAB_PB_URL", "http://127.0.0.1:8090"))
    parser.add_argument("--email", default=os.environ.get("RECONLAB_PB_EMAIL", "admin@reconlab.local"))
    parser.add_argument("--password", default=os.environ.get("RECONLAB_PB_PASSWORD", "reconlab123"))
    parser.add_argument("--once", action="store_true", help="claim at most one queued scan, then exit")
    parser.add_argument("--interval", type=float, default=3.0, help="poll interval seconds (loop mode)")
    parser.add_argument("--scan-id", default=None,
                        help="only claim this specific queued scan id (default: oldest queued)")
    parser.add_argument("--step-sleep", type=float, default=0.5, help="sleep between progress steps")
    args = parser.parse_args()

    pb = PB(args.url, args.email, args.password)
    try:
        pb.auth()
    except Exception as exc:  # noqa: BLE001
        log(str(exc))
        return 1
    log("authenticated to %s (superuser; dev only)" % pb.base)
    wid = upsert_worker(pb)

    try:
        while True:
            scan = None
            try:
                scan = claim(pb, wid, args.scan_id)
            except Exception as exc:  # noqa: BLE001
                log("claim error: %s" % exc)
            if scan:
                process(pb, scan, wid, args.step_sleep)
            elif args.once:
                log("no queued scans")
            if args.once:
                break
            time.sleep(args.interval)
    except KeyboardInterrupt:
        log("interrupted")
    finally:
        set_worker_status(pb, wid, "idle")
    return 0


if __name__ == "__main__":
    sys.exit(main())
