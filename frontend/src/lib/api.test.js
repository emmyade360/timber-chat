import { describe, expect, it } from "vitest";
import { userMessage } from "./api.js";

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
    expect(userMessage({ message: "Network Error: https://internal.example/token" }))
      .toBe("Timber can’t reach the service right now. Check your connection and try again.");
  });

  it("gives neutral session and rate-limit guidance", () => {
    expect(userMessage({ response: { status: 401, data: { error: "invalid token" } } }))
      .toBe("Your session expired. Unlock Timber to reconnect.");
    expect(userMessage({ response: { status: 429, data: { error: "too many requests" } } }))
      .toBe("Too many attempts. Please wait a moment and try again.");
  });
});
