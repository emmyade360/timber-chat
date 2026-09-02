// The sniffer is the whole security boundary for inline rendering: everything
// it recognises gets an object URL and a real element, everything else stays a
// forced download. So the cases that matter most are the ones where a peer
// lies about what they sent.

import { describe, expect, it } from "vitest";
import { isInlineRenderable, sniffMediaType } from "./mediaType.js";

const bytes = (...values) => Uint8Array.from(values);
const ascii = (text) => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
const pad = (head, length = 32) => {
  const out = new Uint8Array(length);
  out.set(head.subarray(0, Math.min(head.length, length)));
  return out;
};

const PNG = pad(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a));
const JPEG = pad(bytes(0xff, 0xd8, 0xff, 0xe0));
const GIF = pad(ascii("GIF89a"));
const WEBP = pad(ascii("RIFF    WEBP"));
const WAV = pad(ascii("RIFF    WAVE"));
const MP4 = pad(ascii("....ftypisom"));
const AVIF = pad(ascii("....ftypavif"));
const WEBM = pad(bytes(0x1a, 0x45, 0xdf, 0xa3));
const OGG = pad(ascii("OggS"));
const MP3 = pad(ascii("ID3"));
const PDF = pad(ascii("%PDF-1.7"));

describe("recognising real formats", () => {
  it.each([
    ["png", PNG, "image/png", "image"],
    ["jpeg", JPEG, "image/jpeg", "image"],
    ["gif", GIF, "image/gif", "image"],
    ["webp", WEBP, "image/webp", "image"],
    ["avif", AVIF, "image/avif", "image"],
    ["wav", WAV, "audio/wav", "audio"],
    ["ogg", OGG, "audio/ogg", "audio"],
    ["mp3", MP3, "audio/mpeg", "audio"],
    ["mp4", MP4, "video/mp4", "video"],
    ["webm", WEBM, "video/webm", "video"],
    ["pdf", PDF, "application/pdf", "document"],
  ])("identifies %s from its leading bytes", (_name, input, mime, kind) => {
    expect(sniffMediaType(input)).toEqual({ mime, kind });
  });
});

describe("refusing everything else", () => {
  it.each([
    ["html", ascii("<!doctype html><script>alert(1)</script>aaaaaaaaaaaa")],
    ["svg", ascii("<svg xmlns='http://www.w3.org/2000/svg'></svg>")],
    ["a shell script", ascii("#!/bin/sh -- rm -rf / -- aaaaaaaaaaaaaaaaaaaa")],
    ["a zip", pad(bytes(0x50, 0x4b, 0x03, 0x04))],
    ["a windows executable", pad(bytes(0x4d, 0x5a, 0x90, 0x00))],
    ["an unknown RIFF payload", pad(ascii("RIFF    AVI "))],
    ["an unknown ISO brand", pad(ascii("....ftypzzzz"))],
    ["empty input", new Uint8Array()],
    ["a truncated header", bytes(0x89, 0x50)],
  ])("returns null for %s", (_name, input) => {
    expect(sniffMediaType(input)).toBeNull();
  });

  // The property the whole design rests on. An attachment whose payload claims
  // image/png must still be judged on its bytes, or the declared type would be
  // enough to get script into an object URL.
  it("ignores what the sender claimed the file was", () => {
    const claimedPng = ascii("<!doctype html><script>alert(1)</script>aaaa");
    expect(sniffMediaType(claimedPng)).toBeNull();
    expect(isInlineRenderable(sniffMediaType(claimedPng))).toBe(false);
  });
});

describe("what may be rendered in place", () => {
  it("renders media inline but never a document", () => {
    expect(isInlineRenderable(sniffMediaType(PNG))).toBe(true);
    expect(isInlineRenderable(sniffMediaType(MP4))).toBe(true);
    expect(isInlineRenderable(sniffMediaType(OGG))).toBe(true);
    // A PDF is recognised, so it is not treated as hostile -- but it is handed
    // over as a file rather than rendered, because a PDF viewer is a scripting
    // surface and this one would run on Timber's own origin.
    expect(isInlineRenderable(sniffMediaType(PDF))).toBe(false);
  });
});
