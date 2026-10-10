#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""A tiny server-backed live registration counter. Python standard library only."""
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
HOST = os.environ.get("HOST", "0.0.0.0")
PORT = int(os.environ.get("PORT", "8000"))
COOKIE_NAME = "signup_visitor"
COOKIE_MAX_AGE = 60 * 60 * 24 * 365 * 10
COOKIE_SECURE = os.environ.get("COOKIE_SECURE", "0").lower() in {"1", "true", "yes"}


def connect_db():
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


@contextmanager
def database():
    """Commit on success and always close the SQLite connection."""
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
    server_version = "LiveSignup/1.0"

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
        # Tokens are url-safe, server-generated random values; reject malformed ones.
        if len(token) != 43 or any(ch not in "abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_" for ch in token):
            return secrets.token_urlsafe(32), True
        return token, False

    def _snapshot(self, token):
        with database() as db:
            count = db.execute("SELECT COUNT(*) FROM registrations").fetchone()[0]
            exists = db.execute(
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
            self._send_json(200, self._snapshot(token), cookie_token=token if is_new else None)
            return
        if self.path == "/health":
            self._send_json(200, {"ok": True})
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
                # INSERT OR IGNORE makes repeated/concurrent clicks idempotent per browser token.
                db.execute("INSERT OR IGNORE INTO registrations (visitor_hash) VALUES (?)", (token_hash,))
                count = db.execute("SELECT COUNT(*) FROM registrations").fetchone()[0]
                exists = db.execute(
                    "SELECT 1 FROM registrations WHERE visitor_hash = ? LIMIT 1",
                    (token_hash,),
                ).fetchone() is not None
            self._send_json(200, {"count": count, "registered": exists, "updatedAt": int(time.time())},
                            cookie_token=token if is_new else None)
        except sqlite3.Error:
            self._send_json(500, {"error": "暂时无法保存报名，请稍后重试。"})

    def log_message(self, format, *args):
        # Keep simple request logging while avoiding noisy output from polling.
        if self.path not in ("/api/state",):
            super().log_message(format, *args)


class ReusableThreadingHTTPServer(ThreadingHTTPServer):
    allow_reuse_address = True
    daemon_threads = True


if __name__ == "__main__":
    # Initialize the database before accepting requests.
    with database():
        pass
    print(f"报名网页运行中：http://127.0.0.1:{PORT}")
    print(f"数据库文件：{DB_PATH}")
    print("停止服务请按 Ctrl+C")
    ReusableThreadingHTTPServer((HOST, PORT), SignupHandler).serve_forever()
