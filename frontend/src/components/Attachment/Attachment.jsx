// A received attachment, rendered in place when its bytes say that is safe.
//
// Two separate decisions here, and keeping them apart is the point:
//
//   whether to fetch    -- uses the sender's declared size and kind. Untrusted,
//                          but it can only ever cost bandwidth, never safety.
//   what to render      -- uses sniffMediaType on the decrypted bytes and
//                          nothing else. The declared MIME never reaches the
//                          browser; a Blob is built from the sniffed type, so a
//                          file claiming to be a PNG cannot become a document.
//
// Anything unrecognised keeps the forced download Timber has always used.

import { useEffect, useState } from "react";
import { decryptFile } from "../../crypto/envelope.js";
import { downloadEncrypted } from "../../lib/api.js";
import { isInlineRenderable, sniffMediaType } from "../../lib/mediaType.js";

// Fetch small things without being asked; make someone opt into a big video on
// a metered connection.
const AUTO_LOAD_MAX_BYTES = 2 * 1024 * 1024;

/**
 * Decrypted attachments, kept as object URLs so scrolling a thread does not
 * re-download and re-decrypt the same photo repeatedly. Bounded, because each
 * entry pins its bytes in memory until the URL is revoked.
 */
const CACHE_LIMIT = 24;
const cache = new Map();

function remember(id, entry) {
  if (cache.has(id)) return;
  cache.set(id, entry);
  while (cache.size > CACHE_LIMIT) {
    const [oldestId, oldest] = cache.entries().next().value;
    cache.delete(oldestId);
    URL.revokeObjectURL(oldest.url);
  }
}

/** Strip anything a peer-supplied filename could do to a download attribute. */
function safeDownloadName(value) {
  const cleaned = String(value ?? "attachment")
    .replace(/[\\/:*?"<>|]/g, "_")
    .split("")
    .map((character) => (character.charCodeAt(0) < 32 ? "_" : character))
    .join("")
    .trim()
    .slice(0, 120);
  return cleaned || "attachment";
}

function prettySize(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function seconds(durationMs) {
  const total = Math.ceil((durationMs ?? 0) / 1000);
  if (!total) return "";
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Fetch without being asked? Uses the sender's numbers, so it risks only bandwidth. */
function autoLoads(payload) {
  return payload.kind === "voice" || (payload.size ?? 0) <= AUTO_LOAD_MAX_BYTES;
}

/**
 * Fetch, decrypt and identify one attachment.
 *
 * Deliberately free of React state so both the automatic path and the tap path
 * share it, and so the effect below can await it without the setState-inside-an-
 * effect cascade the rest of this codebase avoids.
 */
async function decryptAttachment(payload) {
  const existing = cache.get(payload.attachment_id);
  if (existing) return existing;
  const { data } = await downloadEncrypted(payload.attachment_id);
  const bytes = decryptFile(new Uint8Array(data), payload.key);
  const sniffed = sniffMediaType(bytes);
  // The Blob is built from the sniffed type, or from a type that can never be
  // rendered at all. `payload.mime` is deliberately not consulted.
  const blob = new Blob([bytes], {
    type: isInlineRenderable(sniffed) ? sniffed.mime : "application/octet-stream",
  });
  const entry = { url: URL.createObjectURL(blob), sniffed };
  remember(payload.attachment_id, entry);
  return cache.get(payload.attachment_id) ?? entry;
}

const FAILURE = "This encrypted attachment is unavailable or has expired.";

export default function Attachment({ payload }) {
  // Resolved once, before the first render. Starting in the state the effect
  // would otherwise have to set is what keeps a synchronous setState out of it.
  const [media, setMedia] = useState(() => cache.get(payload.attachment_id) ?? null);
  const [status, setStatus] = useState(() => {
    if (cache.has(payload.attachment_id)) return "ready";
    return autoLoads(payload) ? "loading" : "idle";
  });

  useEffect(() => {
    if (status !== "loading" || media) return undefined;
    // Ignore a result that lands after this attachment scrolled away or the
    // thread was closed.
    let ignore = false;
    decryptAttachment(payload)
      .then((entry) => {
        if (ignore) return;
        setMedia(entry);
        setStatus("ready");
      })
      .catch(() => { if (!ignore) setStatus("failed"); });
    return () => { ignore = true; };
  }, [status, media, payload]);

  const save = () => {
    if (!media) return;
    const link = document.createElement("a");
    link.href = media.url;
    link.download = safeDownloadName(payload.name);
    link.click();
  };

  if (status === "failed") return <p className="attachment-error">{FAILURE}</p>;

  if (status === "idle" || status === "loading") {
    return (
      <button
        className="attachment-card"
        onClick={() => setStatus("loading")}
        disabled={status === "loading"}
      >
        <span aria-hidden="true">{payload.kind === "voice" ? "\u{1F399}" : "\u{1F4CE}"}</span>
        <span className="attachment-card-text">
          <strong>{payload.name ?? "Encrypted attachment"}</strong>
          <small>{status === "loading" ? "Decrypting…" : prettySize(payload.size)}</small>
        </span>
      </button>
    );
  }

  const kind = media?.sniffed?.kind;

  if (kind === "image") {
    return (
      <button className="attachment-image" onClick={save} title="Save image">
        <img src={media.url} alt={payload.name ?? "Encrypted image"} loading="lazy" />
      </button>
    );
  }

  if (kind === "video") {
    return <video className="attachment-video" src={media.url} controls preload="metadata" />;
  }

  if (kind === "audio") {
    return (
      <div className={`attachment-audio ${payload.kind === "voice" ? "attachment-audio--voice" : ""}`}>
        <audio src={media.url} controls preload="metadata" />
        {payload.kind === "voice" && payload.duration_ms
          ? <small className="attachment-duration">{seconds(payload.duration_ms)}</small>
          : null}
      </div>
    );
  }

  // Recognised-but-not-renderable, or not recognised at all: hand it over as a
  // file, exactly as every attachment used to be handled.
  return (
    <button className="attachment-card" onClick={save}>
      <span aria-hidden="true">{"\u{1F4CE}"}</span>
      <span className="attachment-card-text">
        <strong>{payload.name ?? "Encrypted attachment"}</strong>
        <small>{prettySize(payload.size)} · Save</small>
      </span>
    </button>
  );
}
