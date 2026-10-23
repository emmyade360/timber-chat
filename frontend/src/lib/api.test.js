import { describe, expect, it } from "vitest";
import { OFFLINE_MESSAGE, WAKING_MESSAGE, userMessage } from "./api.js";

describe("safe API errors", () => {
  it("keeps an expected short client error useful", () => {
    expect(userMessage({ response: { status: 409, data: { error: "That username is already taken." } } }))
      .toBe("That username is already taken.");
  });

  it("never exposes server diagnostics or raw network errors", () => {
    expect(userMessage({ response: { status: 500, data: { error: "postgres password failed" } } }, "Could not save."))
      .toBe("Could not save.");
    expect(userMessage({ response: { status: 400, data: { error: "SQLSTATE 42P01: relation profiles" } } }, "Could not save."))
      .toBe("Could not save.");
    // A transport failure must never echo the URL, host, or token it was
    // carrying. Asserting the absence rather than one exact string keeps this
    // guarding the property even as the copy is reworded.
    const transport = userMessage({ message: "Network Error: https://internal.example/token" });
    expect(transport).not.toMatch(/internal\.example|token|Network Error/i);
    expect(transport).toBe(WAKING_MESSAGE);
  });

  it("gives neutral session and rate-limit guidance", () => {
    expect(userMessage({ response: { status: 401, data: { error: "invalid token" } } }))
      .toBe("Your session expired. Unlock Timber to reconnect.");
    expect(userMessage({ response: { status: 429, data: { error: "too many requests" } } }))
      .toBe("Too many attempts. Please wait a moment and try again.");
  });
});

describe("waiting for a relay that sleeps", () => {
  // The instance suspends when idle and takes tens of seconds to come back, so
  // the common failure is a server on its way up rather than a broken one.
  // Saying "check your connection" for that sends people to debug their wifi.

  it("explains a timeout as a wake-up, and asks for a retry", () => {
    const message = userMessage({ code: "ECONNABORTED", message: "timeout of 45000ms exceeded" });
    expect(message).toBe(WAKING_MESSAGE);
    expect(message).toMatch(/try again/i);
    expect(message).toMatch(/we're on it/i);
  });

  it("treats a gateway failure as the same wake-up", () => {
    for (const status of [502, 503, 504]) {
      expect(userMessage({ response: { status, data: {} } }, "Could not sign in.")).toBe(WAKING_MESSAGE);
    }
  });

  it("keeps the caller's fallback for a genuine server fault", () => {
    // A 500 is the app failing, not the app starting; "could not sign in" is
    // more use than a generic apology.
    expect(userMessage({ response: { status: 500, data: {} } }, "Could not sign in."))
      .toBe("Could not sign in.");
  });

  it("says so plainly when the device itself is offline", () => {
    const online = Object.getOwnPropertyDescriptor(globalThis.navigator ?? {}, "onLine");
    Object.defineProperty(globalThis.navigator, "onLine", { value: false, configurable: true });
    try {
      expect(userMessage({ code: "ERR_NETWORK" })).toBe(OFFLINE_MESSAGE);
    } finally {
      if (online) Object.defineProperty(globalThis.navigator, "onLine", online);
    }
  });

  it("still leaks nothing about the backend", () => {
    for (const message of [WAKING_MESSAGE, OFFLINE_MESSAGE]) {
      expect(message).not.toMatch(/render|onrender|http|host|port|502|timeout|axios/i);
    }
  });
});
