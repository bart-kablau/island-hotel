// Pure booking logic: no Firebase, no DOM. Loaded by the app and by the node tests.
// Dates are 'yyyy-mm-dd' strings so they compare and sort as text.

export const STATUSES = ['Confirmed', 'Option', 'Request', 'Cancelled'];
export const ACTIVE = ['Confirmed', 'Option', 'Request'];
export const PAID = ['No', 'Deposit', 'Yes'];
export const SOURCES = ['Direct', 'BookingCom', 'TourOperator', 'Other'];
export const SOURCE_LABEL = { Direct: 'Direct', BookingCom: 'Booking.com', TourOperator: 'Tour operator', Other: 'Other' };
export const MAX_NIGHTS = 60;
export const MAX_ROOM_NIGHTS = 450; // a Firestore batch holds 500 writes

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

// ---------------------------------------------------------------- dates

function utc(s) { const [y, m, d] = s.split('-').map(Number); return Date.UTC(y, m - 1, d); }
export function isDate(s) { return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(utc(s)); }
export function addDays(s, n) { return new Date(utc(s) + n * 86400000).toISOString().slice(0, 10); }
export function nightsBetween(a, b) { return Math.round((utc(b) - utc(a)) / 86400000); }
export function stayDates(checkIn, checkOut) {
  const out = [];
  for (let d = checkIn; d < checkOut; d = addDays(d, 1)) out.push(d);
  return out;
}
export function todayIn(tz = 'Africa/Banjul', now = new Date()) {
  return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
}
export function fmtDate(s, withDay = false) {
  if (!isDate(s)) return '';
  const d = new Date(utc(s));
  const txt = d.getUTCDate() + ' ' + MONTHS[d.getUTCMonth()];
  return withDay ? DAYS[d.getUTCDay()] + ' ' + txt : txt;
}
export const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
/** ISO 8601 week number: weeks start on Monday, week 1 holds the first Thursday of the year. */
export function isoWeek(s) {
  const d = new Date(utc(s));
  const day = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week decides the year
  const jan1 = Date.UTC(d.getUTCFullYear(), 0, 1);
  return Math.ceil(((d - jan1) / 86400000 + 1) / 7);
}
export function mondayOf(s) { return addDays(s, -((new Date(utc(s)).getUTCDay() + 6) % 7)); }
export function isMonday(s) { return new Date(utc(s)).getUTCDay() === 1; }
export function fmtRange(a, b) {
  if (a.slice(0, 7) === b.slice(0, 7)) return new Date(utc(a)).getUTCDate() + ' – ' + fmtDate(b);
  return fmtDate(a) + ' – ' + fmtDate(b);
}
export function fmtGmd(n) { return 'GMD ' + Math.round(n || 0).toLocaleString('en-US'); }
export function fmtTime(ms) {
  const d = new Date(ms);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

// ---------------------------------------------------------------- rooms and ids

/** "FULADU 1" and "FULADU1" are one room: FULADU-1. "FULADU APARTMENT" becomes FULADU-APARTMENT. */
export function roomIdOf(name) {
  return String(name || '').trim().toUpperCase()
    .replace(/([A-Z])(\d)/g, '$1 $2').replace(/(\d)([A-Z])/g, '$1 $2')
    .split(/[^A-Z0-9]+/).filter(Boolean).join('-');
}

/** Names in the old room list that are a building, not a room (Fun, 04-11-2026). Skipped on import. */
export const GROUP_NAMES = new Set(['FULADU-APARTMENT', 'JOKADU-APARTMENT', 'BADIBU-APARTMENT', 'DELUXE-APARTMENT']);

/** Building of a room from its sheet name. Deluxe = the three VIP rooms (Fun, 04-11-2026). */
export function buildingOf(name) {
  const n = String(name || '').trim().toUpperCase();
  const b = n.match(/^(FULADU|JOKADU|BADIBU)/);
  if (b) return b[1][0] + b[1].slice(1).toLowerCase();
  return /^(JANEYA|KUNTAIR|JANJANBUREH)$/.test(n) ? 'Deluxe' : 'Other';
}

const ID_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I
/** Works offline: date of today plus three random characters, e.g. B261103-K7F. */
export function newBookingId(today, rand = Math.random) {
  let tail = '';
  for (let i = 0; i < 3; i++) tail += ID_CHARS[Math.floor(rand() * ID_CHARS.length)];
  return 'B' + today.slice(2).replace(/-/g, '') + '-' + tail;
}

// ---------------------------------------------------------------- booking helpers

export function lineList(b) {
  return Object.entries(b.lines || {}).map(([lineId, l]) => ({ lineId, ...l }))
    .sort((x, y) => (x.order ?? 0) - (y.order ?? 0) || x.lineId.localeCompare(y.lineId));
}
export function activeLines(b) { return lineList(b).filter(l => ACTIVE.includes(l.status)); }
export function nights(b) { return nightsBetween(b.checkIn, b.checkOut); }
export function lineTotal(b, l) { return (Number(l.rateGmd) || 0) * nights(b); }
export function bookingTotal(b) { return activeLines(b).reduce((s, l) => s + lineTotal(b, l), 0); }

/** Booking-level status for lists: the "lowest" active status, or Cancelled when nothing is active. */
export function bookingStatus(b) {
  const act = activeLines(b);
  if (!act.length) return 'Cancelled';
  for (const s of ['Request', 'Option', 'Confirmed']) if (act.some(l => l.status === s)) return s;
  return 'Confirmed';
}
export function bookingPaid(b) {
  const act = activeLines(b);
  if (!act.length) return 'No';
  if (act.every(l => l.paid === 'Yes')) return 'Yes';
  if (act.some(l => l.paid === 'Yes' || l.paid === 'Deposit')) return 'Deposit';
  return 'No';
}

/** One night lock per active room per night: nights/{roomId}_{date}. */
export function nightDocs(b) {
  const out = [];
  for (const l of activeLines(b)) {
    if (!l.roomId) continue; // a line without a room (old sheet) blocks nothing
    for (const date of stayDates(b.checkIn, b.checkOut)) {
      out.push({ id: l.roomId + '_' + date, roomId: l.roomId, date, bookingId: b.id, lineId: l.lineId });
    }
  }
  return out;
}

/** Which night locks to add and to remove when a booking goes from `before` (or null) to `after`. */
export function nightChanges(before, after) {
  const was = new Map((before ? nightDocs(before) : []).map(n => [n.id, n]));
  const will = new Map(nightDocs(after).map(n => [n.id, n]));
  const add = [...will.values()].filter(n => !was.has(n.id) || was.get(n.id).lineId !== n.lineId);
  const remove = [...was.values()].filter(n => !will.has(n.id) || will.get(n.id).lineId !== n.lineId);
  return { add, remove };
}

/** Conflicts against the known night locks (map id -> {bookingId}) for the nights this booking adds. */
export function conflicts(nightIndex, before, after) {
  return nightChanges(before, after).add
    .filter(n => nightIndex.has(n.id) && nightIndex.get(n.id).bookingId !== after.id)
    .map(n => ({ roomId: n.roomId, date: n.date, bookingId: nightIndex.get(n.id).bookingId }));
}

/** Rooms that are free for every night of the stay (ignoring this booking itself). */
export function freeRooms(rooms, nightIndex, checkIn, checkOut, bookingId) {
  if (!(isDate(checkIn) && isDate(checkOut) && checkOut > checkIn)) return new Set();
  const dates = stayDates(checkIn, checkOut);
  return new Set(rooms.filter(r => r.active !== false && dates.every(d => {
    const n = nightIndex.get(r.id + '_' + d);
    return !n || n.bookingId === bookingId;
  })).map(r => r.id));
}

export function validate(b) {
  const errors = [];
  if (!String(b.guestName || '').trim()) errors.push('Guest name is missing.');
  if (!isDate(b.checkIn) || !isDate(b.checkOut)) errors.push('Check-in and check-out are needed.');
  else if (b.checkOut <= b.checkIn) errors.push('Check-out must be after check-in.');
  else if (nights(b) > MAX_NIGHTS) errors.push('A booking can be at most ' + MAX_NIGHTS + ' nights.');
  const lines = lineList(b);
  if (!lines.length) errors.push('Choose at least one room.');
  const seen = new Set();
  for (const l of activeLines(b)) {
    if (seen.has(l.roomId)) errors.push(l.roomId + ' is in the booking twice.');
    seen.add(l.roomId);
  }
  if (!errors.length && nightDocs(b).length > MAX_ROOM_NIGHTS) {
    errors.push('Too big for one booking (' + nightDocs(b).length + ' room nights, max ' + MAX_ROOM_NIGHTS + '). Split it in two.');
  }
  return errors;
}

// ---------------------------------------------------------------- history

const STAY_FIELDS = ['guestName', 'phone', 'email', 'checkIn', 'checkOut', 'source', 'bookingComRef', 'bookingComAmountEur', 'notes'];
const LINE_FIELDS = ['roomId', 'guests', 'rateGmd', 'status', 'paid', 'invoiceNo', 'notes'];

/** {field: [old, new]} for the stay, and lines.<lineId>.<field> for the rooms. Added lines: lines.<id> = [null, line]. */
export function diff(before, after) {
  const ch = {};
  const same = (a, b) => (a ?? '') === (b ?? '');
  for (const f of STAY_FIELDS) if (!same(before[f], after[f])) ch[f] = [before[f] ?? '', after[f] ?? ''];
  const bl = before.lines || {}, al = after.lines || {};
  for (const id of new Set([...Object.keys(bl), ...Object.keys(al)])) {
    if (!bl[id]) { ch['lines.' + id] = [null, { roomId: al[id].roomId, status: al[id].status }]; continue; }
    if (!al[id]) continue; // lines are never removed, only cancelled
    for (const f of LINE_FIELDS) if (!same(bl[id][f], al[id][f])) ch['lines.' + id + '.' + f] = [bl[id][f] ?? '', al[id][f] ?? ''];
  }
  return ch;
}

const FIELD_LABEL = {
  guestName: 'Name', phone: 'Phone', email: 'Email', checkIn: 'Check-in', checkOut: 'Check-out', source: 'Source',
  bookingComRef: 'Booking.com nr', bookingComAmountEur: 'Amount EUR', notes: 'Notes',
  guests: 'Guests', rateGmd: 'Rate', status: 'Status', paid: 'Paid', invoiceNo: 'Invoice', roomId: 'Room'
};
function show(field, v) {
  if (v === '' || v == null) return '–';
  if (field === 'checkIn' || field === 'checkOut') return fmtDate(v);
  if (field === 'source') return SOURCE_LABEL[v] || v;
  if (field === 'rateGmd') return Number(v).toLocaleString('en-US');
  return String(v);
}

/** The lines of a history entry in plain English, for the timeline. roomName(id) gives the display name. */
export function sentences(entry, roomName = id => id) {
  if (entry.action === 'imported') return ['Imported from the sheet'];
  const ch = entry.changes || {};
  const out = [];
  if (entry.action === 'created') {
    const n = Object.keys(ch).filter(k => /^lines\.[^.]+$/.test(k)).length || entry.rooms || 0;
    out.push('Created: ' + n + ' room' + (n === 1 ? '' : 's') + (entry.source ? ', ' + (SOURCE_LABEL[entry.source] || entry.source) : ''));
    return out;
  }
  for (const [k, [a, b]] of Object.entries(ch)) {
    const m = k.match(/^lines\.([^.]+)(?:\.(.+))?$/);
    if (!m) { out.push(FIELD_LABEL[k] + ' ' + show(k, a) + ' → ' + show(k, b)); continue; }
    const [, lineId, f] = m;
    const room = roomName((b && b.roomId) || entry.lineRooms?.[lineId] || lineId);
    if (!f) { out.push('Added room ' + room); continue; }
    if (f === 'status' && b === 'Cancelled') { out.push('Cancelled room ' + room); continue; }
    if (f === 'status' && a === 'Cancelled') { out.push('Restored room ' + room); continue; }
    if (f === 'roomId') { out.push('Room ' + roomName(a) + ' → ' + roomName(b)); continue; }
    out.push(room + ': ' + FIELD_LABEL[f] + ' ' + show(f, a) + ' → ' + show(f, b));
  }
  return out.length ? out : ['No changes'];
}

/** One line for the Changes list: "Yama cancelled Bah family". */
export function headline(entry, who) {
  const verb = { created: 'booked', cancelled: 'cancelled', undo: 'restored', imported: 'imported', changed: 'changed' }[entry.action] || 'changed';
  const ch = entry.changes || {};
  const keys = Object.keys(ch);
  let v = verb;
  if (entry.action === 'changed' && keys.length && keys.every(k => /\.paid$|\.invoiceNo$/.test(k))) v = 'updated payment of';
  if (entry.action === 'changed' && keys.length && keys.every(k => /\.status$/.test(k)) && keys.every(k => ch[k][1] === 'Confirmed')) v = 'confirmed';
  return who + ' ' + v + ' ' + (entry.guestName || 'a booking');
}

/** What kind of change this is, for the history entry's action. */
export function actionOf(before, after) {
  if (!before) return 'created';
  const was = activeLines(before).length, now = activeLines(after).length;
  if (was > 0 && now === 0) return 'cancelled';
  if (was === 0 && now > 0) return 'undo';
  return 'changed';
}

// ---------------------------------------------------------------- import from the sheet

/**
 * Sheet rows -> bookings. A booking = rows with the same guest, check-in and check-out (as the old
 * app grouped them), or the same Group value when present. Keeps the old row ids as line ids.
 * row: {id, guest, phone, email, room, checkIn, checkOut, guests, status, rate, paid, invoice, bookingDate, notes, group, source}
 */
export function groupSheetRows(rows, today) {
  const groups = new Map();
  for (const r of rows) {
    if (!String(r.guest || '').trim() || !isDate(r.checkIn) || !isDate(r.checkOut) || r.checkOut <= r.checkIn) continue;
    if (GROUP_NAMES.has(roomIdOf(r.room))) continue;
    const key = r.group ? 'G|' + r.group : 'L|' + r.guest.trim().toLowerCase() + '|' + r.checkIn + '|' + r.checkOut;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const used = new Set();
  const out = [];
  for (const rs of groups.values()) {
    const f = rs[0];
    let id = 'B' + String(f.id || '').replace(/[^A-Za-z0-9-]/g, '');
    if (id === 'B' || used.has(id)) id = 'B-' + f.checkIn.replace(/-/g, '') + '-' + out.length;
    used.add(id);
    const notesAll = rs.map(r => String(r.notes || '').trim()).filter(Boolean);
    const isBc = String(f.source || '').toLowerCase().includes('booking') || notesAll.some(n => /booking/i.test(n));
    const eur = notesAll.map(n => n.match(/(\d+(?:[.,]\d+)?)\s*(?:euro|eur|€)/i)).find(Boolean);
    const lines = {};
    const active = new Set();
    rs.forEach((r, i) => {
      let lineId = String(r.id || '').trim() || id + '-' + (i + 1);
      while (lines[lineId]) lineId += 'x';
      const st = STATUSES.includes(String(r.status || '').trim()) ? String(r.status).trim() : 'Confirmed';
      const pd = PAID.includes(String(r.paid || '').trim()) ? String(r.paid).trim() : 'No';
      const roomId = roomIdOf(r.room);
      // The same room twice in one booking is a copied row in the old sheet: keep it, cancelled.
      const dup = st !== 'Cancelled' && roomId && active.has(roomId);
      if (st !== 'Cancelled') active.add(roomId);
      lines[lineId] = {
        roomId, guests: Number(r.guests) || 0, rateGmd: Number(r.rate) || 0, status: dup ? 'Cancelled' : st, paid: pd,
        invoiceNo: String(r.invoice || ''), notes: ((dup ? 'DOUBLE in old sheet, was ' + st + '. ' : '') + (roomId ? '' : 'No room in old sheet. ') + String(r.notes || '').trim()).trim(), order: i
      };
    });
    out.push({
      id, guestName: f.guest.trim(), phone: String(f.phone || ''), email: String(f.email || ''),
      checkIn: f.checkIn, checkOut: f.checkOut, source: isBc ? 'BookingCom' : 'Direct',
      bookingComRef: '', bookingComAmountEur: eur ? Number(eur[1].replace(',', '.')) : null,
      bookingDate: isDate(f.bookingDate) ? f.bookingDate : '', notes: '', lines
    });
  }
  return out;
}

// ---------------------------------------------------------------- sorting and reports

/** Booking number as people know it: R2025-006 for the old sheet, B261103-K7F for the app. */
export function bookingNo(b) { return /^BR\d{4}-/.test(b.id) ? b.id.slice(1) : b.id; }

/** Order of entry: old sheet numbers by year and number, then app bookings by date in their id. */
export function numberKey(b) {
  const old = String(b.id).match(/^BR(\d{4})-(\d+)/);
  if (old) return '1|' + old[1] + '|' + old[2].padStart(6, '0');
  return (/^B\d{6}-/.test(b.id) ? '2|' : '1|') + b.id;
}

/** by: 'checkin' | 'booked' | 'number'; dir: 'asc' | 'desc'. Bookings without a booking date come first. */
export function sortBookings(list, by = 'checkin', dir = 'asc') {
  const key = by === 'number' ? b => numberKey(b)
    : by === 'booked' ? b => (b.bookingDate || '0000') + '|' + numberKey(b)
    : b => b.checkIn + '|' + String(b.guestName || '').toLowerCase();
  const out = list.map(b => [key(b), b]).sort((x, y) => x[0] < y[0] ? -1 : x[0] > y[0] ? 1 : 0).map(x => x[1]);
  return dir === 'desc' ? out.reverse() : out;
}

/**
 * Guests of a booking. The old sheet often put the group total on every room line (14 rooms x 21 guests
 * = 21 people): the same number above 4 on all rooms counts once, otherwise the rooms add up.
 */
export function bookingGuests(lines) {
  const g = lines.map(l => Number(l.guests) || 0);
  if (g.length > 1 && g[0] > 4 && g.every(x => x === g[0])) return g[0];
  return g.reduce((s, x) => s + x, 0);
}

// Reports filter (ontwerp 04, overzichten v2): { year, rooms, source, withOptions }.
// rooms: '' = all, 'b:<building>' or 'r:<roomId>'. It works on room lines: only lines that pass count.

/** Active rooms inside the rooms filter: the base for occupancy and RevPAR. */
export function roomsInUse(rooms, f = {}) {
  return rooms.filter(r => r.active !== false && roomMatch(r.id, r.building, f.rooms));
}
function roomMatch(roomId, building, sel) {
  if (!sel) return true;
  if (sel.startsWith('b:')) return building === sel.slice(2);
  return roomId === sel.slice(2);
}
/** (booking, line) => true when the line counts. statuses: which line statuses count. */
export function lineFilter(rooms, f = {}, statuses = f.withOptions ? ACTIVE : ['Confirmed']) {
  const bld = new Map(rooms.map(r => [r.id, r.building]));
  return (b, l) => !!l.roomId && statuses.includes(l.status) && (!f.source || b.source === f.source) &&
    roomMatch(l.roomId, bld.get(l.roomId), f.rooms);
}

/**
 * Figures per month of one year. Bookings, rooms, guests and the Booking.com amount count in the month of
 * check-in; nights, occupancy and revenue per night, so a stay over the month end is split fairly.
 * ADR = revenue / nights with a rate; RevPAR = revenue / (rooms in use x days); zeroNights = nights without a rate.
 */
export function monthReport(bookings, rooms, f = {}) {
  const y = String(f.year);
  const ok = lineFilter(rooms, f);
  const roomCount = roomsInUse(rooms, f).length;
  const blank = (month, days) => ({ month, days, bookings: 0, rooms: 0, guests: 0, nights: 0, revenue: 0, eur: 0, ratedNights: 0, zeroNights: 0 });
  const rows = MONTH_NAMES.map((name, m) => blank(name, new Date(Date.UTC(+y, m + 1, 0)).getUTCDate()));
  const zeroIds = new Set();
  for (const b of bookings) {
    const lines = lineList(b).filter(l => ok(b, l));
    if (!lines.length || !isDate(b.checkIn) || !isDate(b.checkOut)) continue;
    if (b.checkIn.slice(0, 4) === y) {
      const r = rows[+b.checkIn.slice(5, 7) - 1];
      r.bookings++; r.rooms += lines.length;
      r.guests += bookingGuests(lines);
      r.eur += Number(b.bookingComAmountEur) || 0;
    }
    const perNight = lines.reduce((s, l) => s + (Number(l.rateGmd) || 0), 0);
    const zero = lines.filter(l => !(Number(l.rateGmd) > 0)).length;
    for (const d of stayDates(b.checkIn, b.checkOut)) {
      if (d.slice(0, 4) !== y) continue;
      const r = rows[+d.slice(5, 7) - 1];
      r.nights += lines.length; r.revenue += perNight;
      r.ratedNights += lines.length - zero; r.zeroNights += zero;
      if (zero) zeroIds.add(b.id);
    }
  }
  const total = blank('Total', rows.reduce((s, r) => s + r.days, 0));
  const finish = r => {
    r.occupancy = roomCount ? r.nights / (roomCount * r.days) : 0;
    r.adr = r.ratedNights ? r.revenue / r.ratedNights : 0;
    r.revpar = roomCount ? r.revenue / (roomCount * r.days) : 0;
  };
  for (const r of rows) {
    finish(r);
    for (const k of ['bookings', 'rooms', 'guests', 'nights', 'revenue', 'eur', 'ratedNights', 'zeroNights']) total[k] += r[k];
  }
  finish(total);
  return { rows, total, roomCount, zeroIds: [...zeroIds] };
}

/** Bookings with at least one counted night in month m (0-11) of f.year, by check-in. */
export function monthBookings(bookings, rooms, f, m) {
  const ok = lineFilter(rooms, f);
  const from = f.year + '-' + String(m + 1).padStart(2, '0') + '-01', to = addDays(from, 31).slice(0, 8) + '01';
  return bookings.filter(b => isDate(b.checkIn) && isDate(b.checkOut) && b.checkIn < to && b.checkOut > from &&
    lineList(b).some(l => ok(b, l))).sort((a, b) => a.checkIn.localeCompare(b.checkIn));
}

/**
 * Not paid yet while the stay is over: confirmed lines, check-out before today, paid not Yes.
 * Year and status are ignored; rooms and source count. Oldest first.
 */
export function outstanding(bookings, rooms, f, today) {
  const ok = lineFilter(rooms, { ...f, withOptions: false });
  const items = [];
  for (const b of bookings) {
    if (!isDate(b.checkOut) || b.checkOut >= today) continue;
    const lines = lineList(b).filter(l => ok(b, l) && l.paid !== 'Yes');
    if (!lines.length) continue;
    items.push({ b, rooms: lines.length, amount: lines.reduce((s, l) => s + lineTotal(b, l), 0), deposit: lines.some(l => l.paid === 'Deposit') });
  }
  items.sort((x, y) => x.b.checkOut.localeCompare(y.b.checkOut) || x.b.guestName.localeCompare(y.b.guestName));
  return { items, rooms: items.reduce((s, i) => s + i.rooms, 0), amount: items.reduce((s, i) => s + i.amount, 0) };
}

/** The next `days` nights from today: confirmed and option/request nights, as share of rooms in use x days. */
export function forward(bookings, rooms, f, today, days) {
  const ok = lineFilter(rooms, f, ACTIVE);
  const end = addDays(today, days);
  let confirmed = 0, other = 0;
  for (const b of bookings) {
    if (!isDate(b.checkIn) || !isDate(b.checkOut) || b.checkOut <= today || b.checkIn >= end) continue;
    const lines = lineList(b).filter(l => ok(b, l));
    if (!lines.length) continue;
    const n = stayDates(b.checkIn < today ? today : b.checkIn, b.checkOut < end ? b.checkOut : end).length;
    for (const l of lines) l.status === 'Confirmed' ? confirmed += n : other += n;
  }
  const cap = roomsInUse(rooms, f).length * days;
  return { days, confirmed, other, confPct: cap ? confirmed / cap : 0, otherPct: cap ? other / cap : 0 };
}
