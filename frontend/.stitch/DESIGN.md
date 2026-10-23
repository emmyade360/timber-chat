---
name: Timber Privacy-First Chat
colors:
  background: '#131315'
  surface-low: '#1b1b1d'
  surface: '#201f21'
  surface-raised: '#2a2a2c'
  surface-high: '#353437'
  text-primary: '#e5e1e4'
  text-muted: '#c7c5cf'
  text-secondary: '#d8c2b5'
  outline: '#53443a'
  accent: '#ffb783'
  accent-strong: '#e29357'
  accent-subtle: '#4B3221'
  success: '#4ADE80'
  danger: '#F87171'
typography:
  body: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
  heading: 'system-ui, -apple-system, Segoe UI, Roboto, sans-serif'
  base-size: 16px
  line-height: 1.5
spacing:
  base: 8px
  mobile-gutter: 16px
  desktop-gutter: 32px
  message-stack-gap: 4px
  section-gap: 24px
---

# Timber Privacy-First Chat

## Visual theme and atmosphere

Timber is a calm, durable place for close one-to-one conversations. The existing
dark charcoal surfaces and warm amber accent feel rooted and personal; give the
interface sharper hierarchy, more confident controls, and quiet dimensionality
without making the chat feel like a dashboard. Keep the forest identity in the
mark and growth details, not in decorative clutter.

## Color palette and roles

- **Deep Charcoal** (#131315) anchors the application.
- **Raised Charcoal** (#1b1b1d, #201f21, #2a2a2c, #353437) separates navigation,
  list, chat, and floating layers through tonal steps.
- **Warm Amber** (#ffb783) marks high-intent actions, selected navigation,
  unread counts, and read receipts. Use the stronger Timber amber (#e29357) for
  filled primary controls.
- **Soft Linen** (#e5e1e4) carries primary text; **Ash** (#c7c5cf) and
  **Warm Taupe** (#d8c2b5) carry supporting text.
- **Moss Green** (#4ADE80) and **Soft Red** (#F87171) indicate success and
  destructive/error states. Always pair status color with text or an icon.

## Typography

The product uses the operating-system sans-serif stack so the interface loads
immediately, respects user preferences, and works offline as an installed PWA.
Use a restrained hierarchy: 24px page titles, 17–18px conversation titles,
16px readable body text, and 12–14px metadata. Keep timestamps and status
labels legible rather than overly faint.

## Components

- **Buttons:** Minimum 44px touch targets for icon controls and 48px for primary
  mobile actions. Use filled amber for the primary action, raised tonal surfaces
  for secondary icon buttons, and clear hover, pressed, disabled, and focus states.
- **Message actions:** Keep the contextual action popover in a two-column grid
  with at least 8px between touch targets. Anchor incoming actions to the left
  side of the message and outgoing actions to the right, within the viewport.
- **Surfaces:** Use hairline borders and restrained layered shadows to lift
  menus, headers, composers, and dialogs. Avoid heavy blur and thick outlines.
- **Conversation rows:** Circular initials, strong peer name, concise local
  message preview, clear timestamp, and a high-contrast unread badge. Keep the
  selected conversation unmistakable without color alone.
- **Chat bubbles:** Incoming and outgoing messages use distinct charcoal tones,
  compact grouping for consecutive messages, readable metadata, and a subtle
  corner variation to show speaker direction.
- **Privacy state:** Keep end-to-end encryption visible but quiet. Explain that
  content is encrypted on the device and not readable by Timber; never imply
  that public Explore profile data has the same protection.
- **Icons:** Use a consistent 24-unit inline SVG stroke family with accessible
  labels; do not use Unicode glyphs or emoji as action icons.

## Layout principles

Use a mobile-first responsive shell. Phones have a labeled bottom navigation
bar, a focused chat list or conversation view, and safe-area-aware controls.
Desktop expands into a compact navigation rail, a 320px conversation pane, and
a flexible conversation pane. Keep the desktop message column near 56rem for
comfortable reading. Use an 8px spacing base, 16px phone gutters, and 32px
desktop page gutters.

## Stitch generation notes

Make one-to-one conversations the only chat model. Use familiar messaging
patterns from established products while keeping Timber's identity and privacy
promises distinct. Surface offline/queued, sent/delivered/read, typing, and
verified-contact states honestly. Treat message search and saved messages as
device-local features. Prefer labeled actions and explicit empty, loading, and
error states over decorative filler.

## Adventure and level language

Timber's adventure layer is a reading of its existing growth system, not a new
game economy. The twenty-one backend stages remain the source of truth and are
grouped by the three acts already named in the level implementation: Formation
(Carbon–Facet), Craft (Baguette–Brilliant), and Legend (Champagne–Koh-i-Noor).
Show the current stage clearly and leave later stages visible but quiet. Use the
gem badge already associated with each stage; do not invent quests, streak
rewards, badges, or deadlines. A user's stage is participation context, never a
score of relationship quality or personal value.

Make the map informational and calm. Show the known point thresholds and the
existing practice caps, explain message activity is capped, and state that the
relay does not read message contents. Do not claim no points come from message
activity. Streak counts are optional context; do not flash a warning when a
streak may end. The stage itself does not expire, and the adventure page says so.

## Research and adoption decisions

- Evaluated the official Zulip, Element Web, and Rocket.Chat repositories and
  documentation. Adopt familiar, high-value patterns: searchable conversation
  lists, persistent local saved messages, visible message actions, strong
  unread hierarchy, predictable back navigation, keyboard focus, and touch
  controls sized for fingers. These fit one-to-one E2EE chats.
- Do not import channel/thread-first layouts, heavy component packages, or
  outside assets. Those patterns add navigation weight or conflict with
  Timber's accepted-friend model and offline-first CSP. Keep existing icons as
  local inline SVG and use project code, not copied source.
- Research on notifications shows they can increase immediate opens without
  reliably improving long-term retention; another field experiment found that
  reducing notification load improved focus and reduced strain. Prefer user
  control, useful quiet defaults, and reliable message delivery over urgency
  loops or streak pressure.
- Gamification reviews suggest possible short-term engagement gains, while
  lasting effects are less certain. Keep the journey optional and transparent;
  don't add variable rewards, leaderboards, or artificial scarcity.
- Keep route and mark animation to one short arrival, then rest. All essential
  state remains available with reduced motion, and no animation runs forever.

## References reviewed

- [Zulip source repository](https://github.com/zulip/zulip) and [keyboard
  navigation guide](https://zulip.com/help/keyboard-shortcuts)
- [Element Web source repository](https://github.com/element-hq/element-web)
- [Rocket.Chat source repository](https://github.com/RocketChat/Rocket.Chat)
  and [accessibility guide](https://developer.rocket.chat/docs/accessibility)
- [Apple notification guidance](https://developer.apple.com/design/human-interface-guidelines/notifications?changes=_4)
- [Field experiment on notification load](https://pmc.ncbi.nlm.nih.gov/articles/PMC10244611/)
- [Notification micro-randomized trial](https://mhealth.jmir.org/2023/1/e38342/)
- [Gamification systematic review](https://doi.org/10.1371/journal.pone.0173403)
