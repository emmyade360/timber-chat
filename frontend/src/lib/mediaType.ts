// What a decrypted attachment actually is, decided by its bytes.
//
// The sender's declared MIME type is peer-controlled and is never trusted: it
// arrives inside a sealed envelope, which proves who wrote it, not that they
// wrote the truth. Rendering a peer-chosen type is how a "photo" becomes an
// HTML document in an object URL, so the type used for display is derived here
// from the leading bytes and nothing else.
//
// Anything this file does not positively recognise has no inline
// representation at all and falls back to the forced download that every
// attachment used to get. The allowlist is therefore the whole security
// boundary: adding a format here is a deliberate act.

export type MediaKind = "image" | "video" | "audio" | "document";

export interface SniffedMedia {
  /** The type the browser will be given. Always from this file, never from the peer. */
  mime: string;
  kind: MediaKind;
}

const enc = (text: string): number[] => [...text].map((character) => character.charCodeAt(0));

/** `bytes` starts with `pattern`, treating null entries as "any byte". */
function matches(bytes: Uint8Array, pattern: (number | null)[], offset = 0): boolean {
  if (bytes.length < offset + pattern.length) return false;
  return pattern.every((value, index) => value === null || bytes[offset + index] === value);
}

/** The ISO base-media brand at bytes 8..12, for the `ftyp`-prefixed formats. */
function isoBrand(bytes: Uint8Array): string | null {
  if (!matches(bytes, enc("ftyp"), 4)) return null;
  return String.fromCharCode(...bytes.subarray(8, 12));
}

const MP4_BRANDS = new Set(["isom", "iso2", "iso4", "iso5", "iso6", "mp41", "mp42", "avc1", "M4V ", "M4A ", "dash"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

/**
 * Identify a decrypted attachment, or return null to force a download.
 *
 * Order matters: the RIFF and ISO container checks have to look past their
 * first four bytes before either can claim a buffer.
 */
export function sniffMediaType(bytes: Uint8Array): SniffedMedia | null {
  if (bytes.length < 12) return null;

  if (matches(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
    return { mime: "image/png", kind: "image" };
  }
  if (matches(bytes, [0xff, 0xd8, 0xff])) {
    return { mime: "image/jpeg", kind: "image" };
  }
  if (matches(bytes, enc("GIF87a")) || matches(bytes, enc("GIF89a"))) {
    return { mime: "image/gif", kind: "image" };
  }
  // RIFF containers name their payload at bytes 8..12.
  if (matches(bytes, enc("RIFF"))) {
    if (matches(bytes, enc("WEBP"), 8)) return { mime: "image/webp", kind: "image" };
    if (matches(bytes, enc("WAVE"), 8)) return { mime: "audio/wav", kind: "audio" };
    return null;
  }

  const brand = isoBrand(bytes);
  if (brand) {
    if (AVIF_BRANDS.has(brand)) return { mime: "image/avif", kind: "image" };
    if (brand === "M4A ") return { mime: "audio/mp4", kind: "audio" };
    if (MP4_BRANDS.has(brand)) return { mime: "video/mp4", kind: "video" };
    if (brand.startsWith("qt")) return { mime: "video/quicktime", kind: "video" };
    return null;
  }

  // Matroska and WebM share a signature; only the browser can say whether a
  // given stream is playable, and it degrades to its own error UI if not.
  if (matches(bytes, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { mime: "video/webm", kind: "video" };
  }
  if (matches(bytes, enc("OggS"))) {
    return { mime: "audio/ogg", kind: "audio" };
  }
  if (matches(bytes, enc("ID3")) || matches(bytes, [0xff, null])) {
    // A bare MPEG frame sync is only two bits shy of arbitrary, so it is
    // accepted last and only when the second byte really is a frame header.
    const second = bytes[1];
    if (matches(bytes, enc("ID3")) || (second !== undefined && (second & 0xe0) === 0xe0)) {
      return { mime: "audio/mpeg", kind: "audio" };
    }
  }
  if (matches(bytes, enc("%PDF-"))) {
    return { mime: "application/pdf", kind: "document" };
  }
  return null;
}

/** Formats worth rendering in place rather than handing over as a file. */
export function isInlineRenderable(media: SniffedMedia | null): media is SniffedMedia {
  return media !== null && media.kind !== "document";
}
