// File: public/worklets/pcm-recorder.js
// VoxSOAP ML capture worklet (Phase 5): forwards raw mono Float32 frames to
// the main thread. The AudioContext is created at 16 kHz by voxsoap-ml.wav.ts;
// browsers that ignore forced rates are resampled offline CLIENT-side before
// upload — the ML service only ever receives 16 kHz mono PCM WAV.

class PcmRecorder extends AudioWorkletProcessor {
  process(inputs) {
    const input = inputs[0];
    const channel = input && input[0];
    if (channel && channel.length > 0) {
      // slice(0) detaches a plain copy; structured-clone transfers it safely.
      this.port.postMessage(channel.slice(0));
    }
    return true;
  }
}

registerProcessor('pcm-recorder', PcmRecorder);
