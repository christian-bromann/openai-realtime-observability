/**
 * OpenAI Realtime API Observability
 * 
 * Zero-config observability for OpenAI Realtime WebRTC sessions.
 * Patches global APIs so your existing OpenAI code works unchanged.
 * 
 * @example
 * // Enable observability (e.g., only in development)
 * import { enable } from 'realtime-observability';
 * 
 * if (process.env.NODE_ENV !== 'production') {
 *     enable({
 *         onEvent: (event) => console.log(event),
 *         // or send to your backend:
 *         endpoint: 'https://your-server.com/observability'
 *     });
 * }
 * 
 * // Then use OpenAI's exact example code - no changes needed!
 * const pc = new RTCPeerConnection();
 * // ... rest of your code
 */

let isEnabled = false;
let config = {};
let sessionData = null;
let OriginalRTCPeerConnection = null;
let originalFetch = null;

// Audio recording state
let inputRecorder = null;
let outputRecorder = null;
let allInputBlobs = [];
let allOutputBlobs = [];

/**
 * Enable observability for OpenAI Realtime API sessions.
 * 
 * @param {Object} options Configuration options
 * @param {string} [options.endpoint] - URL to POST observability data to
 * @param {Function} [options.onEvent] - Callback for each data channel event
 * @param {Function} [options.onAudio] - Callback for audio chunks
 * @param {Function} [options.onSessionStart] - Callback when session starts
 * @param {Function} [options.onSessionEnd] - Callback when session ends with full summary
 * @param {boolean} [options.recordAudio=true] - Whether to record audio
 * @param {boolean} [options.debug=false] - Log debug info to console
 */
export function enable(options = {}) {
    if (isEnabled) {
        console.warn('[RealtimeObservability] Already enabled');
        return;
    }

    config = {
        endpoint: null,
        onEvent: null,
        onAudio: null,
        onSessionStart: null,
        onSessionEnd: null,
        recordAudio: true,
        debug: false,
        ...options
    };

    // Store originals
    OriginalRTCPeerConnection = globalThis.RTCPeerConnection;
    originalFetch = globalThis.fetch;

    // Patch RTCPeerConnection
    globalThis.RTCPeerConnection = function(...args) {
        const pc = new OriginalRTCPeerConnection(...args);
        return wrapPeerConnection(pc);
    };
    // Copy static properties
    Object.setPrototypeOf(globalThis.RTCPeerConnection, OriginalRTCPeerConnection);

    // Patch fetch
    globalThis.fetch = function(url, options) {
        return observableFetch(url, options);
    };

    isEnabled = true;
    log('Enabled');
}

/**
 * Disable observability and restore original APIs.
 */
export function disable() {
    if (!isEnabled) return;

    globalThis.RTCPeerConnection = OriginalRTCPeerConnection;
    globalThis.fetch = originalFetch;
    
    isEnabled = false;
    log('Disabled');
}

/**
 * Check if observability is currently enabled.
 */
export function isActive() {
    return isEnabled;
}

// Internal helpers

function log(...args) {
    if (config.debug) {
        console.log('[RealtimeObservability]', ...args);
    }
}

function generateSessionId() {
    return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
}

function startSession() {
    sessionData = {
        id: generateSessionId(),
        startedAt: new Date().toISOString(),
        events: [],
        transcript: { input: '', output: '' },
    };
    allInputBlobs = [];
    allOutputBlobs = [];
    
    log('Session started:', sessionData.id);
    emit('session_start', { session: { id: sessionData.id, startedAt: sessionData.startedAt } });
    config.onSessionStart?.({ id: sessionData.id, startedAt: sessionData.startedAt });
}

function endSession() {
    if (!sessionData) return;

    // Stop recorders
    stopRecorder(inputRecorder);
    stopRecorder(outputRecorder);
    inputRecorder = null;
    outputRecorder = null;

    sessionData.endedAt = new Date().toISOString();
    sessionData.duration = new Date(sessionData.endedAt) - new Date(sessionData.startedAt);

    const summary = {
        id: sessionData.id,
        startedAt: sessionData.startedAt,
        endedAt: sessionData.endedAt,
        duration: sessionData.duration,
        eventCount: sessionData.events.length,
        transcript: sessionData.transcript,
        audioChunks: {
            input: allInputBlobs.length,
            output: allOutputBlobs.length
        }
    };

    log('Session ended:', summary);
    emit('session_end', { session: summary });
    config.onSessionEnd?.(summary);

    sessionData = null;
}

function stopRecorder(recorder) {
    if (recorder && recorder.state !== 'inactive') {
        try { recorder.stop(); } catch (e) {}
    }
}

function recordEvent(event, direction) {
    if (!sessionData) return;

    const enrichedEvent = {
        ...event,
        direction,
        timestamp: new Date().toISOString(),
    };

    sessionData.events.push(enrichedEvent);

    // Extract transcripts
    if (event.type === 'response.output_audio_transcript.delta' && event.delta) {
        sessionData.transcript.output += event.delta;
    }
    if (event.type === 'conversation.item.input_audio_transcription.completed' && event.transcript) {
        sessionData.transcript.input += (sessionData.transcript.input ? ' ' : '') + event.transcript;
    }

    log('Event:', direction, event.type);
    emit('event', { event: enrichedEvent });
    config.onEvent?.(enrichedEvent);
}

function recordAudioChunk(direction, blob) {
    if (!sessionData || !config.recordAudio) return;

    if (direction === 'input') {
        allInputBlobs.push(blob);
    } else {
        allOutputBlobs.push(blob);
    }

    const audioData = {
        direction,
        size: blob.size,
        timestamp: new Date().toISOString(),
    };

    log('Audio:', direction, blob.size, 'bytes');
    
    // Convert to base64 for transmission if needed
    if (config.onAudio || config.endpoint) {
        const reader = new FileReader();
        reader.onload = () => {
            audioData.data = reader.result.split(',')[1];
            audioData.blob = blob;
            emit('audio', { audio: audioData });
            config.onAudio?.(audioData);
        };
        reader.readAsDataURL(blob);
    }
}

function emit(type, data) {
    if (!config.endpoint) return;

    originalFetch(config.endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            type,
            ...data,
            timestamp: new Date().toISOString()
        }),
    }).catch(err => log('Failed to send to endpoint:', err.message));
}

// Wrap fetch to detect SDP exchange
function observableFetch(url, options) {
    const urlStr = typeof url === 'string' ? url : url.toString();
    
    // Detect realtime API calls or SDP content
    const isRealtimeCall = urlStr.includes('realtime') || 
                          urlStr.includes('/session') ||
                          options?.headers?.['Content-Type'] === 'application/sdp';
    
    if (!isRealtimeCall) {
        return originalFetch(url, options);
    }

    // Start session if not already
    if (!sessionData) {
        startSession();
    }

    // Capture SDP offer
    if (options?.body && typeof options.body === 'string' && options.body.startsWith('v=0')) {
        log('SDP offer captured');
        emit('signaling', { type: 'offer', sdp: options.body });
    }

    return originalFetch(url, options).then(async (response) => {
        const cloned = response.clone();
        const text = await cloned.text();
        
        // Capture SDP answer
        if (text.startsWith('v=0')) {
            log('SDP answer captured');
            emit('signaling', { type: 'answer', sdp: text });
        }

        return new Response(text, {
            status: response.status,
            statusText: response.statusText,
            headers: response.headers,
        });
    });
}

// Wrap RTCPeerConnection
function wrapPeerConnection(pc) {
    if (!sessionData) {
        startSession();
    }

    // Wrap createDataChannel
    const origCreateDataChannel = pc.createDataChannel.bind(pc);
    pc.createDataChannel = function(label, options) {
        const dc = origCreateDataChannel(label, options);
        wrapDataChannel(dc);
        return dc;
    };

    // Intercept ontrack for output audio recording
    let userOnTrack = null;
    Object.defineProperty(pc, 'ontrack', {
        get: () => userOnTrack,
        set: (handler) => { userOnTrack = handler; },
        configurable: true
    });

    pc.addEventListener('track', (event) => {
        if (config.recordAudio && event.track.kind === 'audio' && event.streams[0]) {
            startOutputRecording(event.streams[0]);
        }
        userOnTrack?.call(pc, event);
    });

    // End session on close
    const origClose = pc.close.bind(pc);
    pc.close = function() {
        endSession();
        return origClose();
    };

    return pc;
}

// Wrap DataChannel
function wrapDataChannel(dc) {
    // Intercept incoming messages
    dc.addEventListener('message', (event) => {
        try {
            const parsed = JSON.parse(event.data);
            recordEvent(parsed, 'incoming');
        } catch {
            recordEvent({ type: 'raw', data: event.data }, 'incoming');
        }
    });

    // Intercept outgoing messages
    const origSend = dc.send.bind(dc);
    dc.send = function(data) {
        try {
            const parsed = JSON.parse(data);
            recordEvent(parsed, 'outgoing');
        } catch {
            recordEvent({ type: 'raw', data }, 'outgoing');
        }
        return origSend(data);
    };
}

// Audio recording
function startInputRecording(stream) {
    if (!config.recordAudio || inputRecorder) return;

    try {
        inputRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
        inputRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) recordAudioChunk('input', e.data);
        };
        inputRecorder.start(1000);
        log('Input audio recording started');
    } catch (err) {
        log('Failed to start input recording:', err.message);
    }
}

function startOutputRecording(stream) {
    if (!config.recordAudio || outputRecorder) return;

    try {
        outputRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
        outputRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) recordAudioChunk('output', e.data);
        };
        outputRecorder.start(1000);
        log('Output audio recording started');
    } catch (err) {
        log('Failed to start output recording:', err.message);
    }
}

/**
 * Call this after getUserMedia to record input audio.
 * This is the only manual step required.
 * 
 * @param {MediaStream} stream - The microphone stream from getUserMedia
 */
export function recordInput(stream) {
    if (!isEnabled) return;
    startInputRecording(stream);
}

/**
 * Get the current session's audio blobs for download/playback.
 * Returns null if no session is active.
 */
export function getSessionAudio() {
    if (!sessionData) return null;
    
    return {
        input: allInputBlobs.length > 0 
            ? new Blob(allInputBlobs, { type: 'audio/webm;codecs=opus' })
            : null,
        output: allOutputBlobs.length > 0
            ? new Blob(allOutputBlobs, { type: 'audio/webm;codecs=opus' })
            : null,
    };
}

// Auto-disable on page unload
if (typeof window !== 'undefined') {
    window.addEventListener('beforeunload', () => {
        if (sessionData) endSession();
    });
}

