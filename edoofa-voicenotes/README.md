# Edoofa Voice Note Pipeline — Prototype

Captures voice notes from WhatsApp groups, transcribes them, summarizes them
with action items, and logs everything as structured rows in a Google Sheet.

## How it works (one-line version)

WhatsApp account linked via Baileys (same protocol as WhatsApp Web) listens
to all groups it's a member of -> on voice note -> download audio ->
Whisper transcribes -> Claude classifies/summarizes -> row appended to
Google Sheet.

## One-time setup

### 1. Install dependencies
```
npm install
```

### 2. Create your .env file
```
cp .env.example .env
```
Then fill in:
- `OPENAI_API_KEY` — from https://platform.openai.com/api-keys
- `ANTHROPIC_API_KEY` — from https://console.anthropic.com/
- `GOOGLE_SHEET_ID` — the long ID in your Google Sheet's URL:
  `https://docs.google.com/spreadsheets/d/`**`THIS_PART`**`/edit`
- `GOOGLE_SERVICE_ACCOUNT_JSON_PATH` — leave as `./service-account.json`
  (see step 3)

### 3. Add your Google service account key
Place the downloaded JSON key file at the project root, named exactly:
```
service-account.json
```
Make sure you shared the target Google Sheet with the service account's
email (Editor access) — found inside that JSON as `client_email`.

### 4. (Optional) Add known Edoofa team numbers
In `.env`, add comma-separated phone numbers (digits only, with country
code, no `+`) of the Edoofa team members who operate inside these groups:
```
EDOOFA_TEAM_NUMBERS=919876543210,919812345678
```
Anyone sending a voice note who is NOT in this list is logged as
"Student/Parent". If left blank, everyone defaults to "Student/Parent" —
fine for a prototype demo, but should be populated for real use.

### 5. Run it
```
npm start
```

A QR code will print in your terminal. Open WhatsApp on your phone ->
Settings -> Linked Devices -> Link a Device -> scan it.

Once connected, the terminal will say:
```
[connection] WhatsApp connected successfully. Listening for voice notes...
```

Send a voice note in any WhatsApp group that this account is a member of.
Within a few seconds you should see log lines like:
```
[voice-note] Detected voice note in group ...
[done] <Group Name> #1 -> Processed
```
...and a new row will appear in your Google Sheet.

## Restarting / re-linking
- Session credentials are stored in `./auth_session/` so you don't need to
  re-scan the QR code every restart — only if you explicitly log out from
  the phone's Linked Devices screen, or delete that folder.
- Downloaded audio files are kept in `./audio_store/` for audit/debug and
  manual reprocessing if a transcription/summary step fails.

## Known prototype limitations (see one-pager for production plan)
- Single Node process — if it crashes mid-run, in-flight messages are
  lost (though Baileys will redeliver some on reconnect). No queue/retry
  layer yet.
- Sequential numbering counter is rebuilt from the Sheet on startup, but
  is in-memory during runtime — fine for single-process use, not safe for
  multiple parallel workers.
- No deduplication of WhatsApp's own message redelivery on reconnect.
- Edoofa team roster is a flat .env list, not yet sheet/DB-backed.
