/**
 * sheets.js
 * Handles all interaction with the Google Sheet that serves as the
 * structured, human-readable log of voice note activity.
 *
 * Design decision: we use ONE worksheet ("Log") with one row per voice note.
 * This is simplest for non-technical ops staff to scan/filter/sort in
 * Google Sheets natively (vs. a relational structure across multiple tabs).
 */

const { GoogleSpreadsheet } = require('google-spreadsheet');
const { JWT } = require('google-auth-library');
const fs = require('fs');

const SHEET_HEADERS = [
  'Date',
  'Student / Group Name',
  'Sequence No.',
  'Time',
  'Sender Role',     // "Student/Parent" or "Edoofa Team"
  'Sender Name',
  'Duration (sec)',
  'Transcript',
  'Summary',
  'Action Items',
  'Status',          // "Processed" | "Failed - see error" etc.
  'Error Detail',
  'Raw Audio Ref',   // local filename reference, for audit/debug
];

class SheetLogger {
  constructor({ jsonKeyPath, sheetId }) {
    this.jsonKeyPath = jsonKeyPath;
    this.sheetId = sheetId;
    this.doc = null;
    this.sheet = null;
    // In-memory counter for sequential numbering per (student, date).
    // Rebuilt from the sheet on startup so restarts don't reset numbering.
    this.counters = new Map(); // key: `${student}|${date}` -> count
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
    await this.sheet.loadHeaderRow().catch(() => null);

    const currentHeaders = this.sheet.headerValues || [];
    const headersMatch =
      currentHeaders.length === SHEET_HEADERS.length &&
      SHEET_HEADERS.every((h, i) => currentHeaders[i] === h);

    if (!headersMatch) {
      await this.sheet.setHeaderRow(SHEET_HEADERS);
    }

    await this._rebuildCountersFromSheet();
    console.log(`[sheets] Connected to sheet "${this.doc.title}" -> tab "${this.sheet.title}"`);
  }

  async _rebuildCountersFromSheet() {
    const rows = await this.sheet.getRows();
    for (const row of rows) {
      const student = row.get('Student / Group Name');
      const date = row.get('Date');
      const seq = parseInt(row.get('Sequence No.'), 10) || 0;
      if (!student || !date) continue;
      const key = `${student}|${date}`;
      const current = this.counters.get(key) || 0;
      if (seq > current) this.counters.set(key, seq);
    }
  }

  /**
   * Returns the next sequence number for this student on this date,
   * and reserves it (increments the in-memory counter immediately so
   * concurrent voice notes arriving in the same batch don't collide).
   */
  nextSequenceNumber(studentName, dateStr) {
    const key = `${studentName}|${dateStr}`;
    const next = (this.counters.get(key) || 0) + 1;
    this.counters.set(key, next);
    return next;
  }

  async appendRow(rowData) {
    if (!this.sheet) throw new Error('SheetLogger not initialized. Call init() first.');
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
    });
  }
}

module.exports = { SheetLogger, SHEET_HEADERS };
