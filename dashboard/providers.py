"""外部データ取得（メール / カレンダー / Redmine）。

各関数は例外を投げる可能性がある。呼び出し側（app.py）でエラーを UI に返す。
"""

import imaplib
import json
import ssl
import sys
import urllib.parse
import urllib.request
from datetime import date, datetime, time, timedelta


# ---------------------------------------------------------------- メール

def mail_counts(cfg, google_cfg=None, base=None):
    provider = cfg.get("provider", "demo")
    if provider == "google":
        from . import google_api
        return google_api.mail_counts(google_cfg or {}, base)
    if provider == "imap":
        return _imap_counts(cfg["imap"])
    if provider == "outlook":
        return _outlook_mail_counts(cfg.get("outlook", {}))
    if provider == "demo":
        return {"received_today": 23, "unread": 5, "demo": True}
    raise ValueError(f"未対応のメールプロバイダです: {provider}")


def _imap_counts(c):
    conn = imaplib.IMAP4_SSL(c["host"], int(c.get("port", 993)))
    try:
        conn.login(c["user"], c["password"])
        conn.select(_imap_quote(c.get("folder", "INBOX")), readonly=True)
        # IMAP の SINCE は日付単位（時刻・タイムゾーンは無視される: RFC 3501）
        since = date.today().strftime("%d-%b-%Y")
        _, today_ids = conn.search(None, "SINCE", since)
        _, unread_ids = conn.search(None, "UNSEEN")
        return {
            "received_today": len(today_ids[0].split()) if today_ids[0] else 0,
            "unread": len(unread_ids[0].split()) if unread_ids[0] else 0,
        }
    finally:
        try:
            conn.logout()
        except Exception:
            pass


def _imap_quote(name):
    return '"' + name.replace("\\", "\\\\").replace('"', '\\"') + '"'


def _outlook_namespace():
    if sys.platform != "win32":
        raise RuntimeError("Outlook プロバイダは Windows でのみ利用できます")
    import pythoncom  # pywin32
    import win32com.client

    pythoncom.CoInitialize()
    return win32com.client.Dispatch("Outlook.Application").GetNamespace("MAPI")


def _outlook_mail_counts(_c):
    ns = _outlook_namespace()
    inbox = ns.GetDefaultFolder(6)  # olFolderInbox
    items = inbox.Items
    items.Sort("[ReceivedTime]", True)  # 新しい順
    start = datetime.combine(date.today(), time.min)
    count = 0
    item = items.GetFirst()
    while item is not None:
        received = getattr(item, "ReceivedTime", None)
        if received is None:
            item = items.GetNext()
            continue
        if datetime(received.year, received.month, received.day,
                    received.hour, received.minute) < start:
            break
        count += 1
        item = items.GetNext()
    return {"received_today": count, "unread": int(inbox.UnReadItemCount)}


# ---------------------------------------------------------------- チャット

def chat_unread(cfg, google_cfg=None, base=None):
    provider = cfg.get("provider", "demo")
    if provider == "google":
        from . import google_api
        return google_api.chat_unread(google_cfg or {}, base)
    if provider == "demo":
        return {
            "spaces": [
                {"name": "開発チーム", "type": "SPACE", "unread": 4, "over": False, "url": ""},
                {"name": "ダイレクト メッセージ", "type": "DIRECT_MESSAGE", "unread": 2, "over": False, "url": ""},
                {"name": "全社連絡", "type": "SPACE", "unread": 1, "over": False, "url": ""},
            ],
            "total": 7, "over": False, "demo": True,
        }
    raise ValueError(f"未対応のチャットプロバイダです: {provider}")


# ---------------------------------------------------------------- カレンダー

def today_events(cfg, google_cfg=None, base=None):
    provider = cfg.get("provider", "demo")
    if provider == "google":
        from . import google_api
        events = google_api.today_events(google_cfg or {}, base)
    elif provider == "ics":
        events = _ics_events(cfg.get("ics_urls", []))
    elif provider == "outlook":
        events = _outlook_events()
    elif provider == "demo":
        return {"events": _demo_events(), "demo": True}
    else:
        raise ValueError(f"未対応のカレンダープロバイダです: {provider}")
    events.sort(key=lambda e: (not e["all_day"], e["start"] or ""))
    return {"events": events}


def _demo_events():
    d = date.today().isoformat()
    return [
        {"title": "朝会", "start": f"{d}T09:30", "end": f"{d}T09:45", "all_day": False, "location": "会議室A"},
        {"title": "設計レビュー", "start": f"{d}T13:00", "end": f"{d}T14:00", "all_day": False, "location": "Teams"},
        {"title": "顧客定例", "start": f"{d}T16:00", "end": f"{d}T17:00", "all_day": False, "location": ""},
    ]


def _ics_events(urls):
    import icalendar
    import recurring_ical_events

    start = datetime.combine(date.today(), time.min)
    end = start + timedelta(days=1)
    out = []
    for url in urls:
        with urllib.request.urlopen(url, timeout=15) as res:
            cal = icalendar.Calendar.from_ical(res.read())
        for ev in recurring_ical_events.of(cal).between(start, end):
            s = ev.get("DTSTART").dt
            e = ev.get("DTEND").dt if ev.get("DTEND") else None
            all_day = not isinstance(s, datetime)
            out.append({
                "title": str(ev.get("SUMMARY", "(無題)")),
                "start": _iso_local(s),
                "end": _iso_local(e) if e else None,
                "all_day": all_day,
                "location": str(ev.get("LOCATION", "")),
            })
    return out


def _iso_local(v):
    if isinstance(v, datetime):
        if v.tzinfo is not None:
            v = v.astimezone().replace(tzinfo=None)  # PC のローカル時刻へ
        return v.strftime("%Y-%m-%dT%H:%M")
    return v.isoformat()


def _outlook_events():
    ns = _outlook_namespace()
    items = ns.GetDefaultFolder(9).Items  # olFolderCalendar
    items.IncludeRecurrences = True
    items.Sort("[Start]")
    start = datetime.combine(date.today(), time.min)
    end = start + timedelta(days=1)
    fmt = "%m/%d/%Y %I:%M %p"
    restricted = items.Restrict(
        f"[Start] < '{end.strftime(fmt)}' AND [End] > '{start.strftime(fmt)}'"
    )
    out = []
    for it in restricted:
        s, e = it.Start, it.End
        out.append({
            "title": it.Subject or "(無題)",
            "start": f"{s.year:04d}-{s.month:02d}-{s.day:02d}T{s.hour:02d}:{s.minute:02d}",
            "end": f"{e.year:04d}-{e.month:02d}-{e.day:02d}T{e.hour:02d}:{e.minute:02d}",
            "all_day": bool(it.AllDayEvent),
            "location": it.Location or "",
        })
    return out


# ---------------------------------------------------------------- Redmine

def redmine_issues(cfg):
    if cfg.get("demo"):
        return {"issues": _demo_issues(), "base_url": "", "demo": True}

    base = cfg["url"].rstrip("/")
    today = date.today()
    until = today + timedelta(days=int(cfg.get("days_ahead", 7)))
    if cfg.get("include_overdue", True):
        due = f"<={until.isoformat()}"
    else:
        due = f"><{today.isoformat()}|{until.isoformat()}"
    params = {
        "assigned_to_id": "me",
        "status_id": "open",
        "due_date": due,
        "sort": "due_date",
        "limit": int(cfg.get("limit", 20)),
    }
    url = f"{base}/issues.json?{urllib.parse.urlencode(params)}"
    req = urllib.request.Request(url, headers={"X-Redmine-API-Key": cfg["api_key"]})
    ctx = None if cfg.get("verify_ssl", True) else ssl._create_unverified_context()
    with urllib.request.urlopen(req, timeout=15, context=ctx) as res:
        body = json.load(res)

    issues = []
    for i in body.get("issues", []):
        issues.append({
            "id": i["id"],
            "subject": i.get("subject", ""),
            "project": i.get("project", {}).get("name", ""),
            "tracker": i.get("tracker", {}).get("name", ""),
            "status": i.get("status", {}).get("name", ""),
            "priority": i.get("priority", {}).get("name", ""),
            "due_date": i.get("due_date"),
            "done_ratio": i.get("done_ratio", 0),
        })
    return {"issues": issues, "base_url": base}


def _demo_issues():
    t = date.today()
    rows = [
        (1201, "ログイン画面のバリデーション修正", "社内ポータル", -1, "進行中", "高め", 60),
        (1188, "月次レポート出力の高速化", "分析基盤", 0, "新規", "通常", 0),
        (1210, "API 仕様書の更新", "社内ポータル", 2, "進行中", "通常", 30),
        (1175, "テスト環境の証明書更新", "インフラ", 5, "新規", "急いで", 0),
    ]
    return [
        {"id": i, "subject": s, "project": p, "tracker": "タスク", "status": st,
         "priority": pr, "due_date": (t + timedelta(days=d)).isoformat(), "done_ratio": r}
        for i, s, p, d, st, pr, r in rows
    ]
