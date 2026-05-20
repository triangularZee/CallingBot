# Meeting Bot MVP

Two bot flows live in this repo:

- `zoom`: joins a Zoom meeting as a visible participant and records configured system audio with `ffmpeg`.
- `call`: dials into a phone conference through Twilio, sends optional DTMF digits without a spoken prompt, records the call leg, then transcribes and summarizes the recording.
- `telegram`: accepts a conference dial-in number and DTMF/passcode from Telegram, starts the Twilio call, and sends back the Gemini summary.

This MVP assumes the bot is allowed to join the meeting normally. It does not bypass waiting rooms, passwords, SDK restrictions, or host/platform controls.

## Setup

```powershell
npm install
npx playwright install chromium
Copy-Item .env.example .env
```

Fill `.env`.

Install `ffmpeg` and make sure `FFMPEG_PATH` points to it. On Windows, list audio devices with:

```powershell
ffmpeg -list_devices true -f dshow -i dummy
```

For Zoom recording, use a loopback/virtual device such as Stereo Mix or VB-CABLE so the bot captures meeting audio.
If Zoom Web Client audio is too quiet, set `ZOOM_RECORD_GAIN_DB` in `.env`. The recorder applies this gain and limits peaks to reduce clipping.

## Zoom Bot

```powershell
npm run zoom -- --url "https://zoom.us/j/123456789?pwd=..." --title "weekly-sync"
```

Outputs:

- `recordings/*.wav`
- `outputs/*-transcript.json`
- `outputs/*-transcript.txt`
- `outputs/*-gemini-summary.md`

Zoom recording stops passively when the meeting ends, the Zoom page closes, or the process is stopped with `Ctrl+C`. It does not stop on silence or elapsed duration.
On Linux, `npm run start:audio` routes browser output to `zoom_sink` for recording and gives Zoom Web Client a long silent fake microphone file. This prevents Zoom's "Cannot detect your microphone" state while ensuring the bot does not emit Chrome's default fake microphone tone into the meeting.

## Phone Conference Bot

Start the webhook server:

```powershell
npm start
```

Expose it with ngrok or a public URL, then set `PUBLIC_BASE_URL`:

```powershell
ngrok http 3000
```

Dial into a conference:

```powershell
npm run call -- --to "+18005551234" --digits "ww123456#ww7890#" --title "board-call"
```

The `digits` string uses Twilio DTMF syntax. `w` waits briefly, `#` is pound.

The call flow does not speak a greeting. It only waits, presses the configured DTMF digits, stays connected, records the call, transcribes it, and summarizes it with Gemini.
By default, the call ends after 120 seconds of continuous silence. Override this with `silenceTimeout` in seconds.

## Reprocess Recordings

Transcribe one existing recording with OpenAI and summarize it with OpenAI `gpt-5.4` by default:

```powershell
npm run transcribe -- --file "./recordings/example.wav" --title "251212_FY4Q25 Broadcom" --note "AI 매출, backlog, Q&A를 자세히 정리"
```

Process every audio file in `recordings/`:

```powershell
npm run transcribe:all
```

Useful options:

```powershell
npm run transcribe:all -- --dir "./recordings" --limit 3 --language ko
```

Transcripts are saved as both JSON and plain text in `outputs/`; summaries are saved as Markdown.
Set `SUMMARY_PROVIDER=gemini` if you want to switch summaries back to Google AI Studio/Gemini.

## Telegram Bot

Required `.env` values:

```env
OPENAI_API_KEY=...
SUMMARY_PROVIDER=openai
OPENAI_SUMMARY_MODEL=gpt-5.4
GEMINI_API_KEY=...
# or GOOGLE_AI_API_KEY=...
TWILIO_ACCOUNT_SID=...
TWILIO_AUTH_TOKEN=...
TWILIO_FROM_NUMBER=+19206682520
PUBLIC_BASE_URL=https://your-ngrok-or-domain.example
TELEGRAM_BOT_TOKEN=...
TELEGRAM_ALLOWED_CHAT_IDS=
# or TELEGRAM_CHAT_ID=...
```

Run the webhook server in one terminal:

```powershell
npm start
```

For local long polling, run Telegram in another terminal:

```powershell
npm run telegram
```

If another process is already using the same bot token, prefer webhook mode:

```powershell
npm start
npm run telegram:set-webhook
```

Send this to the Telegram bot:

```text
/call
to=+18005551234
meeting=123456789
password=987654
title=251212_FY4Q25 Broadcom
```

Or provide exact DTMF:

```text
/call
to=+18005551234
digits=ww123456789#ww987654#
title=251212_FY4Q25 Broadcom
```

The summary format is optimized for earnings-call notes:

- numbered Korean takeaways
- full `[Q&A]` section with every `Qn)` and `An)` separated by a blank line
- `[Implication]` section with analyst-style bullets

## API

Create a Zoom job:

```http
POST /api/zoom
Content-Type: application/json

{
  "joinUrl": "https://zoom.us/j/...",
  "title": "customer-call"
}
```

Create a phone job:

```http
POST /api/call
Content-Type: application/json

{
  "to": "+18005551234",
  "digits": "ww123456#",
  "title": "vendor-call",
  "silenceTimeout": 120
}
```

Hang up active CallingBot calls:

```http
POST /api/hangup
Content-Type: application/json

{}
```

Hang up one specific call:

```http
POST /api/hangup
Content-Type: application/json

{
  "callSid": "CA..."
}
```

