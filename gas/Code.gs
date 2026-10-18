/**
 * 仕事用ダッシュボード（Google Apps Script ウェブアプリ）。
 * 画面側からは google.script.run で下の関数を呼ぶ。
 * google.script.run は Date を受け渡しできないため、日時はすべて文字列で返す。
 */

function doGet() {
  return HtmlService.createTemplateFromFile('index')
    .evaluate()
    .setTitle('Work Dashboard')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1');
}

function include(name) {
  return HtmlService.createHtmlOutputFromFile(name).getContent();
}

// ---------------------------------------------------------------- 共通

function tz_() {
  return Session.getScriptTimeZone();
}

function fmt_(date, pattern) {
  return Utilities.formatDate(date, tz_(), pattern);
}

function todayISO_(now) {
  return fmt_(now || new Date(), 'yyyy-MM-dd');
}

/** スクリプトのタイムゾーンでの今日 0 時。 */
function startOfToday_(now) {
  now = now || new Date();
  return new Date(fmt_(now, 'yyyy-MM-dd') + 'T00:00:00' + fmt_(now, 'XXX'));
}

function props_() {
  return PropertiesService.getUserProperties();
}

function loadJson_(key, fallback) {
  const v = props_().getProperty(key);
  return v ? JSON.parse(v) : fallback;
}

function saveJson_(key, value) {
  props_().setProperty(key, JSON.stringify(value));
}

/** CacheService で結果を一定時間使い回す。force=true で取り直す。 */
function cached_(key, seconds, force, fn) {
  const cache = CacheService.getUserCache();
  if (!force) {
    const hit = cache.get(key);
    if (hit) return JSON.parse(hit);
  }
  const value = fn();
  value.fetched_at = fmt_(new Date(), 'HH:mm');
  cache.put(key, JSON.stringify(value), seconds);
  return value;
}

/** 取得失敗は例外ではなく { ok:false, error } で返し、画面に表示する。 */
function safe_(fn) {
  try {
    return Object.assign({ ok: true }, fn());
  } catch (e) {
    console.warn(e);
    return { ok: false, error: String(e && e.message ? e.message : e) };
  }
}

// ---------------------------------------------------------------- 勤怠

function parseHM_(s) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(s || '');
  if (!m) throw new Error('時刻は HH:MM 形式で入力してください');
  return Number(m[1]) * 60 + Number(m[2]);
}

function fmtHM_(min) {
  return ('0' + Math.floor(min / 60)).slice(-2) + ':' + ('0' + (min % 60)).slice(-2);
}

function standardMinutes_() {
  const w = CONFIG.work;
  return Math.max(0, parseHM_(w.end) - parseHM_(w.start) - w.breakMinutes);
}

/**
 * 勤務時間と残業時間（分）。
 * 勤務 = 退勤 − 出勤 − 休憩（休憩は拘束時間を上限に差し引く）
 * 残業 = 勤務 − 所定労働時間（0 未満は 0）
 * 退勤未記録の当日は nowMin（現在時刻）で計算する。
 */
function dayMinutes_(rec, nowMin) {
  if (!rec || !rec.in) return { worked: 0, overtime: 0 };
  const tIn = parseHM_(rec.in);
  let tOut;
  if (rec.out) {
    tOut = parseHM_(rec.out);
    if (tOut < tIn) tOut += 24 * 60; // 日付をまたいだ退勤
  } else if (nowMin != null) {
    tOut = nowMin;
  } else {
    return { worked: 0, overtime: 0 };
  }
  const span = Math.max(0, tOut - tIn);
  const worked = Math.max(0, span - Math.min(CONFIG.work.breakMinutes, span));
  return { worked: worked, overtime: Math.max(0, worked - standardMinutes_()) };
}

// 勤怠は月ごとに 1 つのプロパティへ保存する（1 値あたりのサイズ上限対策）
function monthKey_(day) {
  return 'att:' + day.slice(0, 7);
}

function getAttendance() {
  const now = new Date();
  const today = todayISO_(now);
  const key = monthKey_(today);
  const month = loadJson_(key, {});
  if (CONFIG.work.autoClockIn && !month[today]) {
    month[today] = { in: fmt_(now, 'HH:mm'), out: null };
    saveJson_(key, month);
  }
  const nowMin = parseHM_(fmt_(now, 'HH:mm'));
  const rec = month[today];
  const cur = dayMinutes_(rec, nowMin);

  let monthOt = 0;
  let monthDays = 0;
  Object.keys(month).forEach(function (d) {
    monthOt += dayMinutes_(month[d], d === today ? nowMin : null).overtime;
    if (month[d] && month[d].in) monthDays++;
  });

  let plannedOut = null;
  if (rec && rec.in) {
    plannedOut = fmtHM_((parseHM_(rec.in) + standardMinutes_() + CONFIG.work.breakMinutes) % (24 * 60));
  }

  return {
    date: today,
    clock_in: rec ? rec.in : null,
    clock_out: rec ? rec.out : null,
    planned_out: plannedOut,
    standard_minutes: standardMinutes_(),
    break_minutes: CONFIG.work.breakMinutes,
    worked_minutes: cur.worked,
    overtime_minutes: cur.overtime,
    month_overtime_minutes: monthOt,
    month_work_days: monthDays,
  };
}

/** action: clock_in / clock_out / edit（edit は times.in / times.out。空文字で消去） */
function updateAttendance(action, times) {
  const now = new Date();
  const today = todayISO_(now);
  const key = monthKey_(today);
  const month = loadJson_(key, {});
  const rec = month[today] || { in: null, out: null };
  const hm = fmt_(now, 'HH:mm');
  if (action === 'clock_in') {
    rec.in = hm;
    rec.out = null;
  } else if (action === 'clock_out') {
    rec.out = hm;
  } else if (action === 'edit') {
    ['in', 'out'].forEach(function (k) {
      if (times && k in times) {
        if (times[k]) parseHM_(times[k]);
        rec[k] = times[k] || null;
      }
    });
  } else {
    throw new Error('不明な操作です: ' + action);
  }
  month[today] = rec;
  saveJson_(key, month);
  return getAttendance();
}

// ---------------------------------------------------------------- メール

/**
 * 今日の受信数: 今日 0 時以降に届いたメール（自分の送信・下書き・チャットを除く、アーカイブ済みを含む）
 * 未読数: 受信トレイの未読メール数（スレッド数ではなくメール数）
 */
function getMail(force) {
  return safe_(function () {
    return cached_('mail', CONFIG.mail.cacheSeconds, force, function () {
      const midnight = startOfToday_();
      const me = Session.getEffectiveUser().getEmail().toLowerCase();
      // Gmail の after:YYYY/MM/DD は PST 基準のため、UNIX 秒で指定する
      const q = 'after:' + Math.floor(midnight.getTime() / 1000) + ' -in:sent -in:drafts -in:chats';
      const today = countMessages_(q, function (m) {
        return m.getDate() >= midnight && !m.isDraft() && m.getFrom().toLowerCase().indexOf(me) < 0;
      });
      const unread = countMessages_('in:inbox is:unread', function (m) {
        return m.isUnread() && m.isInInbox();
      });
      return {
        received_today: today.count,
        unread: unread.count,
        over: today.over || unread.over,
      };
    });
  });
}

function countMessages_(query, pred) {
  const page = 100;
  let count = 0;
  let start = 0;
  while (start < CONFIG.mail.maxThreads) {
    const threads = GmailApp.search(query, start, page);
    if (!threads.length) return { count: count, over: false };
    GmailApp.getMessagesForThreads(threads).forEach(function (msgs) {
      msgs.forEach(function (m) {
        if (pred(m)) count++;
      });
    });
    if (threads.length < page) return { count: count, over: false };
    start += page;
  }
  return { count: count, over: true };
}

// ---------------------------------------------------------------- カレンダー

function getEvents(force) {
  return safe_(function () {
    return cached_('calendar', 300, force, function () {
      const ids = CONFIG.calendar.calendarIds;
      const cals = ids && ids.length
        ? ids.map(function (id) {
            const c = CalendarApp.getCalendarById(id);
            if (!c) throw new Error('カレンダーが見つかりません: ' + id);
            return c;
          })
        : [CalendarApp.getDefaultCalendar()];
      const now = new Date();
      const events = [];
      cals.forEach(function (cal) {
        cal.getEventsForDay(now).forEach(function (ev) {
          if (ev.getMyStatus() === CalendarApp.GuestStatus.NO) return; // 不参加と回答済み
          const allDay = ev.isAllDayEvent();
          events.push({
            title: ev.getTitle() || '(無題)',
            start: allDay ? fmt_(ev.getAllDayStartDate(), 'yyyy-MM-dd') : fmt_(ev.getStartTime(), "yyyy-MM-dd'T'HH:mm"),
            end: allDay ? fmt_(ev.getAllDayEndDate(), 'yyyy-MM-dd') : fmt_(ev.getEndTime(), "yyyy-MM-dd'T'HH:mm"),
            all_day: allDay,
            location: ev.getLocation() || '',
          });
        });
      });
      events.sort(function (a, b) {
        return (a.all_day === b.all_day ? 0 : a.all_day ? -1 : 1) || a.start.localeCompare(b.start);
      });
      return { events: events };
    });
  });
}

// ---------------------------------------------------------------- チャット（Chat 拡張サービス）

/**
 * スペース（DM・グループ・スペース）ごとの未読メッセージ数。
 * 自分の既読位置（spaceReadState.lastReadTime）より後に作成されたメッセージを数える。
 */
function getChat(force) {
  if (!CONFIG.chat.enabled) return { ok: true, disabled: true };
  return safe_(function () {
    return cached_('chat', CONFIG.chat.cacheSeconds, force, function () {
      const max = 99;
      let spaces = [];
      let pageToken;
      do {
        const res = Chat.Spaces.list({ pageSize: 1000, pageToken: pageToken });
        spaces = spaces.concat(res.spaces || []);
        pageToken = res.nextPageToken;
      } while (pageToken);

      spaces.sort(function (a, b) {
        return (b.lastActiveTime || '').localeCompare(a.lastActiveTime || '');
      });
      const out = [];
      spaces.slice(0, CONFIG.chat.maxSpaces).forEach(function (sp) {
        const state = Chat.Users.Spaces.getSpaceReadState('users/me/' + sp.name + '/spaceReadState');
        const lastRead = state.lastReadTime;
        if (lastRead && sp.lastActiveTime && ts_(sp.lastActiveTime) <= ts_(lastRead)) return;
        const args = { pageSize: max + 1 };
        if (lastRead) args.filter = 'createTime > "' + lastRead + '"';
        const n = (Chat.Spaces.Messages.list(sp.name, args).messages || []).length;
        if (n) {
          out.push({
            name: sp.displayName || (sp.spaceType === 'DIRECT_MESSAGE' ? 'ダイレクト メッセージ' : 'グループ チャット'),
            unread: Math.min(n, max),
            over: n > max,
            url: sp.spaceUri || 'https://chat.google.com/',
          });
        }
      });
      out.sort(function (a, b) { return b.unread - a.unread; });
      return {
        spaces: out,
        total: out.reduce(function (s, x) { return s + x.unread; }, 0),
        over: out.some(function (x) { return x.over; }),
      };
    });
  });
}

/** API の時刻（小数秒が最大 9 桁）をミリ秒に。 */
function ts_(iso) {
  return new Date(iso.replace(/(\.\d{3})\d*/, '$1')).getTime();
}

// ---------------------------------------------------------------- Redmine

function getRedmine(force) {
  const c = CONFIG.redmine;
  if (!c.enabled) return { ok: true, disabled: true };
  return safe_(function () {
    return cached_('redmine', c.cacheSeconds, force, function () {
      const key = PropertiesService.getScriptProperties().getProperty('REDMINE_API_KEY');
      if (!key) throw new Error('スクリプト プロパティ REDMINE_API_KEY が設定されていません');
      const base = c.url.replace(/\/+$/, '');
      const today = startOfToday_();
      const until = fmt_(new Date(today.getTime() + c.daysAhead * 86400000), 'yyyy-MM-dd');
      const due = c.includeOverdue ? '<=' + until : '><' + todayISO_() + '|' + until;
      const params = {
        assigned_to_id: 'me',
        status_id: 'open',
        due_date: due,
        sort: 'due_date',
        limit: c.limit,
      };
      const qs = Object.keys(params).map(function (k) {
        return k + '=' + encodeURIComponent(params[k]);
      }).join('&');
      const res = UrlFetchApp.fetch(base + '/issues.json?' + qs, {
        headers: { 'X-Redmine-API-Key': key },
        muteHttpExceptions: true,
      });
      if (res.getResponseCode() !== 200) {
        throw new Error('Redmine から HTTP ' + res.getResponseCode() + ' が返りました');
      }
      const issues = (JSON.parse(res.getContentText()).issues || []).map(function (i) {
        return {
          id: i.id,
          subject: i.subject || '',
          project: (i.project || {}).name || '',
          status: (i.status || {}).name || '',
          priority: (i.priority || {}).name || '',
          due_date: i.due_date,
          done_ratio: i.done_ratio || 0,
        };
      });
      return { issues: issues, base_url: base };
    });
  });
}

// ---------------------------------------------------------------- タスク

function getTasks() {
  return loadJson_('tasks', []);
}

function addTask(title, due) {
  title = String(title || '').trim();
  if (!title) throw new Error('タスク名を入力してください');
  const tasks = getTasks();
  tasks.push({ id: Utilities.getUuid().slice(0, 12), title: title, due: due || todayISO_(), done: false });
  return saveTasks_(tasks);
}

function updateTask(id, done) {
  const tasks = getTasks();
  tasks.forEach(function (t) {
    if (t.id === id) {
      t.done = !!done;
      t.done_on = done ? todayISO_() : null;
    }
  });
  return saveTasks_(tasks);
}

function deleteTask(id) {
  return saveTasks_(getTasks().filter(function (t) { return t.id !== id; }));
}

function saveTasks_(tasks) {
  // 完了から 30 日たったタスクは削除（プロパティのサイズ上限対策）
  const limit = fmt_(new Date(Date.now() - 30 * 86400000), 'yyyy-MM-dd');
  tasks = tasks.filter(function (t) { return !t.done || !t.done_on || t.done_on >= limit; });
  saveJson_('tasks', tasks);
  return tasks;
}

// ---------------------------------------------------------------- ショートカット

/** type: url（新しいタブで開く）/ folder（パスをコピー） */
function getShortcuts() {
  return loadJson_('shortcuts', [
    { id: 'sample-drive', name: 'Google ドライブ', type: 'url', target: 'https://drive.google.com/' },
  ]);
}

function addShortcut(item) {
  const name = String(item.name || '').trim();
  const target = String(item.target || '').trim();
  if (!name || !target) throw new Error('表示名とリンク先を入力してください');
  if (item.type === 'url' && !/^https?:\/\//i.test(target)) {
    throw new Error('URL は http:// か https:// で始めてください');
  }
  if (item.type !== 'url' && item.type !== 'folder') throw new Error('種類が不正です');
  const items = getShortcuts();
  items.push({ id: Utilities.getUuid().slice(0, 12), name: name, type: item.type, target: target });
  saveJson_('shortcuts', items);
  return items;
}

function deleteShortcut(id) {
  const items = getShortcuts().filter(function (s) { return s.id !== id; });
  saveJson_('shortcuts', items);
  return items;
}

function reorderShortcuts(ids) {
  const byId = {};
  getShortcuts().forEach(function (s) { byId[s.id] = s; });
  const sorted = [];
  ids.forEach(function (id) {
    if (byId[id]) {
      sorted.push(byId[id]);
      delete byId[id];
    }
  });
  Object.keys(byId).forEach(function (id) { sorted.push(byId[id]); });
  saveJson_('shortcuts', sorted);
  return sorted;
}
