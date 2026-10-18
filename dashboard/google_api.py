"""Gmail / Google カレンダー（Google API + OAuth）。

初回は `python app.py --google-login` でブラウザからログインし、
トークンを data/google_token.json に保存する（以後は自動で更新）。
"""

import os
import threading
from datetime import date, datetime, time, timedelta

SCOPES = [
    # gmail.metadata スコープでは検索クエリ (q) が使えないため readonly を使う
    "https://www.googleapis.com/auth/gmail.readonly",
    "https://www.googleapis.com/auth/calendar.readonly",
]

_lock = threading.Lock()


def _paths(cfg, base):
    secret = os.path.join(base, cfg.get("client_secret", "credentials.json"))
    token = os.path.join(base, cfg.get("token", "data/google_token.json"))
    return secret, token


def login(cfg, base):
    """ブラウザで OAuth 同意画面を開き、トークンを保存する。"""
    from google_auth_oauthlib.flow import InstalledAppFlow

    secret, token = _paths(cfg, base)
    if not os.path.exists(secret):
        raise FileNotFoundError(
            f"{secret} がありません。Google Cloud で作成した OAuth クライアント"
            "（デスクトップ アプリ）の JSON を置いてください（README 参照）"
        )
    flow = InstalledAppFlow.from_client_secrets_file(secret, SCOPES)
    creds = flow.run_local_server(port=0)
    os.makedirs(os.path.dirname(token), exist_ok=True)
    with open(token, "w", encoding="utf-8") as f:
        f.write(creds.to_json())


def has_token(cfg, base):
    return os.path.exists(_paths(cfg, base)[1])


def _credentials(cfg, base):
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials

    _, token = _paths(cfg, base)
    if not os.path.exists(token):
        raise RuntimeError("Google にログインしていません。`python app.py --google-login` を実行してください")
    with _lock:
        creds = Credentials.from_authorized_user_file(token, SCOPES)
        if not creds.valid:
            if creds.expired and creds.refresh_token:
                creds.refresh(Request())
                with open(token, "w", encoding="utf-8") as f:
                    f.write(creds.to_json())
            else:
                raise RuntimeError("Google のログイン情報が無効です。`python app.py --google-login` を再実行してください")
    return creds


def _service(name, version, cfg, base):
    from googleapiclient.discovery import build

    return build(name, version, credentials=_credentials(cfg, base), cache_discovery=False)


# ---------------------------------------------------------------- Gmail

def mail_counts(cfg, base, service=None):
    gmail = service or _service("gmail", "v1", cfg, base)
    # Gmail の after:YYYY/MM/DD は PST 基準になるため、ローカルの 0 時を UNIX 秒で渡す
    midnight = int(datetime.combine(date.today(), time.min).timestamp())
    query = f"after:{midnight} -in:sent -in:drafts -in:chats"

    received = 0
    page = None
    while True:
        res = gmail.users().messages().list(
            userId="me", q=query, maxResults=500, pageToken=page,
            fields="messages/id,nextPageToken",
        ).execute()
        received += len(res.get("messages", []))
        page = res.get("nextPageToken")
        if not page:
            break

    inbox = gmail.users().labels().get(userId="me", id="INBOX").execute()
    return {"received_today": received, "unread": int(inbox.get("messagesUnread", 0))}


# ---------------------------------------------------------------- Calendar

def today_events(cfg, base, service=None):
    cal = service or _service("calendar", "v3", cfg, base)
    start = datetime.combine(date.today(), time.min).astimezone()
    end = start + timedelta(days=1)
    out = []
    for cal_id in cfg.get("calendar_ids") or ["primary"]:
        page = None
        while True:
            res = cal.events().list(
                calendarId=cal_id,
                timeMin=start.isoformat(),
                timeMax=end.isoformat(),
                singleEvents=True,  # 繰り返し予定を個別の予定に展開
                orderBy="startTime",
                pageToken=page,
            ).execute()
            for ev in res.get("items", []):
                if ev.get("status") == "cancelled" or _declined(ev):
                    continue
                s, e = ev.get("start", {}), ev.get("end", {})
                all_day = "date" in s
                out.append({
                    "title": ev.get("summary", "(無題)"),
                    "start": s.get("date") if all_day else _local(s.get("dateTime")),
                    "end": e.get("date") if all_day else _local(e.get("dateTime")),
                    "all_day": all_day,
                    "location": ev.get("location", "") or ("Google Meet" if ev.get("hangoutLink") else ""),
                })
            page = res.get("nextPageToken")
            if not page:
                break
    return out


def _declined(ev):
    return any(a.get("self") and a.get("responseStatus") == "declined"
               for a in ev.get("attendees", []))


def _local(iso):
    if not iso:
        return None
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00"))
    return dt.astimezone().strftime("%Y-%m-%dT%H:%M")
