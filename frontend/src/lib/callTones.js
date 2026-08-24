// Small in-app progress tones. Synthesizing them avoids an extra media request,
// lets the browser stop them precisely, and keeps call alerts offline-friendly.

function audioContext() {
  const Context = window.AudioContext || window.webkitAudioContext;
  return Context ? new Context() : null;
}

function chirp(context, frequency, start, duration, gain = 0.045) {
  const oscillator = context.createOscillator();
  const volume = context.createGain();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  volume.gain.setValueAtTime(0.0001, start);
  volume.gain.exponentialRampToValueAtTime(gain, start + 0.012);
  volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(volume).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}

export function createCallTonePlayer() {
  let context = null;
  let timer = null;

  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };

  const start = (kind) => {
    stop();
    try {
      context ??= audioContext();
      if (!context) return;
      // An incoming call can arrive without a current click. Browsers that do not
      // permit this simply keep the accessible visual alert and system push alert.
      context.resume().catch(() => {});
      const pulse = () => {
        const now = context.currentTime + 0.02;
        if (kind === "incoming") {
          chirp(context, 820, now, 0.12);
          chirp(context, 660, now + 0.18, 0.12);
        } else {
          chirp(context, 480, now, 0.1, 0.035);
        }
      };
      pulse();
      timer = setInterval(pulse, kind === "incoming" ? 1_800 : 2_000);
    } catch {
      // Tone playback is an enhancement; a call must never fail because audio is blocked.
    }
  };

  const dispose = () => {
    stop();
    context?.close?.().catch(() => {});
    context = null;
  };

  return { start, stop, dispose };
}
