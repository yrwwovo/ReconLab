# -*- coding: utf-8 -*-
"""
编排层 · 会话存储（sqlite，标准库）

会话 / 消息 / 事件（SSE 拉这个表）/ 工具审计，全在一张 sqlite 里。
表结构故意做窄：事件是 append-only，前端按 seq 增量拉。
"""

import json
import os
import sqlite3
import threading
import time
import uuid

SCHEMA = """
CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,
  title TEXT,
  status TEXT,
  meta TEXT,
  created REAL,
  updated REAL
);
CREATE TABLE IF NOT EXISTS messages (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  seq INTEGER,
  role TEXT,
  content TEXT,
  created REAL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  session_id TEXT,
  seq INTEGER,
  kind TEXT,
  payload TEXT,
  created REAL
);
CREATE INDEX IF NOT EXISTS idx_events_session ON events(session_id, seq);
CREATE INDEX IF NOT EXISTS idx_messages_session ON messages(session_id, seq);
"""


class Store(object):
    def __init__(self, path):
        self.path = path
        d = os.path.dirname(os.path.abspath(path))
        if d and not os.path.isdir(d):
            os.makedirs(d)
        self.lock = threading.Lock()
        self.conn = sqlite3.connect(path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        with self.lock:
            self.conn.executescript(SCHEMA)
            self.conn.commit()

    # ── 内部 ──

    def _exec(self, sql, params=()):
        with self.lock:
            cur = self.conn.execute(sql, params)
            self.conn.commit()
            return cur

    def _next_seq(self, table, session_id):
        row = self.conn.execute(
            "SELECT COALESCE(MAX(seq), 0) AS s FROM %s WHERE session_id = ?" % table,
            (session_id,)).fetchone()
        return int(row["s"] or 0) + 1

    # ── 会话 ──

    def create_session(self, title=""):
        sid = uuid.uuid4().hex[:16]
        now = time.time()
        self._exec("INSERT INTO sessions (id, title, status, meta, created, updated) VALUES (?,?,?,?,?,?)",
                   (sid, title or "新回合", "idle", "{}", now, now))
        return sid

    def list_sessions(self, limit=30):
        rows = self.conn.execute(
            "SELECT * FROM sessions ORDER BY updated DESC LIMIT ?", (limit,)).fetchall()
        return [self._session_row(r) for r in rows]

    def get_session(self, sid):
        row = self.conn.execute("SELECT * FROM sessions WHERE id = ?", (sid,)).fetchone()
        return self._session_row(row) if row else None

    def _session_row(self, row):
        if row is None:
            return None
        meta = {}
        try:
            meta = json.loads(row["meta"] or "{}")
        except ValueError:
            pass
        return {"id": row["id"], "title": row["title"], "status": row["status"],
                "meta": meta, "created": row["created"], "updated": row["updated"]}

    def set_status(self, sid, status, meta=None):
        if meta is None:
            self._exec("UPDATE sessions SET status = ?, updated = ? WHERE id = ?", (status, time.time(), sid))
        else:
            self._exec("UPDATE sessions SET status = ?, meta = ?, updated = ? WHERE id = ?",
                       (status, json.dumps(meta, ensure_ascii=False), time.time(), sid))

    def patch_meta(self, sid, **kv):
        s = self.get_session(sid) or {}
        meta = s.get("meta") or {}
        meta.update(kv)
        self._exec("UPDATE sessions SET meta = ?, updated = ? WHERE id = ?",
                   (json.dumps(meta, ensure_ascii=False), time.time(), sid))

    # ── 消息 ──

    def add_message(self, sid, role, content):
        seq = self._next_seq("messages", sid)
        self._exec("INSERT INTO messages (id, session_id, seq, role, content, created) VALUES (?,?,?,?,?,?)",
                   (uuid.uuid4().hex, sid, seq, role,
                    json.dumps(content, ensure_ascii=False) if not isinstance(content, str) else content,
                    time.time()))
        return seq

    def messages(self, sid, limit=200):
        rows = self.conn.execute(
            "SELECT * FROM messages WHERE session_id = ? ORDER BY seq ASC LIMIT ?", (sid, limit)).fetchall()
        out = []
        for r in rows:
            content = r["content"]
            try:
                content = json.loads(content)
            except (ValueError, TypeError):
                pass
            out.append({"seq": r["seq"], "role": r["role"], "content": content, "created": r["created"]})
        return out

    # ── 事件（SSE） ──

    def add_event(self, sid, kind, payload):
        seq = self._next_seq("events", sid)
        self._exec("INSERT INTO events (id, session_id, seq, kind, payload, created) VALUES (?,?,?,?,?,?)",
                   (uuid.uuid4().hex, sid, seq, kind, json.dumps(payload, ensure_ascii=False), time.time()))
        return seq

    def events_after(self, sid, after=0, limit=500):
        rows = self.conn.execute(
            "SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq ASC LIMIT ?",
            (sid, after, limit)).fetchall()
        out = []
        for r in rows:
            try:
                payload = json.loads(r["payload"] or "{}")
            except ValueError:
                payload = {}
            out.append({"seq": r["seq"], "kind": r["kind"], "payload": payload, "created": r["created"]})
        return out

    def close(self):
        with self.lock:
            self.conn.close()
