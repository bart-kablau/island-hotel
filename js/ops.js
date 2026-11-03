// Writing a booking: the booking, a history entry and the night locks in one batch, so it
// lands completely or not at all. The Firestore functions are passed in, so the node tests
// run exactly this code against the emulator.
import { nightChanges, diff, actionOf, lineList } from './logic.js';

const STORED = ['guestName', 'phone', 'email', 'checkIn', 'checkOut', 'source', 'bookingComRef',
  'bookingComAmountEur', 'bookingDate', 'notes', 'lines'];

function searchText(b) {
  return [b.guestName, b.phone, b.email, b.id, b.bookingComRef, ...Object.keys(b.lines || {})]
    .filter(Boolean).join(' ').toLowerCase();
}

/**
 * before: the booking as loaded (null for a new one), after: the edited booking (with id).
 * Returns the batch commit promise; it settles when the server accepted or refused it,
 * which can be much later when the phone is offline.
 */
export function saveBooking(fs, db, { before, after, me, action }) {
  const { doc, collection, writeBatch, serverTimestamp } = fs;
  const batch = writeBatch(db);
  const ref = doc(db, 'bookings', after.id);
  const data = {};
  for (const k of STORED) data[k] = after[k] ?? (k === 'bookingComAmountEur' ? null : k === 'lines' ? {} : '');
  data.roomIds = [...new Set(lineList(after).map(l => l.roomId))];
  data.search = searchText(after);
  data.version = (before?.version || 0) + 1;
  data.updatedBy = me;
  data.updatedAt = serverTimestamp();
  data.createdBy = before ? before.createdBy : me;
  data.createdAt = before ? before.createdAt : serverTimestamp();
  batch.set(ref, data);

  const lineRooms = {};
  for (const l of lineList(after)) lineRooms[l.lineId] = l.roomId;
  batch.set(doc(collection(db, 'bookings', after.id, 'history')), {
    bookingId: after.id, guestName: after.guestName, by: me, at: Date.now(), savedAt: serverTimestamp(),
    action: action || actionOf(before, after), changes: before ? diff(before, after) : {},
    rooms: lineList(after).length, source: after.source, lineRooms
  });

  const { add, remove } = nightChanges(before, after);
  for (const n of remove) batch.delete(doc(db, 'nights', n.id));
  for (const n of add) batch.set(doc(db, 'nights', n.id), { roomId: n.roomId, date: n.date, bookingId: n.bookingId, lineId: n.lineId, by: me });
  return batch.commit();
}

/** A refused save, in words for the person at the desk. */
export function explainError(err, before) {
  const msg = String(err && (err.code || err.message) || err);
  if (msg.includes('permission-denied') || msg.includes('PERMISSION_DENIED')) {
    return before
      ? 'Not saved: a room is taken on one of these nights, or someone else changed this booking just now.'
      : 'Not saved: a room is taken on one of these nights.';
  }
  if (msg.includes('unavailable')) return 'No connection to the server. It will be sent when there is internet.';
  return 'Not saved: ' + msg;
}
