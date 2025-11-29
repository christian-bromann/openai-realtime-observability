/**
 * OpenAI Realtime API Demo Server
 * 
 * This server:
 * 1. Serves the demo web app
 * 2. Proxies SDP signaling to OpenAI
 * 
 * Run: node test.js
 */

import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();
const PORT = process.env.PORT || 3000;
const LANGSMITH_URL = process.env.LANGSMITH_URL || "http://localhost:3001";

// Serve static files from public directory
app.use(express.static(join(__dirname, "public")));

const key = process.env.OPENAI_API_KEY;
if (!key) {
    throw new Error("OPENAI_API_KEY is not set");
}

// ============================================================
// OPENAI REALTIME API PROXY
// ============================================================
app.use(express.text({ type: ["application/sdp", "text/plain"] }));

const sessionConfig = JSON.stringify({
    type: "realtime",
    model: "gpt-realtime",
    audio: { output: { voice: "marin" } },
    // input_audio_transcription: { model: "gpt-4o-transcribe" },
});

app.post("/session", async (req, res) => {
    console.log("[OpenAI] Creating realtime session...");
    
    const fd = new FormData();
    fd.set("sdp", req.body);
    fd.set("session", sessionConfig);

    try {
        const r = await fetch("https://api.openai.com/v1/realtime/calls", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${key}`,
            },
            body: fd,
        });
        
        const sdp = await r.text();
        console.log("[OpenAI] Session created successfully");
        res.send(sdp);
    } catch (error) {
        console.error("[OpenAI] Error:", error);
        res.status(500).json({ error: "Failed to create session" });
    }
});

// ============================================================
// START SERVER
// ============================================================
app.listen(PORT, () => {
    console.log("");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("  🚀 OpenAI Realtime Demo Server");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("");
    console.log(`  🌐 App:       http://localhost:${PORT}`);
    console.log(`  📄 Demo:      http://localhost:${PORT}/openai-example.html`);
    console.log("");
    console.log(`  🦜 LangSmith: ${LANGSMITH_URL}`);
    console.log(`     SDK:       ${LANGSMITH_URL}/sdk/index.js`);
    console.log("     (Run: node src/langsmith-server.js)");
    console.log("");
    console.log("═══════════════════════════════════════════════════════════");
    console.log("");
});
