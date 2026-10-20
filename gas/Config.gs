/**
 * ダッシュボードの設定。
 * Redmine の API キーはここに書かず、スクリプト プロパティ REDMINE_API_KEY に保存する（README 参照）。
 */
const CONFIG = {
  work: {
    start: '09:00',
    end: '17:30',
    breakMinutes: 60,
    autoClockIn: true, // その日に初めて開いた時刻を出勤として記録
  },

  mail: {
    cacheSeconds: 300,
    maxThreads: 500, // 数えるスレッドの上限（多すぎると実行時間の上限に達するため）
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
