# 仕事用ダッシュボード

PC 上で動かすローカル Web アプリです。ブラウザで開いて使います。

| 機能 | 内容 |
| --- | --- |
| 時計・残業時間 | 現在時刻、出退勤時刻、本日の勤務時間・残業時間、今月の残業時間合計 |
| カレンダー | 月表示カレンダー（タスク期限日に印）、今日の予定一覧 |
| タスク | 今日のタスク（期限切れを含む）の追加・完了・削除 |
| メール | 今日の受信メール数、未読メール数 |
| Redmine | 自分が担当の未完了チケットのうち、期日が近いもの・期限切れのもの |
| ショートカット | フォルダ・アプリ・URL を登録してワンクリックで開く（ドラッグで並べ替え） |

## 起動方法

Python 3.10 以上が必要です。

- Windows: `start.bat` をダブルクリック（初回は仮想環境を作って依存パッケージを入れます）
- macOS / Linux: `./start.sh`

起動後 http://127.0.0.1:8080 を開きます。

`config.json` が無い場合はデモデータで起動します。実データにつなぐには
`config.example.json` を `config.json` にコピーして編集してください。

## 設定（config.json）

### 勤務時間（残業の計算）

```json
"work": { "start": "09:00", "end": "18:00", "break_minutes": 60, "auto_clock_in": true }
```

- 所定労働時間 = `end − start − break_minutes`（上の例では 8 時間）
- 勤務時間 = 退勤 − 出勤 − 休憩（休憩は勤務開始時点から差し引きます）
- 残業時間 = 勤務時間 − 所定労働時間（マイナスは 0）
- 退勤前は現在時刻で計算し、1 分ごとに更新します
- `auto_clock_in: true` のときは、その日に初めてダッシュボードを開いた時刻を出勤時刻として記録します。
  出退勤時刻は画面上で手入力して修正できます
- 今月の残業が 30 時間以上で黄色、45 時間（36 協定の原則的な月の上限）以上で赤色になります
- 記録は `data/attendance.json` に保存されます

### メール

| `provider` | 説明 |
| --- | --- |
| `demo` | デモデータ |
| `imap` | IMAP サーバーに接続（`mail.imap` を設定） |
| `outlook` | Windows の Outlook デスクトップアプリの受信トレイを読む（`pywin32` が必要） |

- 「今日の受信」は IMAP の `SINCE 今日` で数えます。IMAP の仕様上、日付判定はサーバー側の日付単位です
- Gmail を IMAP で読む場合は、Google アカウントの「アプリ パスワード」を使います
- パスワードは環境変数 `DASHBOARD_IMAP_PASSWORD` でも指定できます

### カレンダー（今日の予定）

| `provider` | 説明 |
| --- | --- |
| `demo` | デモデータ |
| `ics` | iCalendar（.ics）の URL から読む。繰り返し予定にも対応。`ics_urls` に複数指定可 |
| `outlook` | Windows の Outlook デスクトップアプリの予定表を読む（`pywin32` が必要） |

Google カレンダーは「設定 → カレンダーの統合 → iCal 形式の非公開 URL」、
Outlook on the web は「予定表の公開」で ICS の URL を取得できます。

### Redmine

```json
"redmine": { "enabled": true, "demo": false, "url": "https://redmine.example.com",
             "api_key": "...", "days_ahead": 7, "include_overdue": true }
```

- 個人設定画面の「API アクセスキー」を `api_key` に設定します（環境変数 `DASHBOARD_REDMINE_API_KEY` でも可）。
  Redmine 側で REST API が有効になっている必要があります
- 取得条件: 担当者 = 自分、ステータス = 未完了、期日 ≦ 今日 + `days_ahead` 日（`include_overdue: false` なら今日以降のみ）
- 社内の自己署名証明書の場合は `verify_ssl: false` にできます

### ショートカット

画面右下の ✎ から登録・削除・並べ替えができます。

- フォルダ: `C:\Users\me\Documents`、`\\server\share` など
- アプリ / ファイル: `C:\Windows\notepad.exe`、Excel ファイルのパスなど（必要なら引数も指定可）
- URL: ブラウザの新しいタブで開きます

`~` と環境変数（例: `%USERPROFILE%\Desktop`）が使えます。登録内容は `data/shortcuts.json` に保存されます。

## セキュリティ

- サーバーは既定で `127.0.0.1` のみで待ち受けます。アプリ起動機能があるため、`host` を `0.0.0.0` などに変えて他の PC から接続できるようにはしないでください
- 書き込み系の API はカスタムヘッダー必須にしており、他の Web サイトからのリクエストは拒否されます
- `config.json` と `data/` は `.gitignore` 済みです

## 動作確認の範囲

- デモ / IMAP 以外の各機能（勤怠計算、ICS 読み込み、Redmine API のリクエスト、タスク、ショートカット API）は Linux 上で動作確認済み
- `outlook` プロバイダ（メール・予定）は Windows 専用のため、この環境では未検証です。
  予定の絞り込みでは Microsoft のドキュメントにある `mm/dd/yyyy hh:mm AM/PM` 形式の日時を使っています
- IMAP は実サーバーでは未検証です
