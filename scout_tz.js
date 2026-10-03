// scout_tz.js — DC499 local time (America/Los_Angeles) for every agent.
//
// DST-aware: works out the right offset for whatever moment it's given, so nothing
// flips by hand. PDT (UTC-7) until 2:00 AM Sun Nov 1, 2026, then PST (UTC-8), back to
// PDT on Sun Mar 14, 2027, and so on every year. Today's output is unchanged.
//
// In SQL, use SQL_TZ:  CONVERT_TZ(col, '+00:00', ${SQL_TZ})  — MAWM's MySQL has the
// named zone loaded (checked 10/2: switches at exactly 2026-11-01 09:00 UTC), so each
// row converts with its own offset, even rows from before a switch.

const TZ = 'America/Los_Angeles';
const SQL_TZ = `'${TZ}'`;

const _fmt = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ, hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit',
  hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
});
const DOW = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

// Wall-clock parts of a moment in DC499 local time
function pacificParts(date = new Date()) {
  const p = {};
  for (const { type, value } of _fmt.formatToParts(new Date(date))) p[type] = value;
  return {
    year: +p.year, month: +p.month, day: +p.day,
    hour: +p.hour, minute: +p.minute, second: +p.second, dow: DOW[p.weekday],
  };
}

// Minutes to add to UTC to get local time: -420 in PDT, -480 in PST
function pacificOffsetMin(date = new Date()) {
  const d = new Date(date);
  const p = pacificParts(d);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(d.getTime() / 1000) * 1000) / 60000);
}
// '-07:00' / '-08:00' — for parsing local timestamp strings: new Date(str + pacificOffsetStr(...))
function pacificOffsetStr(date = new Date()) {
  const m = pacificOffsetMin(date), a = Math.abs(m);
  return (m < 0 ? '-' : '+') + String(Math.floor(a / 60)).padStart(2, '0') + ':' + String(a % 60).padStart(2, '0');
}
// Same moment shifted so its UTC fields read as local wall time (replaces `- 7 * 3600000`)
function pacificShifted(date = new Date()) {
  const d = new Date(date);
  return new Date(d.getTime() + pacificOffsetMin(d) * 60000);
}

const pad = n => String(n).padStart(2, '0');
// 'YYYY-MM-DD' of the local date
function pacificDateStr(date = new Date()) {
  const p = pacificParts(date);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}
// Local hour 0–23
function pacificHour(date = new Date()) { return pacificParts(date).hour; }

// UTC moment for a local wall time on a local date ('YYYY-MM-DD', hour, minute)
function utcFromPacific(ymd, hour = 0, minute = 0) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  const wall = Date.UTC(y, m - 1, d, hour, minute);
  let t = wall - pacificOffsetMin(new Date(wall)) * 60000;    // first guess
  t = wall - pacificOffsetMin(new Date(t)) * 60000;           // settle across a switch
  return new Date(t);
}
// 'YYYY-MM-DD HH:MM:SS' (UTC) — the SQL-ready form used in WHERE clauses
function sqlUtc(date) { return new Date(date).toISOString().slice(0, 19).replace('T', ' '); }
// Local midnight of a local date, as a SQL UTC string (was `${ymd} 07:00:00`)
function pacificMidnightSql(ymd) { return sqlUtc(utcFromPacific(ymd, 0, 0)); }
// Add whole days to a 'YYYY-MM-DD'
function addDays(ymd, n) {
  const [y, m, d] = String(ymd).slice(0, 10).split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
}

// Which shift is on now and when it started, from local wall-clock rules:
//   firstFrom / secondFrom — local hour each shift's window begins (detection)
//   firstStart / secondStart — [hour, minute] local start used for queries
// Before firstFrom (after midnight) it's still the 2nd shift that began the day before.
//   (firstFrom / secondFrom may be an hour or [hour, minute])
function currentShift({ firstFrom, secondFrom, firstStart, secondStart }, now = new Date()) {
  const p = pacificParts(now);
  const today = pacificDateStr(now);
  const mins = v => Array.isArray(v) ? v[0] * 60 + v[1] : v * 60;
  const cur = p.hour * 60 + p.minute;
  const is1st = cur >= mins(firstFrom) && cur < mins(secondFrom);
  const day = (!is1st && cur < mins(firstFrom)) ? addDays(today, -1) : today;
  const [h, m] = is1st ? firstStart : secondStart;
  const start = utcFromPacific(day, h, m);
  return { is1st, label: is1st ? '1st' : '2nd', start, startSql: sqlUtc(start), day };
}

// Local wall-time string from MAWM/CONVERT_TZ ('YYYY-MM-DD HH:MM[:SS]' or with 'T') → Date
function parsePacific(str) {
  const m = String(str || '').match(/^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return new Date(NaN);
  return new Date(utcFromPacific(m[1], +m[2], +m[3]).getTime() + (+m[4] || 0) * 1000);
}
// Minutes since local midnight
function pacificMinOfDay(date = new Date()) { const p = pacificParts(date); return p.hour * 60 + p.minute; }

module.exports = {
  TZ, SQL_TZ, pacificParts, pacificOffsetMin, pacificOffsetStr, pacificShifted,
  pacificDateStr, pacificHour, utcFromPacific, sqlUtc, pacificMidnightSql, addDays, currentShift, parsePacific, pacificMinOfDay,
};
