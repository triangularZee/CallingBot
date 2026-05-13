# Meeting Bot MVP

Two bot flows live in this repo:

- `zoom`: joins a Zoom meeting as a visible participant and records configured system audio with `ffmpeg`.
- `call`: dials into a phone conference through Twilio, sends optional DTMF digits, records the call leg, then transcribes and summarizes the recording.

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

## Zoom Bot

```powershell
npm run zoom -- --url "https://zoom.us/j/123456789?pwd=..." --title "weekly-sync"
```

Outputs:

- `recordings/*.wav`
- `outputs/*.transcript.json`
- `outputs/*.summary.md`

Stop with `Ctrl+C`. The process finalizes transcription after the browser/recorder stops.

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
  "title": "vendor-call"
}
```

