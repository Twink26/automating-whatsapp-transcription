/**
 * sheets.js
 * Handles all interaction with the Google Sheet that serves as the
 * structured, human-readable log of voice note activity.
 *
 * Design decision: we use ONE worksheet ("Log") with one row per voice note.
 * This is simplest for non-technical ops staff to scan/filter/sort in
 * Google Sheets natively (vs. a relational structure across multiple tabs).
 *
 * SEQUENCING DESIGN NOTE: "Sequence No." reflects each voice note's
 * position among that student's notes on that date, ORDERED BY THE
 * MESSAGE'S OWN WHATSAPP TIMESTAMP - not by the order our process
 * happened to receive/handle it. This matters because Baileys can
 * redeliver a backlog out of order after a reconnect, and the brief
 * explicitly requires correct handling of notes that "arrive in mixed
 * order." We do this by keeping an in-memory, per-(student,date) sorted
 * list of {timestamp, msgId} already written, and computing the new
 * note's rank against that list (see nextSequenceNumber). Numbers
 * already written to the Sheet for earlier notes are NOT retroactively
 * renumbered if a late/out-of-order note turns out to belong earlier in
 * the day - that would mean rewriting historical rows, which is unsafe
 * for a sheet ops may already be viewing/filtering live. Production
 * fix: a periodic re-sequencing job, or accept timestamp as the
 * authoritative sort key in any downstream view instead of relying on
 * the sequence number alone.
 *
 * DEDUPE: WhatsApp/Baileys may redeliver recent message history on
 * reconnect. We dedupe by WhatsApp's own message ID (stable, unique
 * per message) using an in-memory Set rebuilt from the sheet's
 * "Message ID" column on startup. This is a prototype-grade dedupe -
 * it resets if the column is ever cleared, and does not protect against
 * concurrent multi-process workers (single Node process only).
 */

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

const SHEET_HEADERS = [
  'Date',
  'Student / Group Name',
  'Sequence No.',
  'Time',
  'Sender Role',     // "Student/Parent", "Edoofa Team", or "Unknown"
  'Sender Name',
  'Duration (sec)',
  'Transcript',
  'Summary',
  'Action Items',
  'Status',          // "Processed" | "Failed - see error" etc.
  'Error Detail',
  'Raw Audio Ref',   // local filename reference, for audit/debug
  'Message ID',       // WhatsApp message id - used for dedupe, not shown to ops as a primary field
  'Timestamp (epoch)', // raw message timestamp - authoritative sort key, used internally for sequencing
];

class SheetLogger {
  constructor({ jsonKeyPath, sheetId }) {
    this.jsonKeyPath = jsonKeyPath;
    this.sheetId = sheetId;
    this.doc = null;
    this.sheet = null;
    // Per (student, date) -> sorted array of { timestamp, seq } already
    // committed to the sheet, kept in ascending timestamp order. Used to
    // compute a new note's correct rank even if it arrives out of order.
    this.committed = new Map(); // key: `${student}|${date}` -> [{timestamp, seq}]
    // Set of WhatsApp message IDs already written, for redelivery dedupe.
    this.seenMessageIds = new Set();
  }

  async init() {
    const creds = JSON.parse(fs.readFileSync(this.jsonKeyPath, 'utf-8'));
    const jwt = new JWT({
      email: creds.client_email,
      key: creds.private_key,
      scopes: ['https://www.googleapis.com/auth/spreadsheets'],
    });

    this.doc = new GoogleSpreadsheet(this.sheetId, jwt);
    await this.doc.loadInfo();

    this.sheet = this.doc.sheetsByIndex[0];

    // On a brand-new/blank sheet there is no header row yet, and
    // loadHeaderRow() throws rather than returning an empty result.
    // We treat that specific failure as "no headers yet" (currentHeaders
    // = []) rather than trying to read .headerValues afterward, which
    // throws a second, harder-to-diagnose error if loadHeaderRow never
    // succeeded.
    let currentHeaders = [];
    try {
      await this.sheet.loadHeaderRow();
      currentHeaders = this.sheet.headerValues || [];
    } catch (err) {
      console.log('[sheets] No existing header row found (likely a blank sheet) - will create one.');
    }

    const headersMatch =
      currentHeaders.length === SHEET_HEADERS.length &&
      SHEET_HEADERS.every((h, i) => currentHeaders[i] === h);

    if (!headersMatch) {
      await this.sheet.setHeaderRow(SHEET_HEADERS);
    }

    await this._rebuildStateFromSheet();
    console.log(`[sheets] Connected to sheet "${this.doc.title}" -> tab "${this.sheet.title}"`);
    console.log(`[sheets] Rebuilt dedupe set: ${this.seenMessageIds.size} known message IDs.`);
  }

  async _rebuildStateFromSheet() {
    const rows = await this.sheet.getRows();
    for (const row of rows) {
      const student = row.get('Student / Group Name');
      const date = row.get('Date');
      const seq = parseInt(row.get('Sequence No.'), 10) || 0;
      const timestamp = parseInt(row.get('Timestamp (epoch)'), 10) || 0;
      const msgId = row.get('Message ID');

      if (msgId) this.seenMessageIds.add(msgId);

      if (!student || !date) continue;
      const key = `${student}|${date}`;
      const list = this.committed.get(key) || [];
      list.push({ timestamp, seq });
      this.committed.set(key, list);
    }
    // Keep each list sorted by timestamp ascending for rank computation.
    for (const list of this.committed.values()) {
      list.sort((a, b) => a.timestamp - b.timestamp);
    }
  }

  /**
   * Has this exact WhatsApp message already been written to the sheet?
   * Check this BEFORE doing any transcription/summarization work, not
   * just before the final append, so redelivered messages short-circuit
   * early and don't waste API calls.
   */
  hasSeenMessage(msgId) {
    return !!msgId && this.seenMessageIds.has(msgId);
  }

  /**
   * Computes this note's sequence number for (studentName, dateStr),
   * ranked by `timestamp` against notes already committed for that
   * student+date - NOT by arrival/processing order. Reserves the slot
   * immediately (synchronous) so concurrent notes in the same process
   * batch don't collide.
   *
   * Note: if this note's timestamp falls BEFORE notes already written
   * with a lower sequence number, this note still gets the NEXT
   * available number (we do not renumber/rewrite historical rows - see
   * file header). Its true position is always recoverable from the
   * "Timestamp (epoch)" column for any downstream reconciliation.
   */
  nextSequenceNumber(studentName, dateStr, timestamp) {
    const key = `${studentName}|${dateStr}`;
    const list = this.committed.get(key) || [];
    const nextSeq = list.length + 1;
    list.push({ timestamp, seq: nextSeq });
    list.sort((a, b) => a.timestamp - b.timestamp);
    this.committed.set(key, list);
    return nextSeq;
  }

  async appendRow(rowData) {
    if (!this.sheet) throw new Error('SheetLogger not initialized. Call init() first.');
    if (rowData.messageId) this.seenMessageIds.add(rowData.messageId);
    await this.sheet.addRow({
      'Date': rowData.date,
      'Student / Group Name': rowData.studentName,
      'Sequence No.': rowData.sequenceNo,
      'Time': rowData.time,
      'Sender Role': rowData.senderRole,
      'Sender Name': rowData.senderName,
      'Duration (sec)': rowData.durationSec,
      'Transcript': rowData.transcript,
      'Summary': rowData.summary,
      'Action Items': rowData.actionItems,
      'Status': rowData.status,
      'Error Detail': rowData.errorDetail || '',
      'Raw Audio Ref': rowData.audioRef || '',
      'Message ID': rowData.messageId || '',
      'Timestamp (epoch)': rowData.timestamp || '',
    });
  }
}

module.exports = { SheetLogger, SHEET_HEADERS };