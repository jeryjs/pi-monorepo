/**
 * Capture worklet: downsample the microphone to 16 kHz mono float32 and emit
 * fixed 20 ms frames. Downsampling with a box filter before decimation keeps
 * aliasing out of the band Gemini cares about.
 */

const TARGET_RATE = 16000;
const FRAME_SAMPLES = 320; // 20 ms at 16 kHz

class CaptureProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        this.step = sampleRate / TARGET_RATE; // input samples per output sample
        this.acc = 0;
        this.sum = 0;
        this.count = 0;
        this.frame = new Float32Array(FRAME_SAMPLES);
        this.fill = 0;
    }

    process(inputs) {
        const channel = inputs[0] && inputs[0][0];

        if (!channel) {
            return true;
        }

        for (let i = 0; i < channel.length; i++) {
            this.sum += channel[i];
            this.count += 1;
            this.acc += 1;

            if (this.acc >= this.step) {
                this.acc -= this.step;

                if (this.acc < 0 || this.acc >= this.step) {
                    this.acc = 0;
                }

                this.frame[this.fill++] = this.count > 0 ? this.sum / this.count : 0;
                this.sum = 0;
                this.count = 0;

                if (this.fill >= FRAME_SAMPLES) {
                    const chunk = this.frame.slice(0, this.fill);
                    this.port.postMessage(chunk, [chunk.buffer]);
                    this.fill = 0;
                }
            }
        }

        return true;
    }
}

registerProcessor("pi-capture", CaptureProcessor);