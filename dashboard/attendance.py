"""出退勤の記録と残業時間の計算。

残業時間 = (退勤 − 出勤 − 休憩) − 所定労働時間（0 未満は 0）
所定労働時間 = (定時終業 − 定時始業 − 休憩)
退勤が未記録の当日は現在時刻で計算する。
"""

from datetime import date, datetime, timedelta


def _parse_hm(s):
    h, m = s.split(":")
    return int(h) * 60 + int(m)


def _fmt_hm(minutes):
    return f"{minutes // 60:02d}:{minutes % 60:02d}"


class Attendance:
    def __init__(self, store, work_cfg):
        self.store = store
        self.start = _parse_hm(work_cfg.get("start", "09:00"))
        self.end = _parse_hm(work_cfg.get("end", "18:00"))
        self.break_min = int(work_cfg.get("break_minutes", 60))
        self.auto_clock_in = bool(work_cfg.get("auto_clock_in", True))

    @property
    def standard_minutes(self):
        return max(0, self.end - self.start - self.break_min)

    def _day_minutes(self, rec, now_min=None):
        """勤務時間（分）と残業時間（分）を返す。出勤未記録なら (0, 0)。"""
        if not rec or not rec.get("in"):
            return 0, 0
        t_in = _parse_hm(rec["in"])
        if rec.get("out"):
            t_out = _parse_hm(rec["out"])
            if t_out < t_in:  # 日付をまたいだ退勤
                t_out += 24 * 60
        elif now_min is not None:
            t_out = now_min
        else:
            return 0, 0
        span = max(0, t_out - t_in)
        # 休憩は所定の休憩時間を上限に、拘束時間から差し引く
        worked = max(0, span - min(self.break_min, span))
        overtime = max(0, worked - self.standard_minutes)
        return worked, overtime

    def ensure_today(self, now=None):
        now = now or datetime.now()
        key = now.date().isoformat()
        data = self.store.load()
        if self.auto_clock_in and key not in data:
            data[key] = {"in": now.strftime("%H:%M"), "out": None}
            self.store.save(data)
        return data

    def set_times(self, day, t_in=None, t_out=None, clear_out=False):
        data = self.store.load()
        rec = data.get(day, {"in": None, "out": None})
        if t_in is not None:
            if t_in:
                _parse_hm(t_in)  # 形式チェック（不正なら ValueError）
            rec["in"] = t_in or None
        if t_out is not None:
            if t_out:
                _parse_hm(t_out)
            rec["out"] = t_out or None
        if clear_out:
            rec["out"] = None
        data[day] = rec
        self.store.save(data)

    def summary(self, now=None):
        now = now or datetime.now()
        data = self.ensure_today(now)
        today = now.date()
        key = today.isoformat()
        now_min = now.hour * 60 + now.minute
        rec = data.get(key)
        worked, overtime = self._day_minutes(rec, now_min)

        month_ot = 0
        month_days = 0
        for k, r in data.items():
            try:
                d = date.fromisoformat(k)
            except ValueError:
                continue
            if d.year == today.year and d.month == today.month:
                _, ot = self._day_minutes(r, now_min if d == today else None)
                month_ot += ot
                if r.get("in"):
                    month_days += 1

        # 定時退社予定時刻（出勤時刻 + 所定労働 + 休憩）
        planned_out = None
        if rec and rec.get("in"):
            planned_out = _fmt_hm(
                (_parse_hm(rec["in"]) + self.standard_minutes + self.break_min) % (24 * 60)
            )

        history = []
        for i in range(6, -1, -1):
            d = today - timedelta(days=i)
            r = data.get(d.isoformat())
            w, ot = self._day_minutes(r, now_min if d == today else None)
            history.append({"date": d.isoformat(), "worked": w, "overtime": ot})

        return {
            "date": key,
            "clock_in": rec.get("in") if rec else None,
            "clock_out": rec.get("out") if rec else None,
            "planned_out": planned_out,
            "standard_minutes": self.standard_minutes,
            "break_minutes": self.break_min,
            "worked_minutes": worked,
            "overtime_minutes": overtime,
            "month_overtime_minutes": month_ot,
            "month_work_days": month_days,
            "history": history,
        }
