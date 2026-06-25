/**
 * index.js
 * Entry point. Connects to WhatsApp via Baileys (linked device / multi-device
 * web protocol), listens for incoming voice notes in groups, and pipes each
 * one through: download -> transcribe -> classify sender -> summarize ->
 * append structured row to Google Sheet.
 *
 * IMPORTANT CONTEXT (see one-pager for full reasoning):
 * WhatsApp does not offer a public API for reading group messages. Baileys
 * implements the same WhatsApp Web multi-device protocol that the official
 * WhatsApp Web client uses - it logs in as a real linked device (scan QR
 * once), then receives real-time events for any group that account is a
 * member of. This is the same approach used by most WhatsApp-group
 * automation tools used in production, but it sits outside WhatsApp's
 * official Business API and therefore outside their official ToS for
 * automated group reading. This trade-off is explicit and documented,
 * with a ToS-safe fallback alternative described in the one-pager.
 */

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const {
  default: makeWASocket,
  useMultiFileAuthState,
  downloadMediaMessage,
  DisconnectReason,
} = require('@whiskeysockets/baileys');
const qrcode = require('qrcode-terminal');
const pino = require('pino');

const { Transcriber } = require('./transcribe');
const { Summarizer } = require('./summarize');
const { SheetLogger } = require('./sheets');
const { RoleClassifier } = require('./roleClassifier');

const AUDIO_DIR = path.join(__dirname, '..', 'audio_store');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

const ALLOWED_GROUPS = (process.env.ALLOWED_GROUP_JIDS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

// TODO (ops): populate with real Edoofa team phone numbers (digits only,
// country code included, e.g. "919876543210"). Anyone not in this list
// who sends a voice note is logged as Student/Parent.
const EDOOFA_TEAM_NUMBERS = (process.env.EDOOFA_TEAM_NUMBERS || '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

async function main() {
  console.log('--- Edoofa Voice Note Pipeline starting ---');

  const transcriber = new Transcriber(process.env.OPENAI_API_KEY);
  const summarizer = new Summarizer(process.env.ANTHROPIC_API_KEY);
  const roleClassifier = new RoleClassifier(EDOOFA_TEAM_NUMBERS);
  const sheetLogger = new SheetLogger({
    jsonKeyPath: process.env.GOOGLE_SERVICE_ACCOUNT_JSON_PATH,
    sheetId: process.env.GOOGLE_SHEET_ID,
  });

  await sheetLogger.init();

  const { state, saveCreds } = await useMultiFileAuthState(
    path.join(__dirname, '..', 'auth_session')
  );

  const sock = makeWASocket({
    auth: state,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: false,
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      console.log('\n=== SCAN THIS QR CODE WITH WHATSAPP (Linked Devices) ===\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      console.log(`[connection] closed. statusCode=${statusCode}. Reconnecting: ${shouldReconnect}`);
      if (shouldReconnect) {
        main().catch((e) => console.error('[fatal] reconnect failed:', e));
      } else {
        console.log('[connection] Logged out. Delete ./auth_session and re-scan QR to relink.');
      }
    } else if (connection === 'open') {
      console.log('[connection] WhatsApp connected successfully. Listening for voice notes...');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages }) => {
    for (const msg of messages) {
      try {
        await handleIncomingMessage(msg, sock, {
          transcriber,
          summarizer,
          roleClassifier,
          sheetLogger,
        });
      } catch (err) {
        // Critical: one bad message must NEVER crash the whole listener.
        console.error('[error] Failed to process message:', err.message);
        await logFailureRow(sheetLogger, msg, err).catch(() => {});
      }
    }
  });
}

async function handleIncomingMessage(msg, sock, deps) {
  const { transcriber, summarizer, roleClassifier, sheetLogger } = deps;

  if (!msg.message) return;
  const remoteJid = msg.key.remoteJid || '';
  const isGroup = remoteJid.endsWith('@g.us');
  if (!isGroup) return; // We only care about group messages per the brief

  if (ALLOWED_GROUPS.length && !ALLOWED_GROUPS.includes(remoteJid)) return;

  const audioMsg = msg.message.audioMessage;
  if (!audioMsg || !audioMsg.ptt) return; // ptt = "push to talk" = voice note (not a regular audio file)

  // Dedupe FIRST, before any expensive work (group metadata fetch,
  // download, transcription, summarization). WhatsApp/Baileys can
  // redeliver recent history on reconnect - we never want to
  // re-transcribe or double-log the same message.
  const messageId = msg.key.id;
  if (sheetLogger.hasSeenMessage(messageId)) {
    console.log(`[skip] Message ${messageId} already processed (redelivery). Ignoring.`);
    return;
  }

  console.log(`[voice-note] Detected voice note in group ${remoteJid}`);

  // 1. Resolve student name from the group's subject (metadata).
  //    ASSUMPTION (stated explicitly in one-pager): each WhatsApp group
  //    corresponds 1:1 to a single student, per the brief's description
  //    of "individual student WhatsApp groups". The group name therefore
  //    IS the student identifier - no separate name-matching needed.
  //    PROTOTYPE SHORTCUT: this is fragile if a group is ever renamed or
  //    two groups share a similar name. Production should use a
  //    dedicated "Student Roster" sheet tab keyed by group JID instead
  //    of trusting the human-editable group subject. See one-pager.
  const groupMeta = await sock.groupMetadata(remoteJid);
  const studentName = groupMeta.subject || remoteJid;

  // 2. Determine sender role + name from message metadata (deterministic).
  //    `fromMe` is checked first inside the classifier: it's true when
  //    the LINKED account itself (the phone that scanned the QR - almost
  //    certainly an Edoofa team member) sent this voice note. In that
  //    case `key.participant` can be missing/unreliable, so we must not
  //    rely on JID alone.
  const fromMe = !!msg.key.fromMe;
  const senderJid = msg.key.participant || (fromMe ? undefined : msg.key.remoteJid);
  const senderRole = roleClassifier.classify(senderJid, fromMe);
  let senderName = msg.pushName || (senderJid ? senderJid.split('@')[0] : 'Unknown');

  // 3. Download the audio.
  const buffer = await downloadMediaMessage(msg, 'buffer', {});
  const timestamp = Number(msg.messageTimestamp) * 1000;
  const dateObj = new Date(timestamp);
  const dateStr = dateObj.toISOString().split('T')[0]; // YYYY-MM-DD
  const timeStr = dateObj.toTimeString().split(' ')[0]; // HH:MM:SS

  const safeStudent = studentName.replace(/[^a-z0-9]/gi, '_').slice(0, 40);
  const audioFileName = `${safeStudent}_${dateStr}_${Date.now()}.ogg`;
  const audioFilePath = path.join(AUDIO_DIR, audioFileName);
  fs.writeFileSync(audioFilePath, buffer);

  // 4. Sequential numbering per student per day, ranked by the
  //    message's OWN WhatsApp timestamp - not by the order our process
  //    happened to handle it in. This keeps numbering correct even if
  //    notes arrive out of order (e.g. after a reconnect redelivers a
  //    backlog). Reserved synchronously to avoid race conditions if
  //    several notes for the same student land in one batch.
  //    NOTE: a note that fails downstream (transcription/summarization)
  //    still keeps its reserved number - see sheets.js header comment
  //    for why we treat that as correct behavior, not a bug: the note
  //    really did arrive at that point in the sequence, failure is
  //    logged via Status/Error Detail on the same row, not by hiding
  //    the gap.
  const sequenceNo = sheetLogger.nextSequenceNumber(studentName, dateStr, timestamp);

  let transcript = '';
  let summary = '';
  let actionItems = '';
  let status = 'Processed';
  let errorDetail = '';

  try {
    // 5. Transcribe.
    transcript = await transcriber.transcribe(audioFilePath);

    // 6. Summarize + extract action items.
    const result = await summarizer.summarize(transcript, {
      studentName,
      senderRole,
      senderName,
    });
    summary = result.summary;
    actionItems = result.actionItems;
  } catch (err) {
    status = 'Failed - see error';
    errorDetail = err.message;
    console.error(`[error] Pipeline failure for ${studentName} seq ${sequenceNo}:`, err.message);
    // NOTE: we still write a row below even on failure. This is a
    // deliberate reliability decision - ops should see "a voice note
    // arrived and failed" rather than it silently vanishing. The raw
    // audio file remains on disk (audioFilePath) for manual reprocessing.
  }

  // 7. Write the row regardless of success/failure (see note above).
  await sheetLogger.appendRow({
    date: dateStr,
    studentName,
    sequenceNo,
    time: timeStr,
    senderRole,
    senderName,
    durationSec: audioMsg.seconds || '',
    transcript,
    summary,
    actionItems,
    status,
    errorDetail,
    audioRef: audioFileName,
    messageId,
    timestamp,
  });

  console.log(`[done] ${studentName} #${sequenceNo} -> ${status}`);
}

async function logFailureRow(sheetLogger, msg, err) {
  // Best-effort logging for failures that happen BEFORE we even get to
  // the structured handler above (e.g. group metadata fetch failure).
  try {
    await sheetLogger.appendRow({
      date: new Date().toISOString().split('T')[0],
      studentName: msg.key?.remoteJid || 'UNKNOWN',
      sequenceNo: 0,
      time: new Date().toTimeString().split(' ')[0],
      senderRole: 'Unknown',
      senderName: 'UNKNOWN',
      durationSec: '',
      transcript: '',
      summary: '',
      actionItems: '',
      status: 'Failed - see error',
      errorDetail: err.message,
      audioRef: '',
      messageId: msg.key?.id || '',
      timestamp: msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : '',
    });
  } catch (e) {
    console.error('[error] Could not even log the failure row:', e.message);
  }
}

main().catch((err) => {
  console.error('[fatal]', err);
  process.exit(1);
});