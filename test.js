import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const app = express();

// Serve static files from public directory
app.use(express.static(join(__dirname, "public")));
const key = process.env.OPENAI_API_KEY;
if (!key) {
    throw new Error("OPENAI_API_KEY is not set");
}

const langchainFetch = (url, options) => {
    console.log("langchainFetch", url, options);
    return fetch(url, options).then(async (res) => {
        const newRes = res.clone();
        const text = await newRes.text();
        console.log(text);
        return res
    });
}

// Parse raw SDP payloads posted from the browser
app.use(express.text({ type: ["application/sdp", "text/plain"] }));

const sessionConfig = JSON.stringify({
    type: "realtime",
    model: "gpt-realtime",
    audio: { output: { voice: "marin" } }
});

// An endpoint which creates a Realtime API session.
app.post("/session", async (req, res) => {
    const fd = new FormData();
    fd.set("sdp", req.body);
    fd.set("session", sessionConfig);

    try {
        const r = await langchainFetch("https://api.openai.com/v1/realtime/calls", {
            method: "POST",
            headers: {
                Authorization: `Bearer ${key}`,
            },
            body: fd,
        });
        // Send back the SDP we received from the OpenAI REST API
        const sdp = await r.text();
        res.send(sdp);
    } catch (error) {
        console.error("Token generation error:", error);
        res.status(500).json({ error: "Failed to generate token" });
    }
});

app.listen(3000, () => {
    console.log("Server running at http://localhost:3000");
});