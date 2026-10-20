/**
 * ファイル名: Config.gs
 * 概要: ダッシュボードの設定。
 *       Redmine の API キーはここに書かず、スクリプト プロパティ REDMINE_API_KEY に保存する（README 参照）。
 *
 * 更新履歴:
 *   2026-10-18  新規作成（勤務時間 9:00〜17:30、メール、カレンダー、チャット、Redmine の設定）
 *   2026-10-20  タスク（Google ToDo リスト）の設定を追加
 *   2026-10-20  ファイルヘッダに更新履歴を追加
 *   2026-10-20  メールの設定を新着メールの概要表示用（検索条件・表示件数・本文の文字数）に変更
 */
const CONFIG = {
  work: {
    start: '09:00',
    end: '17:30',
    breakMinutes: 60,
    autoClockIn: true, // その日に初めて開いた時刻を出勤として記録
  },

  mail: {
    cacheSeconds: 120,
    query: 'in:inbox', // 表示するメールの検索条件（Gmail の検索と同じ書き方。例: 'in:inbox is:unread'）
    maxItems: 10, // 表示する件数（スレッド単位）
    snippetLength: 100, // 本文の冒頭を何文字表示するか
  },

  calendar: {
    calendarIds: [], // 空なら自分のメインカレンダー。追加するならカレンダー ID を並べる
  },

  tasks: {
    provider: 'google', // 'google'（Google ToDo リスト）または 'local'（ダッシュボード内に保存）
    lists: [], // 表示する Google ToDo のリスト名。空ならすべてのリスト
    addToList: '@default', // 追加先のリスト ID（'@default' は既定のリスト）
    showNoDue: true, // 期限なしの未完了タスクも表示する
  },

  chat: {
    enabled: true,
    cacheSeconds: 120,
    maxSpaces: 30, // 最近動きのあったスペースから何件調べるか
  },

  redmine: {
    enabled: true,
    url: 'https://redmine.example.com',
    daysAhead: 7,
    includeOverdue: true,
    limit: 20,
    cacheSeconds: 300,
  },
};
