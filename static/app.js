"use strict";

const $ = (id) => document.getElementById(id);
const pad = (n) => String(n).padStart(2, "0");
const WEEK = ["日", "月", "火", "水", "木", "金", "土"];
// 36協定の原則的な上限（月45時間）を目安に色分けする
const MONTH_OT_WARN = 30 * 60;
const MONTH_OT_LIMIT = 45 * 60;

function todayISO(d = new Date()) {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}
function fmtMinutes(m) {
  return `${Math.floor(m / 60)}:${pad(m % 60)}`;
}
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => (
    { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
  ));
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    ...opts,
    headers: { "Content-Type": "application/json", "X-Dashboard": "1", ...(opts.headers || {}) },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

function toast(msg) {
  const t = $("toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3000);
}

/* ------------------------------------------------------------ 時計 */

let lastDay = todayISO();
function tickClock() {
  const d = new Date();
  $("clock-date").textContent =
    `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日（${WEEK[d.getDay()]}）`;
  $("clock-time").innerHTML =
    `${pad(d.getHours())}:${pad(d.getMinutes())}<span class="sec">:${pad(d.getSeconds())}</span>`;
  // 日付が変わったら全体を再読み込み
  if (todayISO(d) !== lastDay) {
    lastDay = todayISO(d);
    calMonth = new Date(d.getFullYear(), d.getMonth(), 1);
    loadAll();
  }
}

/* ------------------------------------------------------------ 勤怠 */

let att = null;
async function loadAttendance() {
  att = await api("/api/attendance");
  renderAttendance();
}

function renderAttendance() {
  if (!att) return;
  const active = document.activeElement;
  if (active !== $("att-in")) $("att-in").value = att.clock_in || "";
  if (active !== $("att-out")) $("att-out").value = att.clock_out || "";

  const btn = $("btn-clock");
  if (!att.clock_in) btn.textContent = "出勤する";
  else if (!att.clock_out) btn.textContent = "退勤する";
  else btn.textContent = "退勤を取り消す";

  $("att-worked").textContent = fmtMinutes(att.worked_minutes);
  const ot = $("att-ot");
  ot.textContent = fmtMinutes(att.overtime_minutes);
  ot.className = "stat-value" + (att.overtime_minutes > 0 ? " warn" : "");

  const mo = $("att-month");
  mo.textContent = fmtMinutes(att.month_overtime_minutes);
  mo.className = "stat-value" +
    (att.month_overtime_minutes >= MONTH_OT_LIMIT ? " danger"
      : att.month_overtime_minutes >= MONTH_OT_WARN ? " warn" : "");

  const std = att.standard_minutes || 1;
  const base = Math.min(att.worked_minutes, std);
  const total = Math.max(att.worked_minutes, std);
  $("att-bar").style.width = `${(base / total) * 100}%`;
  $("att-bar-ot").style.width = `${(att.overtime_minutes / total) * 100}%`;

  const notes = [`所定 ${fmtMinutes(att.standard_minutes)}（休憩 ${att.break_minutes}分）`];
  if (att.planned_out) {
    const remain = att.standard_minutes - att.worked_minutes;
    notes.push(`定時退勤の目安 ${att.planned_out}`);
    if (!att.clock_out && remain > 0) notes.push(`あと ${fmtMinutes(remain)}`);
  }
  notes.push(`今月の出勤 ${att.month_work_days}日`);
  $("att-note").textContent = notes.join(" ・ ");
}

$("btn-clock").addEventListener("click", async () => {
  let body;
  if (!att.clock_in) body = { action: "clock_in" };
  else if (!att.clock_out) body = { action: "clock_out" };
  else body = { action: "edit", out: "" };
  att = await api("/api/attendance", { method: "POST", body });
  renderAttendance();
});

for (const [id, key] of [["att-in", "in"], ["att-out", "out"]]) {
  $(id).addEventListener("change", async (e) => {
    try {
      att = await api("/api/attendance", { method: "POST", body: { action: "edit", [key]: e.target.value } });
      renderAttendance();
    } catch (err) {
      toast(err.message);
    }
  });
}

/* ------------------------------------------------------------ メール */

async function loadMail(refresh = false) {
  const r = await api("/api/mail" + (refresh ? "?refresh=1" : ""));
  if (!r.ok) {
    $("mail-today").textContent = "-";
    $("mail-unread").textContent = "-";
    $("mail-meta").innerHTML = `<span class="error">${esc(r.error)}</span>`;
    return;
  }
  $("mail-today").textContent = r.received_today;
  $("mail-unread").textContent = r.unread;
  $("mail-meta").textContent = `${r.demo ? "デモデータ ・ " : ""}${r.fetched_at} 更新`;
}

/* ------------------------------------------------------------ カレンダー */

let calMonth = new Date(new Date().getFullYear(), new Date().getMonth(), 1);
let tasks = [];

function renderCalendar() {
  const y = calMonth.getFullYear();
  const m = calMonth.getMonth();
  $("cal-title").textContent = `${y}年${m + 1}月`;
  const first = new Date(y, m, 1);
  const start = new Date(y, m, 1 - first.getDay());
  const today = todayISO();
  const dueDays = new Set(tasks.filter((t) => !t.done).map((t) => t.due));

  let html = "<tr>" + WEEK.map((w, i) =>
    `<th class="${i === 0 ? "sun" : i === 6 ? "sat" : ""}">${w}</th>`).join("") + "</tr>";
  for (let w = 0; w < 6; w++) {
    html += "<tr>";
    for (let i = 0; i < 7; i++) {
      const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + i);
      const iso = todayISO(d);
      const cls = [
        d.getMonth() !== m ? "other" : "",
        i === 0 ? "sun" : i === 6 ? "sat" : "",
        iso === today ? "today" : "",
      ].join(" ");
      const dot = `<span class="dot">${dueDays.has(iso) ? "•" : ""}</span>`;
      html += `<td class="${cls}" title="${dueDays.has(iso) ? "タスクあり" : ""}">${d.getDate()}${dot}</td>`;
    }
    html += "</tr>";
  }
  $("cal-grid").innerHTML = html;
}

$("cal-prev").addEventListener("click", () => {
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() - 1, 1);
  renderCalendar();
});
$("cal-next").addEventListener("click", () => {
  calMonth = new Date(calMonth.getFullYear(), calMonth.getMonth() + 1, 1);
  renderCalendar();
});

/* ------------------------------------------------------------ 今日の予定 */

let events = [];
async function loadEvents(refresh = false) {
  const r = await api("/api/calendar" + (refresh ? "?refresh=1" : ""));
  if (!r.ok) {
    $("events").innerHTML = "";
    $("events-meta").innerHTML = `<span class="error">${esc(r.error)}</span>`;
    return;
  }
  events = r.events;
  $("events-meta").textContent = `${r.demo ? "デモデータ ・ " : ""}${r.fetched_at} 更新`;
  renderEvents();
}

function renderEvents() {
  if (!events.length) {
    $("events").innerHTML = `<li class="empty">今日の予定はありません</li>`;
    return;
  }
  const now = new Date();
  $("events").innerHTML = events.map((e) => {
    let cls = "";
    let time = "終日";
    if (!e.all_day) {
      const s = new Date(e.start);
      const en = e.end ? new Date(e.end) : s;
      time = `${e.start.slice(11, 16)}–${e.end ? e.end.slice(11, 16) : ""}`;
      if (en < now) cls = "past";
      else if (s <= now) cls = "now";
    }
    return `<li class="${cls}">
      <span class="time">${time}</span>
      <span class="grow"><div class="title">${esc(e.title)}</div>
      ${e.location ? `<div class="muted small title">${esc(e.location)}</div>` : ""}</span>
    </li>`;
  }).join("");
}

/* ------------------------------------------------------------ タスク */

async function loadTasks() {
  tasks = await api("/api/tasks");
  renderTasks();
  renderCalendar();
}

function renderTasks() {
  const today = todayISO();
  // 未完了で期限が今日以前のもの + 今日完了したもの
  const shown = tasks
    .filter((t) => (!t.done && t.due <= today) || (t.done && t.done_on === today))
    .sort((a, b) => a.done - b.done || a.due.localeCompare(b.due));
  const upcoming = tasks.filter((t) => !t.done && t.due > today).length;

  let html = shown.map((t) => {
    const badge = !t.done && t.due < today ? `<span class="badge overdue">期限切れ ${t.due.slice(5)}</span>` : "";
    return `<li class="${t.done ? "done" : ""}" data-id="${t.id}">
      <input type="checkbox" ${t.done ? "checked" : ""}>
      <span class="grow title">${esc(t.title)}</span>${badge}
      <button class="icon-btn del" title="削除">✕</button>
    </li>`;
  }).join("");
  if (!shown.length) html = `<li class="empty">今日のタスクはありません</li>`;
  if (upcoming) html += `<li class="muted small">明日以降のタスク ${upcoming}件</li>`;
  $("tasks").innerHTML = html;
}

$("task-due").value = todayISO();
$("task-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  tasks = await api("/api/tasks", {
    method: "POST",
    body: { title: $("task-title").value, due: $("task-due").value },
  });
  $("task-title").value = "";
  renderTasks();
  renderCalendar();
});

$("tasks").addEventListener("click", async (e) => {
  const li = e.target.closest("li[data-id]");
  if (!li) return;
  const id = li.dataset.id;
  if (e.target.matches("input[type=checkbox]")) {
    tasks = await api(`/api/tasks/${id}`, { method: "PATCH", body: { done: e.target.checked } });
  } else if (e.target.matches(".del")) {
    tasks = await api(`/api/tasks/${id}`, { method: "DELETE" });
  } else return;
  renderTasks();
  renderCalendar();
});

/* ------------------------------------------------------------ Redmine */

async function loadRedmine(refresh = false) {
  const r = await api("/api/redmine" + (refresh ? "?refresh=1" : ""));
  if (r.disabled) {
    $("issues").innerHTML = `<li class="empty">Redmine 連携は無効です（config.json）</li>`;
    $("issues-meta").textContent = "";
    return;
  }
  if (!r.ok) {
    $("issues").innerHTML = "";
    $("issues-meta").innerHTML = `<span class="error">${esc(r.error)}</span>`;
    return;
  }
  const today = todayISO();
  const ms = 24 * 60 * 60 * 1000;
  $("issues").innerHTML = r.issues.length ? r.issues.map((i) => {
    const diff = Math.round((new Date(i.due_date) - new Date(today)) / ms);
    const [cls, label] = diff < 0 ? ["overdue", `${-diff}日超過`]
      : diff === 0 ? ["today", "今日まで"] : ["", `あと${diff}日`];
    const link = r.base_url
      ? `<a href="${esc(r.base_url)}/issues/${i.id}" target="_blank" rel="noopener">#${i.id} ${esc(i.subject)}</a>`
      : `#${i.id} ${esc(i.subject)}`;
    return `<li class="issue">
      <span class="badge ${cls}">${label}</span>
      <span class="grow"><div class="title">${link}</div>
        <div class="muted small title">${esc(i.project)} ・ ${esc(i.status)} ・ 優先度 ${esc(i.priority)} ・ 期日 ${i.due_date} ・ ${i.done_ratio}%</div>
      </span>
    </li>`;
  }).join("") : `<li class="empty">期限が近いチケットはありません</li>`;
  $("issues-meta").textContent = `${r.demo ? "デモデータ ・ " : ""}${r.fetched_at} 更新`;
}

/* ------------------------------------------------------------ ショートカット */

const SC_ICON = { folder: "📁", app: "🚀", url: "🌐" };
let shortcuts = [];
let editing = false;

async function loadShortcuts() {
  shortcuts = await api("/api/shortcuts");
  renderShortcuts();
}

function renderShortcuts() {
  const box = $("shortcuts");
  box.classList.toggle("editing", editing);
  box.innerHTML = shortcuts.map((s) => `
    <button class="sc" data-id="${s.id}" title="${esc(s.target)}" draggable="${editing}">
      <span class="sc-icon">${SC_ICON[s.type] || "📄"}</span>
      <span class="sc-name">${esc(s.name)}</span>
      <span class="sc-del" title="削除">✕</span>
    </button>`).join("") || `<div class="empty">✎ からショートカットを登録できます</div>`;
}

$("shortcuts").addEventListener("click", async (e) => {
  const el = e.target.closest(".sc");
  if (!el) return;
  const id = el.dataset.id;
  if (e.target.matches(".sc-del")) {
    shortcuts = await api(`/api/shortcuts/${id}`, { method: "DELETE" });
    renderShortcuts();
    return;
  }
  if (editing) return;
  try {
    const r = await api(`/api/shortcuts/${id}/open`, { method: "POST" });
    if (r.url) window.open(r.url, "_blank", "noopener");
  } catch (err) {
    toast(`起動できませんでした: ${err.message}`);
  }
});

// 編集モード中はドラッグで並べ替え
let dragId = null;
$("shortcuts").addEventListener("dragstart", (e) => {
  dragId = e.target.closest(".sc")?.dataset.id;
});
$("shortcuts").addEventListener("dragover", (e) => e.preventDefault());
$("shortcuts").addEventListener("drop", async (e) => {
  e.preventDefault();
  const over = e.target.closest(".sc")?.dataset.id;
  if (!dragId || !over || dragId === over) return;
  const ids = shortcuts.map((s) => s.id).filter((i) => i !== dragId);
  ids.splice(ids.indexOf(over), 0, dragId);
  shortcuts = await api("/api/shortcuts/order", { method: "PUT", body: { ids } });
  renderShortcuts();
});

$("sc-edit").addEventListener("click", () => {
  editing = !editing;
  $("sc-form").hidden = !editing;
  renderShortcuts();
});

$("sc-type").addEventListener("change", (e) => {
  $("sc-args").hidden = e.target.value !== "app";
  $("sc-target").placeholder = {
    folder: "フォルダのパス（例: C:\\Users\\me\\Documents、\\\\server\\share）",
    app: "アプリ / ファイルのパス（例: C:\\Windows\\notepad.exe）",
    url: "URL（例: https://redmine.example.com）",
  }[e.target.value];
});
$("sc-args").hidden = true;

$("sc-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    shortcuts = await api("/api/shortcuts", {
      method: "POST",
      body: {
        type: $("sc-type").value,
        name: $("sc-name").value,
        target: $("sc-target").value,
        args: $("sc-args").value,
      },
    });
    $("sc-name").value = $("sc-target").value = $("sc-args").value = "";
    renderShortcuts();
  } catch (err) {
    toast(err.message);
  }
});

/* ------------------------------------------------------------ 起動 */

document.querySelectorAll("[data-refresh]").forEach((b) => b.addEventListener("click", () => {
  ({ mail: loadMail, calendar: loadEvents, redmine: loadRedmine })[b.dataset.refresh](true);
}));

function safe(fn) {
  return (...a) => fn(...a).catch((e) => console.error(e));
}

function loadAll() {
  safe(loadAttendance)();
  safe(loadMail)();
  safe(loadEvents)();
  safe(loadTasks)();
  safe(loadRedmine)();
  safe(loadShortcuts)();
}

tickClock();
setInterval(tickClock, 1000);
loadAll();
setInterval(safe(loadAttendance), 60 * 1000);
setInterval(renderEvents, 60 * 1000);
// サーバー側でキャッシュしているため、ここでは頻繁に問い合わせても外部へのアクセスは増えない
setInterval(safe(loadMail), 60 * 1000);
setInterval(safe(loadEvents), 60 * 1000);
setInterval(safe(loadRedmine), 60 * 1000);
