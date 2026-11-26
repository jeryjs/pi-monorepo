/**
 * Playback worklet: a 24 kHz -> device-rate resampler over a ring buffer, with
 * sample-accurate flush for barge-in and a smooth gain ramp to avoid clicks.
 *
 * Messages: { type: "pcm", data: Int16Array } | { type: "flush" } | { type: "gain", value }
 */

const SOURCE_RATE = 24000;
const CAPACITY_SECONDS = 20;

class PlaybackProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.size = SOURCE_RATE * CAPACITY_SECONDS;
        this.ring = new Float32Array(this.size);
        this.writeIndex = 0;
        this.readIndex = 0;
        this.count = 0;
        this.pos = 0;
        this.step = SOURCE_RATE / sampleRate;
        this.gain = 1;
        this.targetGain = 1;
        this.last = 0;
        this.idleFrames = 0;

        this.port.onmessage = (event) => {
            const message = event.data;

            if (!message) {
                return;
            }

            if (message.type === "pcm") {
                this.#push(message.data);
            } else if (message.type === "flush") {
                this.count = 0;
                this.pos = 0;
                this.last = 0;
                this.idleFrames = 0;
            } else if (message.type === "gain") {
                this.targetGain = message.value;
            }
        };
    }

    #push(int16) {
        if (!int16 || int16.length === 0) {
            return;
        }

        for (let i = 0; i < int16.length; i++) {
            this.ring[this.writeIndex] = int16[i] / 32768;
            this.writeIndex = (this.writeIndex + 1) % this.size;

            if (this.count < this.size) {
                this.count++;
            } else {
                this.readIndex = (this.readIndex + 1) % this.size;
            }
        }
    }

    #sampleAt(offset) {
        const index = (this.readIndex + offset) % this.size;
        return this.ring[index];
    }

    process(_inputs, outputs) {
        const out = outputs[0] && outputs[0][0];

        if (!out) {
            return true;
        }

        // Smooth gain toward the target to avoid zipper noise.
        this.gain += (this.targetGain - this.gain) * 0.02;

        const available = this.count;

        for (let i = 0; i < out.length; i++) {
            if (this.pos + 1 < available) {
                const base = Math.floor(this.pos);
                const fraction = this.pos - base;
                const a = this.#sampleAt(base);
                const b = this.#sampleAt(base + 1);
                const value = a + (b - a) * fraction;
                this.last = value;
                out[i] = value * this.gain;
                this.pos += this.step;
            } else {
                // Underrun: fade the last sample out instead of snapping to zero.
                this.last *= 0.985;
                out[i] = this.last * this.gain;
                this.idleFrames++;
            }
        }

        const advance = Math.floor(this.pos);

        if (advance > 0) {
            this.readIndex = (this.readIndex + advance) % this.size;
            this.count = Math.max(0, this.count - advance);
            this.pos -= advance;
        }

        if ((this.idleFrames & 31) === 0) {
            this.port.postMessage({ type: "buffer", ms: Math.round((this.count / SOURCE_RATE) * 1000) });
        }

        return true;
    }
}

registerProcessor("pi-playback", PlaybackProcessor);