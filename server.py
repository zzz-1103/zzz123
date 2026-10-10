#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A tiny server-backed live registration counter. SQLite locally, PostgreSQL on Render."""
from http.cookies import SimpleCookie
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import hashlib
import json
import os
import secrets
import sqlite3
import time
from contextlib import contextmanager

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = Path(os.environ.get("SIGNUP_DB_PATH", str(BASE_DIR / "registrations.sqlite3")))
DATABASE_URL = os.environ.get("DATABASE_URL", "").strip()
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))
COOKIE_NAME = "signup_visitor"
COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 10
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "0").lower() in {"1", "true", "yes"}

if DATABASE_URL:
    import psycopg


def connect_db():
    if DATABASE_URL:
        connection = psycopg.connect(DATABASE_URL, connect_timeout=10)
        connection.execute(
            """CREATE TABLE IF NOT EXISTS registrations (
                   id BIGSERIAL PRIMARY KEY,
                   visitor_hash TEXT NOT NULL UNIQUE,
                   created_at TIMESTAMPTZ NOT NULL DEFAULT CURRENT_TIMESTAMP
               )"""
        )
        connection.commit()
        return connection

    DB_PATH.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(DB_PATH, timeout=15)
    connection.execute("PRAGMA journal_mode=WAL")
    connection.execute("PRAGMA busy_timeout=15000")
    connection.execute(
        """CREATE TABLE IF NOT EXISTS registrations (
               id INTEGER PRIMARY KEY AUTOINCREMENT,
               visitor_hash TEXT NOT NULL UNIQUE,
               created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
           )"""
    )
    connection.commit()
    return connection


def execute(db, sql, params=()):
    """Run portable SQL using the placeholder and conflict syntax for the active DB."""
    if DATABASE_URL:
        sql = sql.replace(
            "INSERT OR IGNORE INTO registrations (visitor_hash) VALUES (?)",
            "INSERT INTO registrations (visitor_hash) VALUES (?) ON CONFLICT (visitor_hash) DO NOTHING",
        )
        sql = sql.replace("?", "%s")
    return db.execute(sql, params)


@contextmanager
def database():
    """Commit on success and always close the database connection."""
    connection = connect_db()
    try:
        yield connection
        connection.commit()
    except Exception:
        connection.rollback()
        raise
    finally:
        connection.close()


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class SignupHandler(BaseHTTPRequestHandler):
    server_version = "LiveSignup/1.1"

    def _send_json(self, status, payload, cookie_token=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        if cookie_token:
            cookie = (f"{COOKIE_NAME}={cookie_token}; Path=/; Max-Age={COOKIE_MAX_AGE}; "
                      "HttpOnly; SameSite=Lax")
            if COOKIE_SECURE:
                cookie += "; Secure"
            self.send_header("Set-Cookie", cookie)
        self.end_headers()
        self.wfile.write(body)

    def _send_html(self, content):
        body = content.encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.send_header("Referrer-Policy", "same-origin")
        self.send_header("X-Frame-Options", "DENY")
        self.end_headers()
        self.wfile.write(body)

    def _get_or_create_token(self):
        cookie_header = self.headers.get("Cookie", "")
        cookie = SimpleCookie()
        try:
            cookie.load(cookie_header)
            morsel = cookie.get(COOKIE_NAME)
            token = morsel.value if morsel else ""
        except Exception:
            token = ""
        # Tokens are server-generated random values; reject malformed values.
        if len(token) != 43 or any(
            ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_"
            for ch in token
        ):
            return secrets.token_urlsafe(32), True
        return token, False

    def _snapshot(self, token):
        with database() as db:
            count = execute(db, "SELECT COUNT(*) FROM registrations").fetchone()[0]
            exists = execute(
                db,
                "SELECT 1 FROM registrations WHERE visitor_hash = ? LIMIT 1",
                (hash_token(token),),
            ).fetchone() is not None
        return {"count": count, "registered": exists, "updatedAt": int(time.time())}

    def do_GET(self):
        if self.path in ("/", "/index.html"):
            try:
                html = (BASE_DIR / "index.html").read_text(encoding="utf-8")
            except OSError:
                self.send_error(500, "index.html not found")
                return
            self._send_html(html)
            return
        if self.path == "/api/state":
            token, is_new = self._get_or_create_token()
            try:
                payload = self._snapshot(token)
            except Exception:
                self._send_json(503, {"error": "数据库暂时不可用，请稍后重试。"})
                return
            self._send_json(200, payload, cookie_token=token if is_new else None)
            return
        if self.path == "/health":
            try:
                with database() as db:
                    execute(db, "SELECT 1")
                self._send_json(200, {"ok": True})
            except Exception:
                self._send_json(503, {"ok": False, "error": "database unavailable"})
            return
        self.send_error(404, "Not found")

    def do_POST(self):
        if self.path != "/api/register":
            self.send_error(404, "Not found")
            return

        if self.headers.get("X-Requested-With") != "fetch":
            self._send_json(403, {"error": "请通过网页报名按钮提交。"})
            return

        token, is_new = self._get_or_create_token()
        token_hash = hash_token(token)
        try:
            with database() as db:
                # Conflict handling makes repeated/concurrent clicks idempotent per browser token.
                execute(db, "INSERT OR IGNORE INTO registrations (visitor_hash) VALUES (?)", (token_hash,))
                count = execute(db, "SELECT COUNT(*) FROM registrations").fetchone()[0]
                exists = execute(
                    db,
                    "SELECT 1 FROM registrations WHERE visitor_hash = ? LIMIT 1",
                    (token_hash,),
                ).fetchone() is not None
            self._send_json(
                200,
                {"count": count, "registered": exists, "updatedAt": int(time.time())},
                cookie_token=token if is_new else None,
            )
        except Exception:
            self._send_json(500, {"error": "暂时无法保存报名，请稍后重试。"})

    def log_message(self, format, *args):
        if self.path not in ("/api/state",):
            super().log_message(format, *args)


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    with database() as db:
        execute(db, "SELECT 1")
    backend = "PostgreSQL" if DATABASE_URL else f"SQLite（{DB_PATH}）"
    print(f"报名网页服务启动，监听端口：{PORT}")
    print(f"数据库类型：{backend}")
    print("停止服务请按 Ctrl+C")
    ReusableThreadingHTTPServer((HOST, PORT), SignupHandler).serve_forever()
