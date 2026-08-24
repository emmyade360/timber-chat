// Full-screen call surface shared by every tab, so an incoming call is visible
// even while the recipient is browsing chats rather than reading that thread.

import { useEffect, useRef } from "react";

function StreamVideo({ stream, muted, className, label }) {
  const ref = useRef(null);
  useEffect(() => {
    const video = ref.current;
    if (!video) return undefined;
    video.srcObject = stream ?? null;
    if (stream) video.play().catch(() => {});
    return () => { video.srcObject = null; };
  }, [stream]);
  return <video ref={ref} className={className} autoPlay playsInline muted={muted} aria-label={label} />;
}

function StreamAudio({ stream }) {
  const ref = useRef(null);
  useEffect(() => {
    const audio = ref.current;
    if (!audio) return undefined;
    audio.srcObject = stream ?? null;
    if (stream) audio.play().catch(() => {});
    return () => { audio.srcObject = null; };
  }, [stream]);
  return <audio ref={ref} className="call-remote-audio" autoPlay playsInline aria-label="Call audio" />;
}

function phaseLabel(call) {
  if (call.phase === "incoming") return `Incoming ${call.mode} call`;
  if (call.phase === "preparing") return "Starting secure call…";
  if (call.phase === "calling") return "Calling…";
  if (call.phase === "ringing") return "Ringing…";
  if (call.phase === "connecting") return "Connecting securely…";
  return call.mode === "video" ? "Video call" : "Audio call";
}

export default function CallOverlay({ call, acceptCall, endCall, toggleMuted, toggleCamera, dismissNotice }) {
  if (call.phase === "idle") {
    return call.notice ? <div className="call-toast" role="status"><span>{call.notice}</span><button onClick={dismissNotice} aria-label="Dismiss call notice">×</button></div> : null;
  }
  const incoming = call.phase === "incoming";
  const showRemoteVideo = call.mode === "video" && call.remoteStream;
  const showLocalVideo = call.mode === "video" && call.localStream;
  return (
    <div className="call-backdrop" role="dialog" aria-modal="true" aria-label={phaseLabel(call)}>
      <section className="call-panel glass-panel">
        {call.mode === "audio" && call.remoteStream && <StreamAudio stream={call.remoteStream} />}
        <div className="call-media">
          {showRemoteVideo ? <StreamVideo stream={call.remoteStream} muted={false} className="call-remote-video" label={`${call.peerName}'s video`} /> : <div className="call-avatar" aria-hidden="true">{call.peerName?.[0]?.toUpperCase() ?? "?"}</div>}
          {showLocalVideo && <StreamVideo stream={call.localStream} muted className={`call-local-video ${call.cameraOff ? "call-local-video--off" : ""}`} label="Your video preview" />}
        </div>
        <p className="call-status">{phaseLabel(call)}</p>
        <h2 className="call-name">@{call.peerName}</h2>
        <p className="call-note">Media is encrypted by WebRTC and is never saved by Timber.</p>

        {incoming ? (
          <div className="call-actions">
            <button className="call-btn call-btn--end" onClick={() => endCall("declined")}>Decline</button>
            <button className="call-btn call-btn--accept" onClick={acceptCall}>Accept</button>
          </div>
        ) : (
          <div className="call-actions">
            <button className={`call-btn ${call.muted ? "call-btn--selected" : ""}`} disabled={!call.localStream} onClick={toggleMuted}>{call.muted ? "Unmute" : "Mute"}</button>
            {call.mode === "video" && <button className={`call-btn ${call.cameraOff ? "call-btn--selected" : ""}`} disabled={!call.localStream} onClick={toggleCamera}>{call.cameraOff ? "Camera on" : "Camera off"}</button>}
            <button className="call-btn call-btn--end" onClick={() => endCall("hangup")}>End call</button>
          </div>
        )}
      </section>
    </div>
  );
}
