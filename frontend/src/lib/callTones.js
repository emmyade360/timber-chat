// Small in-app tones. Synthesizing them avoids an extra media request, lets the
// browser stop them precisely, and keeps alerts offline-friendly.

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

let messageContext = null;

/**
 * A small, sharp ping for a message that arrived while Timber is open.
 *
 * An OS notification is deliberately suppressed when the person can see the
 * app, which left an open window silent: a message would land in a thread they
 * were not looking at with nothing to mark it. This is that mark.
 *
 * Deliberately not the call tone. A call is asking for you and repeats until
 * answered; a message is one short bell that should be over before you have
 * finished noticing it -- a near-instant attack, a bright partial for the
 * "tick" of the strike, and roughly a fifth of a second of decay.
 *
 * Quiet and fire-and-forget. Browsers that refuse audio without a recent
 * gesture simply do nothing, and the unread badge still carries the message.
 */
export function playMessageTone() {
  try {
    messageContext ??= audioContext();
    if (!messageContext) return;
    messageContext.resume().catch(() => {});
    const start = messageContext.currentTime + 0.01;
    ping(messageContext, 1_720, start, 0.19, 0.05);
    // A quiet partial an octave and a fifth up. This is what makes the strike
    // read as sharp rather than as a soft beep.
    ping(messageContext, 2_580, start, 0.07, 0.018);
  } catch {
    // A tone is an enhancement; a message must never fail because audio is blocked.
  }
}

/** One struck note: near-instant attack, exponential decay, no sustain. */
function ping(context, frequency, start, duration, gain) {
  const oscillator = context.createOscillator();
  const volume = context.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(frequency, start);
  // A touch of downward drift is what a small struck object actually does, and
  // it stops the note sounding synthetic.
  oscillator.frequency.exponentialRampToValueAtTime(frequency * 0.94, start + duration);
  volume.gain.setValueAtTime(0.0001, start);
  volume.gain.exponentialRampToValueAtTime(gain, start + 0.003);
  volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(volume).connect(context.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.02);
}
