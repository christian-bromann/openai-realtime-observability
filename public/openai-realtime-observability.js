/**
 * OpenAI Realtime API Observability Package
 * 
 * Drop-in wrapper to capture all data from OpenAI Realtime sessions:
 * - SDP signaling (request/response)
 * - Data channel messages (all events)
 * - Audio streams (input/output)
 */

export function createRealtimeObserver(options = {}) {
    const {
        onEvent = () => {},
        onAudio = () => {},
        onSessionStart = () => {},
        onSessionEnd = () => {},
        onSignaling = () => {},
        recordAudio = true,
    } = options;

    let sessionId = null;
    let sessionData = null;
    let inputRecorder = null;
    let outputRecorder = null;

    function generateSessionId() {
        return `session_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;
    }

    function startSession() {
        sessionId = generateSessionId();
        sessionData = {
            id: sessionId,
            startedAt: new Date().toISOString(),
            events: [],
            signaling: { offer: null, answer: null },
            transcript: { input: '', output: '' },
            audioChunks: { input: 0, output: 0 },
        };
        onSessionStart({ id: sessionId, startedAt: sessionData.startedAt });
        return sessionId;
    }

    function endSession() {
        if (inputRecorder && inputRecorder.state !== 'inactive') {
            inputRecorder.stop();
        }
        if (outputRecorder && outputRecorder.state !== 'inactive') {
            outputRecorder.stop();
        }

        if (sessionData) {
            sessionData.endedAt = new Date().toISOString();
            sessionData.duration = new Date(sessionData.endedAt) - new Date(sessionData.startedAt);
            
            onSessionEnd({
                id: sessionData.id,
                startedAt: sessionData.startedAt,
                endedAt: sessionData.endedAt,
                duration: sessionData.duration,
                eventCount: sessionData.events.length,
                transcript: sessionData.transcript,
                audioChunks: sessionData.audioChunks,
            });
        }

        sessionId = null;
        sessionData = null;
    }

    function recordEvent(event, direction) {
        const enrichedEvent = {
            ...event,
            direction,
            timestamp: new Date().toISOString(),
            sessionId,
        };

        if (sessionData) {
            sessionData.events.push(enrichedEvent);

            if (event.type === 'response.output_audio_transcript.delta' && event.delta) {
                sessionData.transcript.output += event.delta;
            }
            if (event.type === 'conversation.item.input_audio_transcription.completed' && event.transcript) {
                sessionData.transcript.input += (sessionData.transcript.input ? ' ' : '') + event.transcript;
            }
        }

        onEvent(enrichedEvent);
    }

    // Wrap fetch - captures ALL fetches with SDP content type or body
    function observableFetch(url, options) {
        // Start session if not already started
        if (!sessionId) {
            startSession();
        }

        // Capture SDP from request body
        if (options?.body) {
            let sdpOffer = null;
            let sessionConfig = null;

            if (options.body instanceof FormData) {
                sdpOffer = options.body.get('sdp');
                sessionConfig = options.body.get('session');
            } else if (typeof options.body === 'string' && options.body.startsWith('v=0')) {
                // Looks like SDP
                sdpOffer = options.body;
            }

            if (sdpOffer) {
                if (sessionData) {
                    sessionData.signaling.offer = sdpOffer;
                    sessionData.sessionConfig = sessionConfig;
                }

                onSignaling({
                    type: 'offer',
                    sdp: sdpOffer,
                    sessionConfig,
                    sessionId,
                    url,
                    timestamp: new Date().toISOString(),
                });
            }
        }

        return fetch(url, options).then(async (response) => {
            // Clone to read body
            const cloned = response.clone();
            const text = await cloned.text();
            
            // Check if response looks like SDP
            if (text.startsWith('v=0')) {
                if (sessionData) {
                    sessionData.signaling.answer = text;
                }

                onSignaling({
                    type: 'answer',
                    sdp: text,
                    sessionId,
                    url,
                    timestamp: new Date().toISOString(),
                });

                return new Response(text, {
                    status: response.status,
                    statusText: response.statusText,
                    headers: response.headers,
                });
            }
            
            return response;
        });
    }

    // Wrap RTCPeerConnection
    function wrapPeerConnection(pc) {
        if (!sessionId) {
            startSession();
        }

        // Intercept createDataChannel
        const originalCreateDataChannel = pc.createDataChannel.bind(pc);
        pc.createDataChannel = function(label, opts) {
            const dc = originalCreateDataChannel(label, opts);
            return wrapDataChannel(dc);
        };

        // Intercept ontrack - use defineProperty to catch when it's set later
        let userOnTrack = null;
        Object.defineProperty(pc, 'ontrack', {
            get: () => userOnTrack,
            set: (handler) => {
                userOnTrack = handler;
            },
            configurable: true
        });

        // Use addEventListener which won't be overwritten
        pc.addEventListener('track', (event) => {
            if (recordAudio && event.track.kind === 'audio' && event.streams[0]) {
                startOutputAudioRecording(event.streams[0]);
            }
            // Call user's handler if set
            if (userOnTrack) {
                userOnTrack.call(pc, event);
            }
        });

        // Intercept close
        const originalClose = pc.close.bind(pc);
        pc.close = function() {
            endSession();
            return originalClose();
        };

        return pc;
    }

    // Wrap data channel to intercept messages
    function wrapDataChannel(dc) {
        // Use addEventListener for incoming messages (won't be overwritten)
        dc.addEventListener('message', (event) => {
            try {
                const parsed = JSON.parse(event.data);
                recordEvent(parsed, 'incoming');
            } catch {
                recordEvent({ type: 'raw', data: event.data }, 'incoming');
            }
        });

        // Intercept outgoing messages
        const originalSend = dc.send.bind(dc);
        dc.send = function(data) {
            try {
                const parsed = JSON.parse(data);
                recordEvent(parsed, 'outgoing');
            } catch {
                recordEvent({ type: 'raw', data }, 'outgoing');
            }
            return originalSend(data);
        };

        return dc;
    }

    function startInputAudioRecording(stream) {
        if (!recordAudio) return;

        try {
            inputRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
            
            inputRecorder.ondataavailable = (event) => {
                if (event.data.size > 0 && sessionData) {
                    sessionData.audioChunks.input++;
                    
                    // Pass raw blob directly for local use
                    const audioData = {
                        direction: 'input',
                        blob: event.data,  // Raw Blob for local storage/playback
                        size: event.data.size,
                        timestamp: new Date().toISOString(),
                        sessionId,
                    };
                    
                    // Also convert to base64 for remote transmission
                    const reader = new FileReader();
                    reader.onload = () => {
                        audioData.data = reader.result.split(',')[1];
                        onAudio(audioData);
                    };
                    reader.readAsDataURL(event.data);
                }
            };
            
            inputRecorder.start(1000);
        } catch (err) {
            console.warn('[Observability] Failed to start input audio recording:', err);
        }
    }

    function startOutputAudioRecording(stream) {
        if (!recordAudio) return;

        try {
            outputRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=opus' });
            
            outputRecorder.ondataavailable = (event) => {
                if (event.data.size > 0 && sessionData) {
                    sessionData.audioChunks.output++;
                    
                    // Pass raw blob directly for local use
                    const audioData = {
                        direction: 'output',
                        blob: event.data,  // Raw Blob for local storage/playback
                        size: event.data.size,
                        timestamp: new Date().toISOString(),
                        sessionId,
                    };
                    
                    // Also convert to base64 for remote transmission
                    const reader = new FileReader();
                    reader.onload = () => {
                        audioData.data = reader.result.split(',')[1];
                        onAudio(audioData);
                    };
                    reader.readAsDataURL(event.data);
                }
            };
            
            outputRecorder.start(1000);
        } catch (err) {
            console.warn('[Observability] Failed to start output audio recording:', err);
        }
    }

    function getSession() {
        return sessionData ? { ...sessionData } : null;
    }

    return {
        fetch: observableFetch,
        wrapPeerConnection,
        startInputAudioRecording,
        startSession,
        endSession,
        getSession,
    };
}

export function createWebhookObserver(webhookUrl, options = {}) {
    const sendToWebhook = (type, data) => {
        fetch(webhookUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ type, ...data, timestamp: new Date().toISOString() }),
        }).catch(err => console.warn('[Observability] Webhook error:', err));
    };

    return createRealtimeObserver({
        ...options,
        onEvent: (event) => {
            sendToWebhook('event', { event });
            options.onEvent?.(event);
        },
        onAudio: (audio) => {
            if (options.sendAudioToWebhook !== false) {
                sendToWebhook('audio', { audio });
            }
            options.onAudio?.(audio);
        },
        onSessionStart: (session) => {
            sendToWebhook('session_start', { session });
            options.onSessionStart?.(session);
        },
        onSessionEnd: (session) => {
            sendToWebhook('session_end', { session });
            options.onSessionEnd?.(session);
        },
        onSignaling: (signaling) => {
            sendToWebhook('signaling', { signaling });
            options.onSignaling?.(signaling);
        },
    });
}
