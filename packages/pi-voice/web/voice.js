/**
 * Pi Voice — browser companion.
 *
 * The page owns only media: microphone capture (with the browser's own acoustic
 * echo cancellation), PCM framing, wake-word spotting, and playback. The Pi
 * process owns the Gemini session, the API key, tools and all state.
 *
 * Local wire format (binary = PCM int16 little-endian):
 *   page -> Pi : 16 kHz mic frames
 *   Pi -> page : 24 kHz model audio
 * Text frames are JSON control messages.
 */

import { createWakeEngine, detectComputeBackends, pickCompute } from "./wake.js";

const TOKEN = new URLSearchParams(location.search).get("t") ?? "";
const el = (id) => document.getElementById(id);

const ui = {
    dot: el("dot"),
    sub: el("sub"),
    log: el("log"),
    notice: el("notice"),
    approval: el("approval"),
    approvalText: el("approvalText"),
    allow: el("allow"),
    deny: el("deny"),
    talk: el("talk"),
    mute: el("mute"),
    interrupt: el("interrupt"),
    alwaysOn: el("alwaysOn"),
    wakeState: el("wakeState"),
    level: el("level"),
    stats: el("stats"),
    typeForm: el("typeForm"),
    typeInput: el("typeInput"),
    end: el("end"),
};

const state = {
    config: {},
    ws: null,
    ctx: null,
    captureNode: null,
    playbackNode: null,
    micStream: null,
    sourceNode: null,
    wakeEngine: null,
    micOn: false,
    muted: false,
    alwaysOn: false,
    awake: false,
    ending: false,
    reconnectTimer: null,
    reconnectAttempts: 0,
    lastVoiceAt: 0,
    lines: { user: null, model: null },
    bufferMs: 0,
    tokens: 0,
    startedAt: 0,
};

// A ~600 ms ring of 16 kHz samples so the wake phrase is not clipped.
class FloatRing {
    constructor(capacity) {
        this.data = new Float32Array(capacity);
        this.capacity = capacity;
        this.write = 0;
        this.length = 0;
    }

    push(samples) {
        for (let i = 0; i < samples.length; i++) {
            this.data[this.write] = samples[i];
            this.write = (this.write + 1) % this.capacity;
            if (this.length < this.capacity) {
                this.length++;
            }
        }
    }

    tail(count) {
        const take = Math.min(count, this.length);
        const out = new Float32Array(take);
        const start = (this.write - take + this.capacity) % this.capacity;
        for (let i = 0; i < take; i++) {
            out[i] = this.data[(start + i) % this.capacity];
        }
        return out;
    }

    clear() {
        this.write = 0;
        this.length = 0;
    }
}

const preRoll = new FloatRing(16000 * 0.6);

function send(message) {
    if (state.ws && state.ws.readyState === 1) {
        state.ws.send(JSON.stringify(message));
    }
}

function setDot(kind, text) {
    ui.dot.className = "dot" + (kind ? " " + kind : "");
    ui.sub.textContent = text;
}

function setChip(text) {
    ui.wakeState.textContent = text;
}

function notice(text, ms = 6000) {
    ui.notice.textContent = text;
    ui.notice.classList.remove("hidden");
    clearTimeout(notice.timer);

    if (ms > 0) {
        notice.timer = setTimeout(() => ui.notice.classList.add("hidden"), ms);
    }
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

function connect() {
    if (!TOKEN) {
        setDot("error", "missing access token — open the URL Pi printed");
        return;
    }

    const scheme = location.protocol === "https:" ? "wss" : "ws";
    const socket = new WebSocket(`${scheme}://${location.host}/ws?t=${encodeURIComponent(TOKEN)}`);
    socket.binaryType = "arraybuffer";
    state.ws = socket;

    socket.onopen = () => {
        state.reconnectAttempts = 0;
        setDot("live", "connected");
        send({ t: "hello", ua: navigator.userAgent, compute: pickCompute(state.config.compute) });
    };

    socket.onclose = (event) => {
        state.ws = null;

        if (state.ending) {
            setDot("", "closed");
            return;
        }

        state.reconnectAttempts += 1;

        // An old tab carries a token from a previous Pi process. Retrying cannot
        // fix that, so say so instead of spamming "reconnecting" forever.
        if (state.reconnectAttempts > 6) {
            setDot("error", `disconnected (${event.code}) — reopen the URL Pi printed`);
            return;
        }

        const delay = Math.min(8000, 500 * 1.7 ** (state.reconnectAttempts - 1));
        setDot("error", `reconnecting (${event.code})…`);
        clearTimeout(state.reconnectTimer);
        state.reconnectTimer = setTimeout(connect, delay);
    };

    socket.onerror = () => setDot("error", "socket error");

    socket.onmessage = (event) => {
        if (typeof event.data === "string") {
            try {
                onControl(JSON.parse(event.data));
            } catch {
                // ignore bad control frames
            }
            return;
        }

        playPcm(event.data);
    };
}

function onControl(message) {
    switch (message.t) {
        case "state": {
            const kind = message.state === "live"
                ? "live"
                : message.state === "sleeping"
                    ? "sleeping"
                    : message.state === "error" || message.state === "closed"
                        ? "error"
                        : "";

            setDot(kind, message.detail ?? message.state);

            if (message.state === "sleeping") {
                state.awake = false;
                setChip("wake: asleep");
            }
            break;
        }

        case "transcript":
            appendTranscript(message.side, message.text, message.final);
            break;

        case "interrupt":
            flushPlayback();
            break;

        case "sleep":
            state.awake = false;
            setChip("wake: asleep");
            flushPlayback();
            break;

        case "wake":
            state.awake = true;
            setChip("wake: awake");
            break;

        case "notice":
            notice(message.text);
            break;

        case "approval":
            showApproval(message);
            break;

        case "approval-done":
            ui.approval.classList.add("hidden");
            break;

        case "stats":
            state.tokens = message.tokens ?? state.tokens;
            renderStats();
            break;

        case "hello":
            state.reconnectAttempts = 0;
            if (typeof message.alwaysOn === "boolean") {
                state.alwaysOn = message.alwaysOn;
                ui.alwaysOn.checked = message.alwaysOn;
            }
            if (message.model) {
                setDot("live", `${message.model} · ${message.voice ?? ""}`.trim());
            }
            break;

        case "config":
            state.config = { ...state.config, ...message };
            applyConfig();
            break;

        default:
            break;
    }
}

// ---------------------------------------------------------------------------
// Audio
// ---------------------------------------------------------------------------

async function ensureAudio() {
    if (state.ctx) {
        if (state.ctx.state === "suspended") {
            await state.ctx.resume();
        }
        return;
    }

    const ctx = new AudioContext({ latencyHint: "interactive" });
    state.ctx = ctx;

    await ctx.audioWorklet.addModule("worklet-capture.js");
    await ctx.audioWorklet.addModule("worklet-playback.js");

    const playback = new AudioWorkletNode(ctx, "pi-playback", {
        numberOfInputs: 0,
        numberOfOutputs: 1,
        outputChannelCount: [1],
    });
    playback.connect(ctx.destination);
    playback.port.onmessage = (event) => {
        if (event.data?.type === "buffer") {
            state.bufferMs = event.data.ms;
            renderStats();
        }
    };
    state.playbackNode = playback;

    const capture = new AudioWorkletNode(ctx, "pi-capture", {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        channelCount: 1,
        channelCountMode: "explicit",
    });

    // Keep the capture node pulled by the graph without making sound.
    const silent = ctx.createGain();
    silent.gain.value = 0;
    capture.connect(silent).connect(ctx.destination);
    capture.port.onmessage = (event) => onMicFrame(event.data);
    state.captureNode = capture;

    await ensureMic();
}

async function ensureMic() {
    if (state.micStream) {
        return;
    }

    const constraints = {
        audio: {
            channelCount: 1,
            echoCancellation: state.config.aec !== false,
            noiseSuppression: state.config.noiseSuppression !== false,
            autoGainControl: state.config.autoGain !== false,
            ...(state.config.micDeviceId ? { deviceId: { exact: state.config.micDeviceId } } : {}),
        },
    };

    state.micStream = await navigator.mediaDevices.getUserMedia(constraints);
    state.sourceNode = state.ctx.createMediaStreamSource(state.micStream);
    state.sourceNode.connect(state.captureNode);
}

function onMicFrame(frame) {
    if (!frame || frame.length === 0) {
        return;
    }

    let sum = 0;
    for (let i = 0; i < frame.length; i++) {
        sum += frame[i] * frame[i];
    }
    const rms = Math.sqrt(sum / frame.length);

    ui.level.style.width = Math.min(100, Math.round(rms * 900)) + "%";

    // Feed the TUI status-bar waveform even while asleep or muted, so it is
    // obvious whether Pi can hear anything at all.
    state.levelTick = (state.levelTick ?? 0) + 1;

    if (state.levelTick % 3 === 0) {
        send({ t: "level", value: rms });
    }

    if (rms > 0.02) {
        state.lastVoiceAt = Date.now();
    }

    if (state.wakeEngine && state.wakeEngine.supportsFeed) {
        state.wakeEngine.feed(frame);
    }

    // Always-on with no explicit start still needs a pre-roll while asleep.
    if (state.alwaysOn && !state.awake) {
        preRoll.push(frame);
        return;
    }

    const sending = state.micOn || state.alwaysOn;

    if (!sending || state.muted) {
        return;
    }

    sendPcm(frame);
}

function sendPcm(float32) {
    if (!state.ws || state.ws.readyState !== 1) {
        return;
    }

    const out = new Int16Array(float32.length);
    for (let i = 0; i < float32.length; i++) {
        const value = Math.max(-1, Math.min(1, float32[i]));
        out[i] = value < 0 ? value * 0x8000 : value * 0x7fff;
    }

    state.ws.send(out.buffer);
}

function playPcm(arrayBuffer) {
    if (!state.playbackNode) {
        return;
    }

    const int16 = new Int16Array(arrayBuffer);
    state.playbackNode.port.postMessage({ type: "pcm", data: int16 }, [int16.buffer]);
}

function flushPlayback() {
    state.playbackNode?.port.postMessage({ type: "flush" });
}

// ---------------------------------------------------------------------------
// Wake word
// ---------------------------------------------------------------------------

async function startWakeEngine() {
    if (!state.alwaysOn || state.wakeEngine) {
        return;
    }

    // Capture must exist for feed-based engines (and for streaming after wake).
    try {
        await ensureAudio();
    } catch (error) {
        notice(`Microphone unavailable: ${error}`);
        return;
    }

    const engine = await createWakeEngine({
        engine: state.config.wakeEngine ?? "auto",
        phrases: state.config.wakePhrases ?? ["hey pi"],
        sensitivity: state.config.wakeSensitivity ?? 0.5,
        compute: state.config.compute ?? "auto",
        moduleUrl: state.config.wakeModelUrl || "",
        language: state.config.language || "",
        onWake: (source) => onWake(source),
        onState: (kind, detail) => {
            if (kind === "fallback") {
                notice(`Wake engine: ${detail}`);
            } else if (kind === "ready") {
                setChip(`wake: ${detail}`);
            }
        },
    });

    state.wakeEngine = engine;
    engine.start();
}

function stopWakeEngine() {
    try {
        state.wakeEngine?.stop();
    } catch {
        // ignore
    }
    state.wakeEngine = null;
    state.awake = false;
    preRoll.clear();
    setChip("wake: off");
}

function onWake(source) {
    if (!state.alwaysOn) {
        return;
    }

    if (state.awake) {
        return;
    }

    state.awake = true;
    setChip("wake: awake");

    // Replay the phrase (and a little before it) so the model hears the request.
    const pre = preRoll.tail(16000 * 0.5);
    preRoll.clear();

    if (pre.length > 0) {
        sendPcm(pre);
    }

    send({ t: "wake", source });
    notice("Listening…", 2500);
}

// ---------------------------------------------------------------------------
// Transcript / UI
// ---------------------------------------------------------------------------

function appendTranscript(side, text, final) {
    const key = side === "user" ? "user" : "model";

    if (final && !text) {
        state.lines[key]?.classList.remove("interim");
        state.lines[key] = null;
        return;
    }

    let line = state.lines[key];

    if (!line) {
        line = document.createElement("div");
        line.className = `line ${key} interim`;

        const who = document.createElement("div");
        who.className = "who";
        who.textContent = key === "user" ? "you" : "pi";

        const said = document.createElement("div");
        said.className = "said";

        line.append(who, said);
        ui.log.append(line);
        state.lines[key] = line;
    }

    const said = line.querySelector(".said");
    said.textContent = (said.textContent ?? "") + text;

    if (final) {
        line.classList.remove("interim");
        state.lines[key] = null;
    }

    ui.log.scrollTop = ui.log.scrollHeight;
}

function renderStats() {
    const parts = [
        `buffer ${state.bufferMs}ms`,
        `tokens ${state.tokens}`,
        `compute ${pickCompute(state.config.compute)}`,
        `backends ${Object.entries(detectComputeBackends()).filter(([, v]) => v).map(([k]) => k).join("/")}`,
    ];

    ui.stats.textContent = parts.join(" · ");
}

function showApproval(message) {
    ui.approvalText.textContent = `Pi wants to run ${message.tool}: ${message.summary}`;
    ui.approval.classList.remove("hidden");
    ui.approval.dataset.id = message.id;
}

function answerApproval(allow) {
    const id = ui.approval.dataset.id;
    ui.approval.classList.add("hidden");

    if (id) {
        send({ t: "approval", id, allow });
    }
}

function applyConfig() {
    ui.alwaysOn.checked = Boolean(state.config.alwaysOn);
    state.alwaysOn = Boolean(state.config.alwaysOn);

    if (!state.alwaysOn) {
        stopWakeEngine();
    }
}

// ---------------------------------------------------------------------------
// Controls
// ---------------------------------------------------------------------------

async function toggleTalk() {
    try {
        await ensureAudio();
    } catch (error) {
        notice(`Microphone unavailable: ${error}`);
        return;
    }

    state.micOn = !state.micOn;

    if (state.micOn) {
        ui.notice.classList.add("hidden");
    }

    if (state.micOn && state.alwaysOn && !state.awake) {
        // In always-on mode the button means "listen now".
        onWake("button");
    } else if (!state.micOn && state.alwaysOn) {
        state.awake = false;
        send({ t: "sleep" });
    }

    ui.talk.textContent = state.micOn ? "Stop listening" : "Start listening";
    ui.talk.classList.toggle("on", state.micOn);

    send({ t: "mic", on: state.micOn });

    if (state.alwaysOn) {
        await startWakeEngine();
    }
}

async function toggleAlwaysOn(value) {
    state.alwaysOn = value;
    ui.alwaysOn.checked = value;
    send({ t: "alwaysOn", value });

    if (value) {
        await startWakeEngine();
        notice("Always-on listening. Say the wake phrase.", 4000);
    } else {
        stopWakeEngine();
        state.awake = false;
        send({ t: "sleep" });
    }
}

function bind() {
    ui.talk.addEventListener("click", () => void toggleTalk());
    ui.alwaysOn.addEventListener("change", () => void toggleAlwaysOn(ui.alwaysOn.checked));

    ui.mute.addEventListener("click", () => {
        state.muted = !state.muted;
        ui.mute.textContent = state.muted ? "Unmute" : "Mute";
        ui.mute.classList.toggle("danger", state.muted);
    });

    ui.interrupt.addEventListener("click", () => {
        flushPlayback();
        send({ t: "interrupt" });
    });

    ui.allow.addEventListener("click", () => answerApproval(true));
    ui.deny.addEventListener("click", () => answerApproval(false));

    ui.typeForm.addEventListener("submit", (event) => {
        event.preventDefault();
        const value = ui.typeInput.value.trim();

        if (value) {
            send({ t: "text", value });
            ui.typeInput.value = "";
        }
    });

    ui.end.addEventListener("click", () => {
        state.ending = true;
        send({ t: "end" });
        try {
            state.ws?.close();
        } catch {
            // ignore
        }
        setDot("", "closed");
        ui.talk.disabled = true;
    });

    window.addEventListener("beforeunload", () => {
        try {
            state.ws?.close();
        } catch {
            // ignore
        }
    });
}

async function main() {
    bind();
    renderStats();

    try {
        const response = await fetch(`/client-config?t=${encodeURIComponent(TOKEN)}`);
        state.config = await response.json();
    } catch {
        state.config = {};
    }

    applyConfig();
    connect();

    if (state.config.alwaysOn) {
        notice("Click anywhere to allow the microphone for always-on listening.", 0);

        // Browsers need a gesture before audio work can start; use the first one.
        const kick = () => {
            window.removeEventListener("pointerdown", kick);
            ui.notice.classList.add("hidden");
            void startWakeEngine();
        };

        window.addEventListener("pointerdown", kick, { once: true });
    } else {
        notice("Press Start listening, or enable Always-on wake word.", 0);
    }
}

void main();