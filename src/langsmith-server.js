/**
 * LangSmith Observability Server
 * 
 * A standalone server that receives observability data from clients
 * and saves sessions, turns, audio, and transcripts to disk.
 * 
 * Run: node src/langsmith-server.js
 */

import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.LANGSMITH_PORT || 3001;
const UPLOADS_DIR = join(__dirname, "..", "uploads");

// Ensure uploads directory exists
if (!existsSync(UPLOADS_DIR)) {
    mkdirSync(UPLOADS_DIR, { recursive: true });
}

// Middleware
app.use(cors());
app.use(express.json({ limit: "50mb" }));

// Serve the observability client library
app.use("/sdk", express.static(join(__dirname)));

// Track active sessions
const sessions = new Map();

function log(...args) {
    console.log("[LangSmith]", ...args);
}

function findSessionId() {
    return Array.from(sessions.keys()).pop();
}

function saveTurn(session, turn) {
    const turnDir = join(session.dir, `turn-${String(turn.id).padStart(2, "0")}-${turn.type}`);
    mkdirSync(turnDir, { recursive: true });

    // Save transcript
    if (turn.transcript) {
        writeFileSync(join(turnDir, "transcript.txt"), turn.transcript);
        log(`📝 Transcript: "${turn.transcript.substring(0, 50)}${turn.transcript.length > 50 ? "..." : ""}"`);
    }

    // Save audio (combine base64 chunks into webm file)
    if (turn.audioChunks.length > 0) {
        const audioBuffer = Buffer.concat(
            turn.audioChunks.map((chunk) => Buffer.from(chunk, "base64"))
        );
        writeFileSync(join(turnDir, "audio.webm"), audioBuffer);
        log(`🎵 Audio: ${(audioBuffer.length / 1024).toFixed(1)} KB`);
    }

    // Save turn metadata
    writeFileSync(
        join(turnDir, "meta.json"),
        JSON.stringify(
            {
                id: turn.id,
                type: turn.type,
                startedAt: turn.startedAt,
                audioChunks: turn.audioChunks.length,
                transcriptLength: turn.transcript?.length || 0,
            },
            null,
            2
        )
    );

    log(`✅ Turn ${turn.id} (${turn.type}) saved`);
}

// ============================================================
// OBSERVABILITY ENDPOINT
// ============================================================
app.post("/observability", (req, res) => {
    const { type } = req.body;

    if (type === "session_start") {
        const { session } = req.body;
        const sessionDir = join(UPLOADS_DIR, session.id);
        mkdirSync(sessionDir, { recursive: true });

        sessions.set(session.id, {
            dir: sessionDir,
            turnCount: 0,
            currentInputTurn: null,
            currentOutputTurn: null,
            events: [],
        });

        writeFileSync(
            join(sessionDir, "session.json"),
            JSON.stringify({ ...session, events: [] }, null, 2)
        );
        log(`📁 Session started: ${session.id}`);
    }

    if (type === "event") {
        const { event } = req.body;
        const sessionId = event.sessionId || findSessionId();
        const session = sessions.get(sessionId);

        if (session) {
            session.events.push(event);

            // Track input turns
            if (event.type === "input_audio_buffer.speech_started") {
                session.turnCount++;
                session.currentInputTurn = {
                    id: session.turnCount,
                    type: "input",
                    startedAt: event.timestamp,
                    audioChunks: [],
                    transcript: "",
                };
                log(`🎤 Input turn ${session.turnCount} started`);
            }

            if (event.type === "input_audio_buffer.speech_stopped" && session.currentInputTurn) {
                saveTurn(session, session.currentInputTurn);
                session.currentInputTurn = null;
            }

            // Track output turns
            if (event.type === "output_audio_buffer.started") {
                session.turnCount++;
                session.currentOutputTurn = {
                    id: session.turnCount,
                    type: "output",
                    startedAt: event.timestamp,
                    audioChunks: [],
                    transcript: "",
                };
                log(`🔊 Output turn ${session.turnCount} started`);
            }

            if (event.type === "response.output_audio_transcript.delta" && session.currentOutputTurn) {
                session.currentOutputTurn.transcript += event.delta || "";
            }

            if (event.type === "output_audio_buffer.stopped" && session.currentOutputTurn) {
                saveTurn(session, session.currentOutputTurn);
                session.currentOutputTurn = null;
            }
        }
    }

    if (type === "audio") {
        const { audio } = req.body;
        const sessionId = audio.sessionId || findSessionId();
        const session = sessions.get(sessionId);

        if (session) {
            const turn = audio.direction === "input"
                ? session.currentInputTurn
                : session.currentOutputTurn;

            if (turn && audio.data) {
                turn.audioChunks.push(audio.data);
            }
        }
    }

    if (type === "session_end") {
        const { session: summary } = req.body;
        const sessionId = summary.id || findSessionId();
        const session = sessions.get(sessionId);

        if (session) {
            if (session.currentInputTurn) {
                saveTurn(session, session.currentInputTurn);
            }
            if (session.currentOutputTurn) {
                saveTurn(session, session.currentOutputTurn);
            }

            const metaPath = join(session.dir, "session.json");
            writeFileSync(
                metaPath,
                JSON.stringify({ ...summary, events: session.events }, null, 2)
            );

            log(`📊 Session ended: ${summary.eventCount} events, ${summary.duration}ms`);
            log(`📁 Saved to: ${session.dir}`);
            sessions.delete(sessionId);
        }
    }

    if (type === "signaling") {
        log(`📡 SDP ${req.body.type} captured`);
    }

    res.json({ ok: true });
});

// ============================================================
// API ENDPOINTS
// ============================================================
app.get("/sessions", (req, res) => {
    try {
        const dirs = readdirSync(UPLOADS_DIR);
        const sessionList = [];

        for (const dir of dirs) {
            const metaPath = join(UPLOADS_DIR, dir, "session.json");
            if (existsSync(metaPath)) {
                const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
                sessionList.push({
                    id: meta.id,
                    startedAt: meta.startedAt,
                    endedAt: meta.endedAt,
                    duration: meta.duration,
                    eventCount: meta.eventCount || meta.events?.length || 0,
                });
            }
        }

        res.json(sessionList.sort((a, b) => new Date(b.startedAt) - new Date(a.startedAt)));
    } catch (err) {
        res.json([]);
    }
});

app.get("/sessions/:id", (req, res) => {
    const metaPath = join(UPLOADS_DIR, req.params.id, "session.json");
    if (existsSync(metaPath)) {
        const meta = JSON.parse(readFileSync(metaPath, "utf-8"));
        res.json(meta);
    } else {
        res.status(404).json({ error: "Session not found" });
    }
});

// Serve audio files
app.use("/uploads", express.static(UPLOADS_DIR));

// Health check
app.get("/health", (req, res) => {
    res.json({ status: "ok", sessions: sessions.size });
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
    console.log("");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  🦜 LangSmith Observability Server");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("");
    console.log(`  🌐 Server:    http://localhost:${PORT}`);
    console.log(`  📦 SDK:       http://localhost:${PORT}/sdk/index.js`);
    console.log(`  📊 Sessions:  http://localhost:${PORT}/sessions`);
    console.log(`  📁 Uploads:   http://localhost:${PORT}/uploads/`);
    console.log(`  💚 Health:    http://localhost:${PORT}/health`);
    console.log("");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("");
});

