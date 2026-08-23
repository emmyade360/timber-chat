// WebRTC call controller. The Timber backend only relays short-lived SDP/ICE
// setup messages; media travels browser-to-browser (or via configured TURN) as
// DTLS/SRTP and is never stored by Timber.

import { useCallback, useEffect, useRef, useState } from "react";
import { getWebRtcIceServers, userMessage } from "../lib/api.js";

const CONNECT_TIMEOUT_MS = 45_000;
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
    throw new Error("WebRTC calls need a modern browser with camera and microphone support.");
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
  const callRef = useRef(null);

  const clearTimer = useCallback((context) => {
    if (context?.connectTimer) clearTimeout(context.connectTimer);
    if (context) context.connectTimer = null;
  }, []);

  const stopContext = useCallback((context, notice = "") => {
    if (!context || callRef.current !== context) return;
    clearTimer(context);
    context.pc?.close();
    context.localStream?.getTracks().forEach((track) => track.stop());
    callRef.current = null;
    setCall({ ...idleCall(), notice });
  }, [clearTimer]);

  const sendEnd = useCallback((context, reason) => {
    if (!context) return false;
    return send("call.end", {
      conversation_id: context.conversationId,
      call_id: context.callId,
      reason,
    });
  }, [send]);

  const scheduleConnectTimeout = useCallback((context) => {
    clearTimer(context);
    context.connectTimer = setTimeout(() => {
      if (callRef.current !== context || context.pc?.connectionState === "connected") return;
      sendEnd(context, "unavailable");
      stopContext(context, "The call could not connect. Try again when both of you have a stronger connection.");
    }, CONNECT_TIMEOUT_MS);
  }, [clearTimer, sendEnd, stopContext]);

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
      send("call.ice-candidate", {
        conversation_id: context.conversationId,
        call_id: context.callId,
        candidate: candidate.toJSON(),
      });
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
        setCall((current) => current.callId === context.callId ? { ...current, phase: "active" } : current);
      } else if (pc.connectionState === "failed") {
        sendEnd(context, "failed");
        stopContext(context, "The call ended because the connection failed.");
      }
    };
    context.pc = pc;
    return pc;
  }, [clearTimer, send, sendEnd, stopContext]);

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
      connectTimer: null,
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
      if (!send("call.offer", {
        conversation_id: conversationId,
        call_id: callId,
        media: mode,
        sdp: pc.localDescription.sdp,
      })) {
        throw new Error("You are offline. Reconnect before starting a call.");
      }
      setCall((current) => current.callId === callId ? { ...current, phase: "calling" } : current);
      scheduleConnectTimeout(context);
    } catch (error) {
      stopContext(context);
      throw new Error(callError(error, "Could not start the call."));
    }
  }, [addLocalTracks, makeConnection, scheduleConnectTimeout, send, stopContext]);

  const acceptCall = useCallback(async () => {
    const context = callRef.current;
    if (!context?.incoming || context.pc) return;
    setCall((current) => current.callId === context.callId ? { ...current, phase: "preparing", notice: "" } : current);
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
      if (!send("call.answer", {
        conversation_id: context.conversationId,
        call_id: context.callId,
        sdp: pc.localDescription.sdp,
      })) {
        throw new Error("You are offline. Reconnect before answering the call.");
      }
      setCall((current) => current.callId === context.callId ? { ...current, phase: "connecting" } : current);
      scheduleConnectTimeout(context);
    } catch (error) {
      sendEnd(context, "unavailable");
      stopContext(context, callError(error, "Could not answer the call."));
    }
  }, [addLocalTracks, flushCandidates, makeConnection, scheduleConnectTimeout, send, sendEnd, stopContext]);

  const endCall = useCallback((reason = "hangup") => {
    const context = callRef.current;
    if (!context) return;
    sendEnd(context, reason);
    stopContext(context);
  }, [sendEnd, stopContext]);

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
      const incoming = {
        callId: payload.call_id,
        conversationId: payload.conversation_id,
        mode: payload.media === "video" ? "video" : "audio",
        peerName: payload.username || "A friend",
        incoming: true,
        offer: payload,
        pc: null,
        localStream: null,
        remoteStream: null,
        pendingCandidates: [],
        connectTimer: null,
      };
      callRef.current = incoming;
      setCall({ ...idleCall(), phase: "incoming", callId: incoming.callId, conversationId: incoming.conversationId, mode: incoming.mode, peerName: incoming.peerName });
      return;
    }
    if (!context || context.callId !== payload.call_id || context.conversationId !== payload.conversation_id) return;
    if (type === "call.answer" && !context.incoming && context.pc) {
      void (async () => {
        try {
          await context.pc.setRemoteDescription({ type: "answer", sdp: payload.sdp });
          await flushCandidates(context);
          setCall((current) => current.callId === context.callId ? { ...current, phase: "connecting" } : current);
        } catch {
          sendEnd(context, "failed");
          stopContext(context, "The call could not be connected securely.");
        }
      })();
    } else if (type === "call.ice-candidate" && payload.candidate) {
      if (context.pc?.remoteDescription) {
        void context.pc.addIceCandidate(candidateFromWire(payload.candidate)).catch(() => {});
      } else {
        context.pendingCandidates.push(payload.candidate);
      }
    } else if (type === "call.end") {
      const messages = {
        busy: "Your friend is already on another call.",
        declined: "Your friend declined the call.",
        unavailable: "Your friend is unavailable for a call right now.",
        failed: "The call ended because the connection failed.",
        hangup: "The call ended.",
      };
      stopContext(context, messages[payload.reason] ?? "The call ended.");
    }
  }), [flushCandidates, send, sendEnd, stopContext, subscribe]);

  useEffect(() => () => {
    const context = callRef.current;
    if (context) stopContext(context);
  }, [stopContext]);

  const dismissNotice = useCallback(() => {
    setCall((current) => current.phase === "idle" ? { ...current, notice: "" } : current);
  }, []);

  return {
    call,
    startCall,
    acceptCall,
    endCall,
    toggleMuted,
    toggleCamera,
    dismissNotice,
  };
}
