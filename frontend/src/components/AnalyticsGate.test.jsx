import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, render } from "@testing-library/react";
import AnalyticsGate from "./AnalyticsGate.jsx";
import { filterAnalyticsEvent, setAccountPrivacy, setAnalyticsSessionActive, setPrivacyIdentity } from "../lib/accountPrivacy.js";

beforeEach(() => {
  setAnalyticsSessionActive(false);
  setAccountPrivacy(null);
  setPrivacyIdentity(null);
  document.querySelectorAll("script[data-sdkn]").forEach((script) => script.remove());
  delete window.va;
  delete window.vaq;
});
afterEach(() => { cleanup(); setAnalyticsSessionActive(false); setAccountPrivacy(null); });

describe("optional analytics gate", () => {
  it("loads no analytics script for unknown, onboarding, or anonymous sessions", () => {
    render(<AnalyticsGate />);
    expect(document.querySelector("script[data-sdkn]")).toBeNull();
    act(() => { setPrivacyIdentity("anonymous"); setAccountPrivacy(true, "anonymous"); setAnalyticsSessionActive(true); });
    expect(document.querySelector("script[data-sdkn]")).toBeNull();
    expect(filterAnalyticsEvent({ type: "pageview" })).toBeNull();
  });

  it("requires both a known standard account and an active session", () => {
    setPrivacyIdentity("standard");
    setAccountPrivacy(false, "standard");
    render(<AnalyticsGate />);
    expect(document.querySelector("script[data-sdkn]")).toBeNull();
    act(() => setAnalyticsSessionActive(true));
    expect(document.querySelector("script[data-sdkn]")).not.toBeNull();
    const event = { type: "pageview", url: "/" };
    expect(filterAnalyticsEvent(event)).toBe(event);
    // The SDK's registered callback reads live policy even after unmount.
    const queuedFilter = window.vaq.find((entry) => entry[0] === "beforeSend")[1];
    act(() => { setAnalyticsSessionActive(false); setPrivacyIdentity("anonymous"); setAccountPrivacy(true, "anonymous"); });
    expect(queuedFilter(event)).toBeNull();
    act(() => setAnalyticsSessionActive(true));
    expect(queuedFilter(event)).toBeNull();
    act(() => setAccountPrivacy(false, "standard"));
    expect(queuedFilter(event)).toBeNull();
  });
});
