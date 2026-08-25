// WebRTC call controller. The Timber backend only relays short-lived SDP/ICE
// setup messages; media travels browser-to-browser (or via configured TURN) as
// DTLS/SRTP and is never stored by Timber.

import { useCallback, useEffect, useRef, useState } from "react";
import { getPendingCalls, getWebRtcIceServers, userMessage } from "../lib/api.js";
import { payloads } from "../crypto/envelope.js";
import { openCallSignal, sealCallSignal } from "../db/localStore.js";
import { sendEncryptedPayload } from "../lib/sync.js";
import { createCallTonePlayer } from "../lib/callTones.js";
import { useChatStore } from "../store/chatStore.js";
import { notifyIncomingCall } from "../lib/notifications.js";

const CONNECT_TIMEOUT_MS = 60_000;
const AUDIO_CONSTRAINTS = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: 1,
};
const VIDEO_CONSTRAINTS = {
  facingMode: "user",
  width: { ideal: 640, max: 640 },
  height: { ideal: 360, max: 360 },
  frameRate: { ideal: 15, max: 20 },
};

const idleCall = () => ({
  phase: "idle",
  conversationId: null,
  callId: null,
  mode: null,
  peerName: "",
  localStream: null,
  remoteStream: null,
  muted: false,
  cameraOff: false,
  notice: "",
});

function callError(error, fallback) {
  if (error?.name === "NotAllowedError") return "Camera or microphone permission was not granted.";
  if (error?.name === "NotFoundError") return "No suitable camera or microphone was found.";
  if (error?.name === "NotReadableError") return "Your camera or microphone is already in use.";
  if (error?.response) return userMessage(error, fallback);
  return fallback;
}

async function constrainedMedia(mode) {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("Calls need a modern browser with camera and microphone support.");
  }
  return navigator.mediaDevices.getUserMedia({
    audio: AUDIO_CONSTRAINTS,
    video: mode === "video" ? VIDEO_CONSTRAINTS : false,
  });
}

async function capSender(sender) {
  // Opus at 32 kbps is clear for a 1:1 voice call; video is deliberately capped
  // to 360p/15fps and 350 kbps. Browsers that reject sender tuning retain the
  // capture constraints above, which still avoid HD defaults.
  const parameters = sender.getParameters?.();
  if (!parameters?.encodings?.length) return;
  const video = sender.track?.kind === "video";
  parameters.encodings.forEach((encoding) => {
    encoding.maxBitrate = video ? 350_000 : 32_000;
    if (video) encoding.maxFramerate = 15;
  });
  try { await sender.setParameters(parameters); } catch { /* unsupported by this browser */ }
}

function candidateFromWire(candidate) {
  return {
    candidate: candidate.candidate,
    sdpMid: candidate.sdpMid ?? null,
    sdpMLineIndex: candidate.sdpMLineIndex ?? null,
    usernameFragment: candidate.usernameFragment ?? null,
  };
}

/**
 * Owns exactly one active/incoming call. `subscribe` is the authenticated
 * WebSocket event subscription returned by useWebSocket.
 */
export function useCall(send, subscribe) {
  const [call, setCall] = useState(idleCall);

  // The idle auto-lock cannot see call state, and backgrounding the app to
  // answer a call is exactly the thirty seconds it was waiting for. Publish
  // whether a call is live so it can stand down.
  useEffect(() => {
    useChatStore.getState().setCallActive(call.phase !== "idle");
  }, [call.phase]);
  const callRef = useRef(null);
  const orphanSignals = useRef(new Map());
  const tones = useRef(null);
  const startTone = useCallback((kind) => {
    tones.current ??= createCallTonePlayer();
    tones.current.start(kind);
  }, []);
  const stopTones = useCallback(() => tones.current?.stop(), []);

  const clearTimer = useCallback((context) => {
    if (context?.connectTimer) clearTimeout(context.connectTimer);
    if (context) context.connectTimer = null;
  }, []);

  const recordStatus = useCallback(async (context, status, durationMs = null) => {
    if (!context || context.incoming || !context.cardWritten) return;
    try {
      await sendEncryptedPayload(send, context.conversationId, payloads.callUpdate(context.callId, { status, durationMs }));
    } catch {
      // A status row is an enhancement; a failed relay must not keep media alive.
    }
  }, [send]);

  const stopContext = useCallback((context, notice = "") => {
    if (!context || callRef.current !== context) return;
    clearTimer(context);
    stopTones();
    context.pc?.close();
    context.localStream?.getTracks().forEach((track) => track.stop());
    callRef.current = null;
    setCall({ ...idleCall(), notice });
  }, [clearTimer, stopTones]);

  const sendEnd = useCallback((context, reason) => {
    if (!context) return false;
    return send("call.end", {
      conversation_id: context.conversationId,
      call_id: context.callId,
      reason,
    });
  }, [send]);

  const callStatusForEnd = (reason, active) => {
    if (active || reason === "hangup") return "completed";
    return ({ declined: "declined", busy: "unavailable", unavailable: "unavailable", no_answer: "no_answer", failed: "failed" })[reason] ?? "failed";
  };

  const finish = useCallback((context, reason, notice = "") => {
    if (!context) return;
    sendEnd(context, reason);
    const active = context.activeStartedAt != null;
    void recordStatus(context, callStatusForEnd(reason, active), active ? Date.now() - context.activeStartedAt : null);
    stopContext(context, notice);
  }, [recordStatus, sendEnd, stopContext]);

  const scheduleConnectTimeout = useCallback((context) => {
    clearTimer(context);
    context.connectTimer = setTimeout(() => {
      if (callRef.current !== context || context.pc?.connectionState === "connected") return;
      finish(context, "no_answer", "Your friend did not answer the call.");
    }, CONNECT_TIMEOUT_MS);
  }, [clearTimer, finish]);

  const sendSealedSignal = useCallback(async (type, context, payload = {}) => {
    const envelope = await sealCallSignal(context.conversationId, {
      v: 1,
      t: type,
      call_id: context.callId,
      ...payload,
    });
    if (!send(`call.${type}`, {
      conversation_id: context.conversationId,
      call_id: context.callId,
      ...(type === "offer" ? { media: context.mode } : {}),
      ...envelope,
    })) {
      throw new Error("You are offline. Reconnect before starting a call.");
    }
  }, [send]);

  const flushCandidates = useCallback(async (context) => {
    const pending = context.pendingCandidates.splice(0);
    for (const candidate of pending) {
      try { await context.pc.addIceCandidate(candidateFromWire(candidate)); } catch { /* bad/stale candidate */ }
    }
  }, []);

  const makeConnection = useCallback((context, iceServers) => {
    const pc = new RTCPeerConnection({
      iceServers,
      bundlePolicy: "max-bundle",
      rtcpMuxPolicy: "require",
      iceCandidatePoolSize: 0,
    });
    pc.onicecandidate = ({ candidate }) => {
      if (!candidate || callRef.current !== context) return;
      if (!context.incoming && !context.offerSent) {
        context.localCandidates.push(candidate.toJSON());
        return;
      }
      void sendSealedSignal("ice-candidate", context, { candidate: candidate.toJSON() }).catch(() => {});
    };
    pc.ontrack = ({ streams, track }) => {
      if (callRef.current !== context) return;
      const remote = streams[0] ?? context.remoteStream ?? new MediaStream();
      if (!streams[0] && !remote.getTracks().some((existing) => existing.id === track.id)) remote.addTrack(track);
      context.remoteStream = remote;
      setCall((current) => current.callId === context.callId ? { ...current, remoteStream: remote } : current);
    };
    pc.onconnectionstatechange = () => {
      if (callRef.current !== context) return;
      if (pc.connectionState === "connected") {
        clearTimer(context);
        context.activeStartedAt ??= Date.now();
        stopTones();
        setCall((current) => current.callId === context.callId ? { ...current, phase: "active" } : current);
        void recordStatus(context, "active");
      } else if (pc.connectionState === "failed") {
        finish(context, "failed", "The call ended because the connection failed.");
      }
    };
    context.pc = pc;
    return pc;
  }, [clearTimer, finish, recordStatus, sendSealedSignal, stopTones]);

  const addLocalTracks = useCallback(async (context, stream) => {
    context.localStream = stream;
    const senders = stream.getTracks().map((track) => context.pc.addTrack(track, stream));
    await Promise.all(senders.map(capSender));
    setCall((current) => current.callId === context.callId
      ? { ...current, localStream: stream }
      : current);
  }, []);

  const startCall = useCallback(async ({ conversationId, mode, peerName }) => {
    if (callRef.current) throw new Error("Finish the current call before starting another one.");
    if (!send) throw new Error("Realtime connection is unavailable.");
    const callId = crypto.randomUUID();
    const context = {
      callId,
      conversationId,
      mode,
      peerName,
      incoming: false,
      pc: null,
      localStream: null,
      remoteStream: null,
      pendingCandidates: [],
      localCandidates: [],
      connectTimer: null,
      cardWritten: false,
      offerSent: false,
      activeStartedAt: null,
    };
    callRef.current = context;
    setCall({ ...idleCall(), phase: "preparing", callId, conversationId, mode, peerName });
    try {
      const { data } = await getWebRtcIceServers();
      const stream = await constrainedMedia(mode);
      if (callRef.current !== context) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      // Register it before any subsequent operation so an error always releases
      // the camera/microphone rather than leaving an invisible capture running.
      context.localStream = stream;
      const pc = makeConnection(context, data.ice_servers ?? []);
      await addLocalTracks(context, stream);
      const offer = await pc.createOffer();
      await pc.setLocalDescription(offer);
      await sendEncryptedPayload(send, conversationId, payloads.call({ callId, mode }));
      context.cardWritten = true;
      await sendSealedSignal("offer", context, { sdp: pc.localDescription.sdp });
      context.offerSent = true;
      for (const candidate of context.localCandidates.splice(0)) {
        void sendSealedSignal("ice-candidate", context, { candidate }).catch(() => {});
      }
      setCall((current) => current.callId === callId ? { ...current, phase: "calling" } : current);
      scheduleConnectTimeout(context);
    } catch (error) {
      await recordStatus(context, "failed");
      stopContext(context);
      throw new Error(callError(error, "Could not start the call."));
    }
  }, [addLocalTracks, makeConnection, recordStatus, scheduleConnectTimeout, send, sendSealedSignal, stopContext]);

  const acceptCall = useCallback(async () => {
    const context = callRef.current;
    if (!context?.incoming || context.pc) return;
    setCall((current) => current.callId === context.callId ? { ...current, phase: "preparing", notice: "" } : current);
    stopTones();
    try {
      const { data } = await getWebRtcIceServers();
      const stream = await constrainedMedia(context.mode);
      if (callRef.current !== context) {
        stream.getTracks().forEach((track) => track.stop());
        return;
      }
      context.localStream = stream;
      const pc = makeConnection(context, data.ice_servers ?? []);
      await pc.setRemoteDescription({ type: "offer", sdp: context.offer.sdp });
      await addLocalTracks(context, stream);
      await flushCandidates(context);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      await sendSealedSignal("answer", context, { sdp: pc.localDescription.sdp });
      setCall((current) => current.callId === context.callId ? { ...current, phase: "connecting" } : current);
      scheduleConnectTimeout(context);
    } catch (error) {
      finish(context, "unavailable", callError(error, "Could not answer the call."));
    }
  }, [addLocalTracks, finish, flushCandidates, makeConnection, scheduleConnectTimeout, sendSealedSignal, stopTones]);

  const endCall = useCallback((reason = "hangup") => finish(callRef.current, reason), [finish]);

  const toggleMuted = useCallback(() => {
    const context = callRef.current;
    if (!context?.localStream) return;
    const next = !call.muted;
    context.localStream.getAudioTracks().forEach((track) => { track.enabled = !next; });
    setCall((current) => ({ ...current, muted: next }));
  }, [call.muted]);

  const toggleCamera = useCallback(() => {
    const context = callRef.current;
    if (!context?.localStream?.getVideoTracks().length) return;
    const next = !call.cameraOff;
    context.localStream.getVideoTracks().forEach((track) => { track.enabled = !next; });
    setCall((current) => ({ ...current, cameraOff: next }));
  }, [call.cameraOff]);

  useEffect(() => subscribe((type, payload) => {
    if (!payload?.conversation_id || !payload?.call_id) return;
    const context = callRef.current;
    if (type === "call.offer") {
      if (context) {
        if (context.callId !== payload.call_id) {
          send("call.end", {
            conversation_id: payload.conversation_id,
            call_id: payload.call_id,
            reason: "busy",
          });
        }
        return;
      }
      void (async () => {
        try {
          const offer = await openCallSignal(payload.conversation_id, payload.from, payload);
          if (offer.t !== "offer" || offer.call_id !== payload.call_id || callRef.current) return;
          const incoming = {
            callId: payload.call_id,
            conversationId: payload.conversation_id,
            mode: payload.media === "video" ? "video" : "audio",
            peerName: payload.username || "A friend",
            incoming: true,
            offer,
            pc: null,
            localStream: null,
            remoteStream: null,
            pendingCandidates: [],
            localCandidates: [],
            connectTimer: null,
            cardWritten: false,
            activeStartedAt: null,
          };
          callRef.current = incoming;
          const earlyCandidates = orphanSignals.current.get(incoming.callId) ?? [];
          orphanSignals.current.delete(incoming.callId);
          for (const candidate of earlyCandidates) {
            try {
              const signal = await openCallSignal(incoming.conversationId, candidate.from, candidate);
              if (signal.t === "ice-candidate" && signal.call_id === incoming.callId && signal.candidate) incoming.pendingCandidates.push(signal.candidate);
            } catch { /* a stale encrypted candidate is harmless */ }
          }
          setCall({ ...idleCall(), phase: "incoming", callId: incoming.callId, conversationId: incoming.conversationId, mode: incoming.mode, peerName: incoming.peerName });
          startTone("incoming");
          // Only reaches the OS when Timber is not the visible tab; when it is,
          // the call overlay is already covering the screen.
          void notifyIncomingCall({ username: incoming.peerName, mode: incoming.mode });
          send("call.ringing", { conversation_id: incoming.conversationId, call_id: incoming.callId });
        } catch {
          send("call.end", { conversation_id: payload.conversation_id, call_id: payload.call_id, reason: "failed" });
        }
      })();
      return;
    }
    if (!context && type === "call.ice-candidate") {
      const queued = orphanSignals.current.get(payload.call_id) ?? [];
      if (queued.length < 64) orphanSignals.current.set(payload.call_id, [...queued, payload]);
      return;
    }
    if (!context || context.callId !== payload.call_id || context.conversationId !== payload.conversation_id) return;
    if (type === "call.ringing" && !context.incoming) {
      startTone("ringback");
      setCall((current) => current.callId === context.callId ? { ...current, phase: "ringing" } : current);
      void recordStatus(context, "ringing");
    } else if (type === "call.answer" && !context.incoming && context.pc) {
      void (async () => {
        try {
          const answer = await openCallSignal(context.conversationId, payload.from, payload);
          if (answer.t !== "answer" || answer.call_id !== context.callId) throw new Error("Invalid call answer");
          stopTones();
          await context.pc.setRemoteDescription({ type: "answer", sdp: answer.sdp });
          await flushCandidates(context);
          setCall((current) => current.callId === context.callId ? { ...current, phase: "connecting" } : current);
        } catch {
          finish(context, "failed", "The call could not be connected securely.");
        }
      })();
    } else if (type === "call.ice-candidate" && context.pc) {
      void (async () => {
        try {
          const signal = await openCallSignal(context.conversationId, payload.from, payload);
          if (signal.t !== "ice-candidate" || signal.call_id !== context.callId || !signal.candidate) return;
          if (context.pc.remoteDescription) await context.pc.addIceCandidate(candidateFromWire(signal.candidate));
          else context.pendingCandidates.push(signal.candidate);
        } catch { /* invalid encrypted candidates are ignored */ }
      })();
    } else if (type === "call.end") {
      const messages = {
        busy: "Your friend is already on another call.",
        declined: "Your friend declined the call.",
        unavailable: "Your friend is unavailable for a call right now.",
        no_answer: "Your friend did not answer the call.",
        failed: "The call ended because the connection failed.",
        hangup: "The call ended.",
      };
      if (!context.incoming) {
        const active = context.activeStartedAt != null;
        void recordStatus(context, callStatusForEnd(payload.reason, active), active ? Date.now() - context.activeStartedAt : null);
      }
      stopContext(context, messages[payload.reason] ?? "The call ended.");
    }
  }), [finish, flushCandidates, recordStatus, send, startTone, stopContext, stopTones, subscribe]);

  useEffect(() => () => {
    const context = callRef.current;
    if (context) stopContext(context);
    orphanSignals.current.clear();
    tones.current?.dispose();
  }, [stopContext]);

  const dismissNotice = useCallback(() => {
    setCall((current) => current.phase === "idle" ? { ...current, notice: "" } : current);
  }, []);

  /** Recover the offer stored for an installed PWA that was closed at call time. */
  const resumePendingCalls = useCallback(async () => {
    if (callRef.current) return;
    const { data } = await getPendingCalls();
    const pending = data?.find((entry) => entry.signals?.some((signal) => signal.kind === "offer"));
    if (!pending || callRef.current) return;
    const wireOffer = pending.signals.find((signal) => signal.kind === "offer");
    const offer = await openCallSignal(pending.conversation_id, wireOffer.from, wireOffer);
    if (offer.t !== "offer" || offer.call_id !== pending.call_id || callRef.current) return;
    const incoming = {
      callId: pending.call_id,
      conversationId: pending.conversation_id,
      mode: pending.media === "video" ? "video" : "audio",
      peerName: pending.username || "A friend",
      incoming: true,
      offer,
      pc: null,
      localStream: null,
      remoteStream: null,
      pendingCandidates: [],
      localCandidates: [],
      connectTimer: null,
      cardWritten: false,
      activeStartedAt: null,
    };
    // Replay any candidates gathered before the PWA was opened.
    for (const signal of pending.signals.filter((entry) => entry.kind === "ice-candidate")) {
      try {
        const opened = await openCallSignal(incoming.conversationId, signal.from, signal);
        if (opened.t === "ice-candidate" && opened.candidate) incoming.pendingCandidates.push(opened.candidate);
      } catch { /* a malformed stale candidate does not invalidate the offer */ }
    }
    callRef.current = incoming;
    setCall({ ...idleCall(), phase: "incoming", callId: incoming.callId, conversationId: incoming.conversationId, mode: incoming.mode, peerName: incoming.peerName });
    startTone("incoming");
    void notifyIncomingCall({ username: incoming.peerName, mode: incoming.mode });
    send("call.ringing", { conversation_id: incoming.conversationId, call_id: incoming.callId });
  }, [send, startTone]);

  return {
    call,
    startCall,
    acceptCall,
    endCall,
    toggleMuted,
    toggleCamera,
    dismissNotice,
    resumePendingCalls,
  };
}
