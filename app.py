"""仕事用ダッシュボード（ローカルサーバー）。

    python app.py

ブラウザで http://127.0.0.1:8080 を開く。
"""

import json
import os
import subprocess
import sys
import threading
import time
from datetime import date
from urllib.parse import urlparse

from flask import Flask, abort, jsonify, request, send_from_directory

from dashboard import providers
from dashboard.attendance import Attendance
from dashboard.storage import JsonStore, new_id

BASE = os.path.dirname(os.path.abspath(__file__))
DATA = os.path.join(BASE, "data")


def load_config():
    path = os.path.join(BASE, "config.json")
    demo = not os.path.exists(path)
    if demo:
        path = os.path.join(BASE, "config.example.json")
        print("config.json が無いため、デモデータで起動します")
    with open(path, encoding="utf-8") as f:
        cfg = json.load(f)
    if demo:
        cfg["mail"]["provider"] = cfg["calendar"]["provider"] = "demo"
        cfg["redmine"]["demo"] = True
    # 秘密情報は環境変数でも指定可能
    if os.environ.get("DASHBOARD_IMAP_PASSWORD"):
        cfg["mail"]["imap"]["password"] = os.environ["DASHBOARD_IMAP_PASSWORD"]
    if os.environ.get("DASHBOARD_REDMINE_API_KEY"):
        cfg["redmine"]["api_key"] = os.environ["DASHBOARD_REDMINE_API_KEY"]
    return cfg


CFG = load_config()
attendance = Attendance(JsonStore(os.path.join(DATA, "attendance.json"), {}), CFG["work"])
tasks_store = JsonStore(os.path.join(DATA, "tasks.json"), [])
shortcuts_store = JsonStore(os.path.join(DATA, "shortcuts.json"), [
    {"id": "sample-docs", "name": "ドキュメント", "type": "folder", "target": "~/Documents"},
    {"id": "sample-redmine", "name": "Redmine", "type": "url", "target": "https://www.redmine.org/"},
])

app = Flask(__name__, static_folder="static", static_url_path="/static")


# ---------------------------------------------------------------- 共通

class TTLCache:
    def __init__(self):
        self._data = {}
        self._lock = threading.Lock()

    def get(self, key, ttl, fn, force=False):
        with self._lock:
            hit = self._data.get(key)
            if hit and not force and time.time() - hit[0] < ttl:
                return hit[1]
        value = fn()
        with self._lock:
            self._data[key] = (time.time(), value)
        return value


cache = TTLCache()


def fetch(key, ttl, fn):
    force = request.args.get("refresh") == "1"
    try:
        result = cache.get(key, ttl, fn, force)
        return jsonify({"ok": True, **result, "fetched_at": time.strftime("%H:%M")})
    except Exception as e:  # 取得失敗は UI に表示する
        app.logger.warning("%s の取得に失敗: %s", key, e)
        return jsonify({"ok": False, "error": f"{type(e).__name__}: {e}"})


@app.before_request
def csrf_guard():
    # ローカルで動くため、他サイトからの書き込み・アプリ起動要求を防ぐ。
    # カスタムヘッダー付きのリクエストはクロスオリジンではプリフライトが必要になり、
    # 本サーバーは CORS を許可しないため、同一オリジンのページからしか送れない。
    if request.method in ("POST", "PUT", "PATCH", "DELETE"):
        if request.headers.get("X-Dashboard") != "1":
            abort(403)


@app.get("/")
def index():
    return send_from_directory(os.path.join(BASE, "static"), "index.html")


# ---------------------------------------------------------------- 勤怠

@app.get("/api/attendance")
def get_attendance():
    s = attendance.summary()
    s["work_start"] = CFG["work"].get("start")
    s["work_end"] = CFG["work"].get("end")
    return jsonify(s)


@app.post("/api/attendance")
def post_attendance():
    body = request.get_json(force=True) or {}
    action = body.get("action")
    now = time.strftime("%H:%M")
    day = body.get("date") or date.today().isoformat()
    try:
        if action == "clock_in":
            attendance.set_times(day, t_in=now, clear_out=True)
        elif action == "clock_out":
            attendance.set_times(day, t_out=now)
        elif action == "edit":
            attendance.set_times(day, t_in=body.get("in"), t_out=body.get("out"))
        else:
            abort(400)
    except ValueError:
        return jsonify({"ok": False, "error": "時刻は HH:MM 形式で入力してください"}), 400
    return get_attendance()


# ---------------------------------------------------------------- メール / 予定 / Redmine

@app.get("/api/mail")
def get_mail():
    c = CFG["mail"]
    return fetch("mail", c.get("refresh_seconds", 300), lambda: providers.mail_counts(c, CFG.get("google"), BASE))


@app.get("/api/calendar")
def get_calendar():
    c = CFG["calendar"]
    return fetch("calendar", c.get("refresh_seconds", 600), lambda: providers.today_events(c, CFG.get("google"), BASE))


@app.get("/api/redmine")
def get_redmine():
    c = CFG["redmine"]
    if not c.get("enabled", True):
        return jsonify({"ok": True, "disabled": True, "issues": []})
    resp = fetch("redmine", c.get("refresh_seconds", 300), lambda: providers.redmine_issues(c))
    return resp


# ---------------------------------------------------------------- タスク

@app.get("/api/tasks")
def list_tasks():
    return jsonify(tasks_store.load())


@app.post("/api/tasks")
def add_task():
    body = request.get_json(force=True) or {}
    title = (body.get("title") or "").strip()
    if not title:
        abort(400)
    tasks = tasks_store.load()
    tasks.append({
        "id": new_id(),
        "title": title,
        "due": body.get("due") or date.today().isoformat(),
        "done": False,
    })
    tasks_store.save(tasks)
    return jsonify(tasks)


@app.patch("/api/tasks/<tid>")
def update_task(tid):
    body = request.get_json(force=True) or {}
    tasks = tasks_store.load()
    for t in tasks:
        if t["id"] == tid:
            for k in ("title", "due", "done"):
                if k in body:
                    t[k] = body[k]
            if "done" in body:
                t["done_on"] = date.today().isoformat() if body["done"] else None
    tasks_store.save(tasks)
    return jsonify(tasks)


@app.delete("/api/tasks/<tid>")
def delete_task(tid):
    tasks = [t for t in tasks_store.load() if t["id"] != tid]
    tasks_store.save(tasks)
    return jsonify(tasks)


# ---------------------------------------------------------------- ショートカット

SHORTCUT_TYPES = ("folder", "app", "url")


@app.get("/api/shortcuts")
def list_shortcuts():
    return jsonify(shortcuts_store.load())


@app.post("/api/shortcuts")
def add_shortcut():
    body = request.get_json(force=True) or {}
    name = (body.get("name") or "").strip()
    target = (body.get("target") or "").strip()
    kind = body.get("type")
    if not name or not target or kind not in SHORTCUT_TYPES:
        abort(400)
    if kind == "url" and urlparse(target).scheme not in ("http", "https"):
        return jsonify({"ok": False, "error": "URL は http:// か https:// で始めてください"}), 400
    items = shortcuts_store.load()
    items.append({"id": new_id(), "name": name, "type": kind, "target": target,
                  "args": (body.get("args") or "").strip()})
    shortcuts_store.save(items)
    return jsonify(items)


@app.put("/api/shortcuts/order")
def reorder_shortcuts():
    order = (request.get_json(force=True) or {}).get("ids", [])
    items = {s["id"]: s for s in shortcuts_store.load()}
    sorted_items = [items.pop(i) for i in order if i in items] + list(items.values())
    shortcuts_store.save(sorted_items)
    return jsonify(sorted_items)


@app.delete("/api/shortcuts/<sid>")
def delete_shortcut(sid):
    items = [s for s in shortcuts_store.load() if s["id"] != sid]
    shortcuts_store.save(items)
    return jsonify(items)


@app.post("/api/shortcuts/<sid>/open")
def open_shortcut(sid):
    item = next((s for s in shortcuts_store.load() if s["id"] == sid), None)
    if not item:
        abort(404)
    if item["type"] == "url":
        return jsonify({"ok": True, "url": item["target"]})  # ブラウザ側で開く
    target = os.path.expandvars(os.path.expanduser(item["target"]))
    try:
        launch(target, item.get("args", ""))
    except Exception as e:
        return jsonify({"ok": False, "error": f"{type(e).__name__}: {e}"}), 500
    return jsonify({"ok": True})


def launch(target, args=""):
    """フォルダ・ファイル・アプリを OS の既定の方法で開く。"""
    if sys.platform == "win32":
        if args:
            os.startfile(target, "open", args)  # Python 3.10+
        else:
            os.startfile(target)
    elif sys.platform == "darwin":
        cmd = ["open", target] + (["--args", *args.split()] if args else [])
        subprocess.Popen(cmd)
    else:
        if args or (os.path.isfile(target) and os.access(target, os.X_OK)):
            subprocess.Popen([target, *args.split()])
        else:
            subprocess.Popen(["xdg-open", target])


def uses_google():
    return "google" in (CFG["mail"].get("provider"), CFG["calendar"].get("provider"))


if __name__ == "__main__":
    from dashboard import google_api

    gcfg = CFG.get("google", {})
    if "--google-login" in sys.argv or (uses_google() and not google_api.has_token(gcfg, BASE)):
        print("ブラウザで Google にログインしてください...")
        google_api.login(gcfg, BASE)
        print("ログイン情報を保存しました")
    srv = CFG.get("server", {})
    app.run(host=srv.get("host", "127.0.0.1"), port=int(srv.get("port", 8080)))
