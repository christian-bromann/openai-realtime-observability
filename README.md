# OpenAI Realtime API Observability

Zero-config observability for OpenAI Realtime API WebRTC sessions, powered by LangSmith.

**Use OpenAI's exact example code** - just add one import and one line.

![Demo Screenshot](demo.png)

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           BROWSER                                        │
│                                                                          │
│   import { enable } from 'http://langsmith:3001/sdk/index.js'           │
│                                                                          │
└───────────────┬─────────────────────────────────┬───────────────────────┘
                │                                 │
                │ SDP Signaling                   │ SDK + Observability Data
                │ POST /session                   │ POST /observability
                ▼                                 ▼
┌───────────────────────────────────┐   ┌───────────────────────────────────┐
│  Your App Server (port 3000)      │   │  🦜 LangSmith Server (port 3001)  │
│  ─────────────────────────────    │   │  ───────────────────────────────  │
│  • Serves your web app            │   │  • Serves SDK at /sdk/index.js    │
│  • Proxies SDP to OpenAI          │   │  • Receives events & audio        │
│                                   │   │  • Saves sessions to ./uploads/   │
│                                   │   │  • REST API for session data      │
└───────────────────────────────────┘   └───────────────────────────────────┘
```

## Quick Start

### 1. Start the LangSmith Server

```bash
npm install
npm run langsmith
```

### 2. Start Your App Server

```bash
npm start
```

### 3. Open the Demo

```
http://localhost:3000/openai-example.html
```

## Integration

Import the SDK from LangSmith and enable observability:

```javascript
// Import SDK from LangSmith
import { enable, recordInput } from 'http://localhost:3001/sdk/index.js';

// Enable observability (only in development!)
if (process.env.NODE_ENV !== 'production') {
    enable({
        endpoint: 'http://localhost:3001/observability',
        debug: true,
    });
}

// Use OpenAI's exact example code - UNCHANGED!
const pc = new RTCPeerConnection();

const audioElement = document.createElement("audio");
audioElement.autoplay = true;
pc.ontrack = (e) => (audioElement.srcObject = e.streams[0]);

const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
pc.addTrack(ms.getTracks()[0]);

// One extra line to record input audio
recordInput(ms);

const dc = pc.createDataChannel("oai-events");

const offer = await pc.createOffer();
await pc.setLocalDescription(offer);

const sdpResponse = await fetch("/session", {
    method: "POST",
    body: offer.sdp,
    headers: { "Content-Type": "application/sdp" },
});

await pc.setRemoteDescription({
    type: "answer",
    sdp: await sdpResponse.text(),
});
```

## LangSmith Server

### Endpoints

| Endpoint | Description |
|----------|-------------|
| `GET /sdk/index.js` | Observability SDK |
| `POST /observability` | Receive observability data |
| `GET /sessions` | List all sessions |
| `GET /sessions/:id` | Get session details + events |
| `GET /uploads/:sessionId/...` | Download audio files |
| `GET /health` | Health check |

### Output Structure

```
uploads/
└── session_1764218930107_yl7tj5ys8/
    ├── session.json              # Full session metadata + all events
    ├── turn-01-input/
    │   ├── audio.webm            # Your voice
    │   └── meta.json
    ├── turn-02-output/
    │   ├── audio.webm            # AI response
    │   ├── transcript.txt        # "Hey there! I'm doing great..."
    │   └── meta.json
    └── ...
```

### Console Output

```
═══════════════════════════════════════════════════════════
  🦜 LangSmith Observability Server
═══════════════════════════════════════════════════════════

  🌐 Server:    http://localhost:3001
  📦 SDK:       http://localhost:3001/sdk/index.js
  📊 Sessions:  http://localhost:3001/sessions
  📁 Uploads:   http://localhost:3001/uploads/

[LangSmith] 📁 Session started: session_xxx
[LangSmith] 🎤 Input turn 1 started
[LangSmith] ✅ Turn 1 (input) saved
[LangSmith] 🔊 Output turn 2 started
[LangSmith] 📝 Transcript: "Hey there! I'm doing great..."
[LangSmith] 🎵 Audio: 145.2 KB
[LangSmith] ✅ Turn 2 (output) saved
[LangSmith] 📊 Session ended: 47 events, 12340ms
```

## SDK API

### `enable(options)`

Enable observability. **Call before creating any RTCPeerConnection.**

```javascript
enable({
    // Required: LangSmith observability endpoint
    endpoint: 'http://localhost:3001/observability',
    
    // Log to console (default: false)
    debug: true,
    
    // Optional callbacks for custom handling
    onEvent: (event) => {
        console.log(event.direction, event.type);
    },
    
    onAudio: (audio) => {
        console.log(audio.direction, audio.size);
    },
    
    onSessionStart: (session) => {
        console.log('Started:', session.id);
    },
    
    onSessionEnd: (session) => {
        console.log('Duration:', session.duration);
        console.log('Transcript:', session.transcript.output);
    },
    
    // Disable audio recording (default: true)
    recordAudio: false,
});
```

### `disable()`

Disable observability and restore original APIs.

### `recordInput(stream)`

Record microphone audio. Call after `getUserMedia()`.

```javascript
const ms = await navigator.mediaDevices.getUserMedia({ audio: true });
recordInput(ms);
```

### `getSessionAudio()`

Get recorded audio blobs for local download/playback.

### `isActive()`

Check if observability is enabled.

## Production Safety

**No code runs unless you explicitly enable it:**

```javascript
// Only enable in development
if (process.env.NODE_ENV !== 'production') {
    enable({ endpoint: 'http://langsmith:3001/observability' });
}
```

When `enable()` is not called:
- Zero overhead - original APIs untouched
- Zero network requests
- Zero memory usage

## What Gets Captured

| Data | How |
|------|-----|
| **SDP Signaling** | Intercepts `fetch()` calls with SDP content |
| **All Events** | Wraps `RTCDataChannel.send()` and `onmessage` |
| **Input Audio** | `MediaRecorder` on microphone stream |
| **Output Audio** | `MediaRecorder` on received audio track |
| **Transcripts** | Extracted from `response.output_audio_transcript.delta` |

## Events Captured

All OpenAI Realtime API events:

```
session.created
session.updated
input_audio_buffer.speech_started
input_audio_buffer.speech_stopped
input_audio_buffer.committed
conversation.item.added
response.created
response.output_audio_transcript.delta
output_audio_buffer.started
output_audio_buffer.stopped
response.done
rate_limits.updated
...
```

## Files

```
├── src/
│   ├── index.js              # Observability SDK (served by LangSmith)
│   └── langsmith-server.js   # LangSmith server
├── public/
│   ├── openai-example.html   # Demo with LangSmith integration
│   └── index.html            # Original OpenAI demo
├── uploads/                  # Session data (created by LangSmith)
├── test.js                   # Demo app server
└── package.json
```

## Scripts

```bash
npm run langsmith  # Start LangSmith server (port 3001)
npm start          # Start demo app server (port 3000)
```

## License

MIT
