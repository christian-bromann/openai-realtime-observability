/**
 * LangSmith Observability Server
 * 
 * A standalone server that receives observability data from clients
 * and uploads sessions and turns to LangSmith as traces.
 * 
 * Run: node src/langsmith-server.js
 */

import "dotenv/config";
import express from "express";
import cors from "cors";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { mkdirSync, writeFileSync, existsSync, readdirSync, readFileSync } from "fs";
import { RunTree } from "langsmith";

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

// WebM initialization segments per session (needed to make each turn's audio playable)
const webmInitSegments = new Map();

function log(...args) {
    console.log("[LangSmith]", ...args);
}

/**
 * Extract WebM initialization segment from the first audio chunk.
 * WebM files start with EBML header (0x1A45DFA3) and contain initialization
 * data needed to decode all subsequent clusters.
 */
function extractWebmInitSegment(buffer) {
    // Look for the first Cluster element (0x1F43B675)
    // Everything before it is the initialization segment
    const clusterMarker = Buffer.from([0x1F, 0x43, 0xB6, 0x75]);
    
    for (let i = 0; i < buffer.length - 4; i++) {
        if (buffer[i] === 0x1F && 
            buffer[i + 1] === 0x43 && 
            buffer[i + 2] === 0xB6 && 
            buffer[i + 3] === 0x75) {
            return buffer.slice(0, i);
        }
    }
    
    // If no cluster found, return the whole buffer (it might all be init data)
    return buffer;
}

/**
 * Read a WebM VINT (variable-length integer) from buffer at position.
 * Returns { value, length } where length is bytes consumed.
 */
function readVint(buffer, pos) {
    if (pos >= buffer.length) return { value: 0, length: 0 };
    
    const firstByte = buffer[pos];
    let length = 1;
    let mask = 0x80;
    
    while (length <= 8 && !(firstByte & mask)) {
        length++;
        mask >>= 1;
    }
    
    if (length > 8 || pos + length > buffer.length) {
        return { value: 0, length: 1 };
    }
    
    let value = firstByte & (mask - 1);
    for (let i = 1; i < length; i++) {
        value = (value << 8) | buffer[pos + i];
    }
    
    return { value, length };
}

/**
 * Write a fixed-size unsigned integer to buffer.
 */
function writeUint(buffer, pos, value, size) {
    for (let i = size - 1; i >= 0; i--) {
        buffer[pos + i] = value & 0xFF;
        value = Math.floor(value / 256);
    }
}

/**
 * Find all cluster timestamps in a WebM buffer and adjust them.
 * Returns the adjusted buffer and the original first timestamp.
 */
function adjustClusterTimestamps(buffer) {
    const result = Buffer.from(buffer);
    let firstTimestamp = null;
    let pos = 0;
    
    while (pos < result.length - 10) {
        // Look for Cluster element (0x1F43B675)
        if (result[pos] === 0x1F && 
            result[pos + 1] === 0x43 && 
            result[pos + 2] === 0xB6 && 
            result[pos + 3] === 0x75) {
            
            // Skip Cluster ID (4 bytes)
            let clusterPos = pos + 4;
            
            // Read cluster size (VINT)
            const clusterSize = readVint(result, clusterPos);
            clusterPos += clusterSize.length;
            
            // Look for Timecode element (0xE7) - should be first child
            if (result[clusterPos] === 0xE7) {
                clusterPos++; // Skip Timecode ID
                
                // Read timecode size
                const timecodeSize = readVint(result, clusterPos);
                clusterPos += timecodeSize.length;
                
                // Read current timecode value (big-endian unsigned int)
                let timecode = 0;
                for (let i = 0; i < timecodeSize.value; i++) {
                    timecode = (timecode * 256) + result[clusterPos + i];
                }
                
                if (firstTimestamp === null) {
                    firstTimestamp = timecode;
                    log(`⏱️  First cluster timestamp: ${timecode}ms`);
                }
                
                // Adjust timestamp to be relative to first
                const newTimecode = Math.max(0, timecode - firstTimestamp);
                
                // Write back adjusted timecode (same size)
                writeUint(result, clusterPos, newTimecode, timecodeSize.value);
            }
        }
        pos++;
    }
    
    return { buffer: result, offset: firstTimestamp || 0 };
}

/**
 * Make a WebM audio buffer playable by ensuring it has initialization data
 * and adjusting timestamps to start from 0.
 */
function makePlayableWebm(sessionId, direction, audioBuffer) {
    const key = `${sessionId}_${direction}`;
    let initSegment = webmInitSegments.get(key);
    
    // Check if this buffer starts with EBML header (0x1A45DFA3)
    const hasEbmlHeader = audioBuffer.length >= 4 &&
                          audioBuffer[0] === 0x1A && 
                          audioBuffer[1] === 0x45 && 
                          audioBuffer[2] === 0xDF && 
                          audioBuffer[3] === 0xA3;
    
    if (hasEbmlHeader) {
        // This is a complete WebM file or first chunk, extract and cache init segment
        if (!initSegment) {
            initSegment = extractWebmInitSegment(audioBuffer);
            webmInitSegments.set(key, initSegment);
            log(`📦 Cached WebM init segment for ${direction}: ${initSegment.length} bytes`);
        }
        // Adjust timestamps even for complete files (first turn might start after 0)
        const { buffer: adjusted } = adjustClusterTimestamps(audioBuffer);
        return adjusted;
    }
    
    if (initSegment) {
        // Prepend cached init segment to make this chunk playable
        log(`📦 Prepending init segment (${initSegment.length} bytes) to ${direction} audio`);
        const combined = Buffer.concat([initSegment, audioBuffer]);
        
        // Adjust timestamps to start from 0
        const { buffer: adjusted, offset } = adjustClusterTimestamps(combined);
        if (offset > 0) {
            log(`⏱️  Adjusted timestamps by -${offset}ms`);
        }
        return adjusted;
    }
    
    // No init segment available, log first bytes for debugging
    const firstBytes = audioBuffer.slice(0, 8).toString('hex');
    log(`⚠️  No WebM init segment available for ${direction} (first bytes: ${firstBytes})`);
    return audioBuffer;
}

function findSessionId() {
    return Array.from(sessions.keys()).pop();
}

async function saveTurn(session, turn) {
    const turnDir = join(session.dir, `turn-${String(turn.id).padStart(2, "0")}-${turn.type}`);
    mkdirSync(turnDir, { recursive: true });

    // Save transcript
    if (turn.transcript) {
        writeFileSync(join(turnDir, "transcript.txt"), turn.transcript);
        log(`📝 Transcript: "${turn.transcript.substring(0, 50)}${turn.transcript.length > 50 ? "..." : ""}"`);
    }

    // Save audio (combine base64 chunks into webm file)
    let audioBuffer = null;
    if (turn.audioChunks.length > 0) {
        // Combine all chunks
        let rawBuffer = Buffer.concat(
            turn.audioChunks.map((chunk) => Buffer.from(chunk, "base64"))
        );
        
        // Make the audio playable by ensuring it has WebM headers
        const sessionId = Array.from(sessions.entries())
            .find(([_, s]) => s === session)?.[0];
        audioBuffer = makePlayableWebm(sessionId, turn.type, rawBuffer);
        
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

    // Upload turn to LangSmith as a child run with audio attachment
    if (session.parentRun) {
        try {
            const runType = turn.type === "input" ? "tool" : "llm";
            const turnName = turn.type === "input" ? "User Audio Input" : "Assistant Audio Response";
            
            // Prepare attachments object with audio if available
            // Format: { [name]: { mimeType: string, data: Uint8Array } }
            // Note: attachment names cannot contain periods!
            const attachments = {};
            if (audioBuffer) {
                const attachmentKey = turn.type === "input" ? "user_audio" : "assistant_audio";
                attachments[attachmentKey] = {
                    mimeType: "audio/webm",
                    data: new Uint8Array(audioBuffer),
                };
            }

            const childRun = await session.parentRun.createChild({
                name: turnName,
                run_type: runType,
                inputs: turn.type === "input" 
                    ? { 
                        turn_id: turn.id,
                        type: "audio_input",
                        audio_chunks: turn.audioChunks.length,
                        audio_size_bytes: audioBuffer?.length || 0,
                    }
                    : {
                        turn_id: turn.id,
                        type: "audio_generation",
                        prompt: "Generate audio response",
                    },
                attachments: Object.keys(attachments).length > 0 ? attachments : undefined,
            });

            await childRun.postRun();

            await childRun.end({
                outputs: turn.type === "input"
                    ? {
                        transcript: turn.transcript || "(no transcription)",
                        audio_chunks: turn.audioChunks.length,
                        audio_size_bytes: audioBuffer?.length || 0,
                    }
                    : {
                        transcript: turn.transcript || "(no transcription)",
                        audio_chunks: turn.audioChunks.length,
                        audio_size_bytes: audioBuffer?.length || 0,
                    },
            });

            await childRun.patchRun();
            log(`☁️  Turn ${turn.id} (${turn.type}) uploaded to LangSmith${audioBuffer ? " with audio" : ""}`);
        } catch (err) {
            log(`⚠️  Failed to upload turn to LangSmith:`, err.message);
        }
    }

    log(`✅ Turn ${turn.id} (${turn.type}) saved`);
}

// ============================================================
// OBSERVABILITY ENDPOINT
// ============================================================
app.post("/observability", async (req, res) => {
    const { type } = req.body;

    if (type === "session_start") {
        const { session } = req.body;
        const sessionDir = join(UPLOADS_DIR, session.id);
        mkdirSync(sessionDir, { recursive: true });

        // Create LangSmith parent run for this session
        let parentRun = null;
        try {
            parentRun = new RunTree({
                name: "Realtime Voice Session",
                run_type: "chain",
                inputs: {
                    session_id: session.id,
                    started_at: session.startedAt,
                    type: "openai_realtime_webrtc",
                },
                // project_name: process.env.LANGSMITH_PROJECT || "default",
            });
            await parentRun.postRun();
            log(`☁️  LangSmith trace created: ${parentRun.id}`);
        } catch (err) {
            log(`⚠️  Failed to create LangSmith trace:`, err.message);
        }

        sessions.set(session.id, {
            dir: sessionDir,
            turnCount: 0,
            currentInputTurn: null,
            currentOutputTurn: null,
            pendingInputTurn: null,  // Turn waiting for final audio chunks
            pendingOutputTurn: null, // Turn waiting for final audio chunks
            events: [],
            parentRun,
        });

        writeFileSync(
            join(sessionDir, "session.json"),
            JSON.stringify({ ...session, langsmithRunId: parentRun?.id, events: [] }, null, 2)
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
                // Move to pending - keep accepting audio/transcript for 1500ms before saving
                // (transcription from OpenAI can take 1-2 seconds to arrive)
                session.pendingInputTurn = session.currentInputTurn;
                session.currentInputTurn = null;
                const turnToSave = session.pendingInputTurn;
                setTimeout(async () => {
                    if (session.pendingInputTurn === turnToSave) {
                        session.pendingInputTurn = null;
                    }
                    await saveTurn(session, turnToSave);
                }, 1500);
            }

            // Capture input audio transcription (arrives async from OpenAI)
            if (event.type === "conversation.item.input_audio_transcription.completed") {
                const inputTurn = session.currentInputTurn || session.pendingInputTurn;
                if (inputTurn && event.transcript) {
                    inputTurn.transcript = event.transcript;
                    log(`📝 Input transcript received: "${event.transcript.substring(0, 50)}${event.transcript.length > 50 ? "..." : ""}"`);
                }
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

            if (event.type === "response.output_audio_transcript.delta") {
                const outputTurn = session.currentOutputTurn || session.pendingOutputTurn;
                if (outputTurn) {
                    outputTurn.transcript += event.delta || "";
                }
            }

            if (event.type === "output_audio_buffer.stopped" && session.currentOutputTurn) {
                // Move to pending - keep accepting audio chunks for 500ms before saving
                session.pendingOutputTurn = session.currentOutputTurn;
                session.currentOutputTurn = null;
                const turnToSave = session.pendingOutputTurn;
                setTimeout(async () => {
                    if (session.pendingOutputTurn === turnToSave) {
                        session.pendingOutputTurn = null;
                    }
                    await saveTurn(session, turnToSave);
                }, 500);
            }
        }
    }

    if (type === "audio") {
        const { audio } = req.body;
        const sessionId = audio.sessionId || findSessionId();
        const session = sessions.get(sessionId);

        if (session && audio.data) {
            // Cache the WebM init segment from the first audio chunk of each direction
            const initKey = `${sessionId}_${audio.direction}`;
            if (!webmInitSegments.has(initKey)) {
                const chunkBuffer = Buffer.from(audio.data, "base64");
                // Check for EBML header (WebM signature: 0x1A 0x45 0xDF 0xA3)
                if (chunkBuffer.length >= 4 &&
                    chunkBuffer[0] === 0x1A && 
                    chunkBuffer[1] === 0x45 && 
                    chunkBuffer[2] === 0xDF && 
                    chunkBuffer[3] === 0xA3) {
                    const initSegment = extractWebmInitSegment(chunkBuffer);
                    webmInitSegments.set(initKey, initSegment);
                    log(`📦 Cached WebM init segment for ${audio.direction}: ${initSegment.length} bytes`);
                }
            }
            
            // Check current turn first, then pending turn (for late-arriving chunks)
            const turn = audio.direction === "input"
                ? (session.currentInputTurn || session.pendingInputTurn)
                : (session.currentOutputTurn || session.pendingOutputTurn);

            if (turn) {
                turn.audioChunks.push(audio.data);
            }
        }
    }

    if (type === "session_end") {
        const { session: summary } = req.body;
        const sessionId = summary.id || findSessionId();
        const session = sessions.get(sessionId);

        if (session) {
            // Save any active or pending turns
            if (session.currentInputTurn) {
                await saveTurn(session, session.currentInputTurn);
            }
            if (session.pendingInputTurn) {
                await saveTurn(session, session.pendingInputTurn);
            }
            if (session.currentOutputTurn) {
                await saveTurn(session, session.currentOutputTurn);
            }
            if (session.pendingOutputTurn) {
                await saveTurn(session, session.pendingOutputTurn);
            }

            // End the LangSmith parent run
            if (session.parentRun) {
                try {
                    await session.parentRun.end({
                        outputs: {
                            session_id: summary.id,
                            duration_ms: summary.duration,
                            event_count: summary.eventCount,
                            transcript: summary.transcript,
                        },
                    });
                    await session.parentRun.patchRun();
                    log(`☁️  LangSmith trace completed`);
                } catch (err) {
                    log(`⚠️  Failed to complete LangSmith trace:`, err.message);
                }
            }

            const metaPath = join(session.dir, "session.json");
            writeFileSync(
                metaPath,
                JSON.stringify({ 
                    ...summary, 
                    langsmithRunId: session.parentRun?.id,
                    events: session.events 
                }, null, 2)
            );

            log(`📊 Session ended: ${summary.eventCount} events, ${summary.duration}ms`);
            log(`📁 Saved to: ${session.dir}`);
            
            // Clean up WebM init segment cache for this session
            webmInitSegments.delete(`${sessionId}_input`);
            webmInitSegments.delete(`${sessionId}_output`);
            
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
                    langsmithRunId: meta.langsmithRunId,
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
    res.json({ 
        status: "ok", 
        sessions: sessions.size,
        langsmith: {
            configured: !!process.env.LANGSMITH_API_KEY,
            project: process.env.LANGSMITH_PROJECT || "default",
        }
    });
});

// ============================================================
// START SERVER
// ============================================================
const langsmithConfigured = !!process.env.LANGSMITH_API_KEY;

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
    if (langsmithConfigured) {
        console.log(`  ☁️  LangSmith: ✅ Connected (project: ${process.env.LANGSMITH_PROJECT || "default"})`);
    } else {
        console.log(`  ☁️  LangSmith: ⚠️  Not configured (set LANGSMITH_API_KEY in .env)`);
    }
    console.log("");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("");
});
