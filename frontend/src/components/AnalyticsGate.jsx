import { useSyncExternalStore } from "react";
import { Analytics } from "@vercel/analytics/react";
import { analyticsAllowed, filterAnalyticsEvent, subscribeAccountPrivacy } from "../lib/accountPrivacy.js";

export default function AnalyticsGate() {
  const allowed = useSyncExternalStore(subscribeAccountPrivacy, analyticsAllowed, () => false);
  return allowed ? <Analytics beforeSend={filterAnalyticsEvent} /> : null;
}
