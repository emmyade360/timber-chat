// The settings icon set.
//
// One stroke weight, one 24-unit box, drawn to read at 20px inside the tinted
// square a settings row puts them in. Inline rather than a font or a sprite:
// they have to render under `script-src 'self'` and inside an installed PWA
// with no network.
//
// Separate from SettingsList so that file exports only components, which is
// what keeps fast refresh working.

const stroke = {
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.8,
  strokeLinecap: "round",
  strokeLinejoin: "round",
  "aria-hidden": "true",
};

export const Icons = {
  // --- navigation ---
  chats: (
    <svg {...stroke}><path d="M20.5 12.5c0 3.9-3.8 7-8.5 7a9.8 9.8 0 0 1-2.6-.34L4.5 20.5l1.2-3.5A6.6 6.6 0 0 1 3.5 12.5c0-3.9 3.8-7 8.5-7s8.5 3.1 8.5 7Z" /></svg>
  ),
  vault: (
    <svg {...stroke}><rect x="5" y="10" width="14" height="10" rx="2" /><path d="M8 10V7.5a4 4 0 0 1 8 0V10" /><path d="M12 14v2" /></svg>
  ),
  people: (
    <svg {...stroke}><circle cx="9" cy="8" r="3.4" /><path d="M2.9 19.8c0-3.2 2.7-5.4 6.1-5.4s6.1 2.2 6.1 5.4" /><path d="M16.2 5.1a3.4 3.4 0 0 1 0 6.5" /><path d="M17.6 14.7c2.2.5 3.7 2.2 3.7 4.5" /></svg>
  ),
  explore: (
    <svg {...stroke}><circle cx="12" cy="12" r="8.5" /><path d="m14.8 9.2-1.4 4.2-4.2 1.4 1.4-4.2Z" /></svg>
  ),
  profile: (
    <svg {...stroke}><circle cx="12" cy="8.2" r="3.8" /><path d="M4.8 20.2c0-3.6 3.2-6 7.2-6s7.2 2.4 7.2 6" /></svg>
  ),

  // --- chat header ---
  callAudio: (
    <svg {...stroke}><path d="M7 3.5c.8 0 1.4.5 1.6 1.2l.7 2.5c.2.7-.1 1.4-.7 1.8l-1.2.8a12 12 0 0 0 5.8 5.8l.8-1.2c.4-.6 1.1-.9 1.8-.7l2.5.7c.7.2 1.2.8 1.2 1.6V19a1.6 1.6 0 0 1-1.8 1.6C10.4 19.8 4.2 13.6 3.4 6.3A1.6 1.6 0 0 1 5 4.5Z" /></svg>
  ),
  callVideo: (
    <svg {...stroke}><rect x="2.8" y="6.5" width="12.4" height="11" rx="2.4" /><path d="m15.2 11 5-2.6v7.2l-5-2.6Z" /></svg>
  ),
  star: (
    <svg {...stroke}><path d="m12 4.2 2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4L4.2 9.9l5.4-.8Z" /></svg>
  ),
  bellOff: (
    <svg {...stroke}><path d="M6.5 9.5a5.5 5.5 0 0 1 8.4-4.7" /><path d="M17.5 9.5c0 4 1.5 5.5 1.5 5.5H8" /><path d="M10 18.5a2 2 0 0 0 4 0" /><path d="m3.5 3.5 17 17" /></svg>
  ),
  search: (
    <svg {...stroke}><circle cx="10.8" cy="10.8" r="6.3" /><path d="m15.5 15.5 4.2 4.2" /></svg>
  ),
  shield: (
    <svg {...stroke}><path d="M12 3.4 5 6v5.4c0 4.1 2.8 7.6 7 9.2 4.2-1.6 7-5.1 7-9.2V6Z" /></svg>
  ),
  back: (
    <svg {...stroke}><path d="m15 5-7 7 7 7" /></svg>
  ),
  settings: (
    <svg {...stroke}><circle cx="12" cy="12" r="3.1" /><path d="M19.4 14.5a1.7 1.7 0 0 0 .34 1.87l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.7 1.7 0 0 0-1.87-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 1 1-4 0v-.11a1.7 1.7 0 0 0-1.11-1.56 1.7 1.7 0 0 0-1.87.34l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.7 1.7 0 0 0 .34-1.87 1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 1 1 0-4h.11A1.7 1.7 0 0 0 4.67 8.6a1.7 1.7 0 0 0-.34-1.87l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.7 1.7 0 0 0 1.87.34H9.1a1.7 1.7 0 0 0 1.03-1.56V3a2 2 0 1 1 4 0v.11a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.87-.34l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.7 1.7 0 0 0-.34 1.87V9.1a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 1 1 0 4h-.11a1.7 1.7 0 0 0-1.56 1.03Z" /></svg>
  ),

  growth: (
    <svg {...stroke}><path d="M12 21v-8" /><path d="M12 13c0-3.3 2.5-6 5.6-6 .3 3.3-2.2 6-5.6 6Z" /><path d="M12 15c-3 0-5.4-2.4-5.4-5.4C9.6 9.6 12 12 12 15Z" /></svg>
  ),
  invite: (
    <svg {...stroke}><path d="M3 7.5 12 13l9-5.5" /><rect x="3" y="5" width="18" height="14" rx="2.5" /></svg>
  ),
  bell: (
    <svg {...stroke}><path d="M6.5 9.5a5.5 5.5 0 0 1 11 0c0 4 1.5 5.5 1.5 5.5H5s1.5-1.5 1.5-5.5Z" /><path d="M10 18.5a2 2 0 0 0 4 0" /></svg>
  ),
  moon: (
    <svg {...stroke}><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z" /></svg>
  ),
  clock: (
    <svg {...stroke}><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 1.8" /></svg>
  ),
  phone: (
    <svg {...stroke}><path d="M7 3.5c.8 0 1.4.5 1.6 1.2l.7 2.5c.2.7-.1 1.4-.7 1.8l-1.2.8a12 12 0 0 0 5.8 5.8l.8-1.2c.4-.6 1.1-.9 1.8-.7l2.5.7c.7.2 1.2.8 1.2 1.6V19a1.6 1.6 0 0 1-1.8 1.6C10.4 19.8 4.2 13.6 3.4 6.3A1.6 1.6 0 0 1 5 4.5Z" /></svg>
  ),
  compass: (
    <svg {...stroke}><circle cx="12" cy="12" r="8.5" /><path d="m14.8 9.2-1.4 4.2-4.2 1.4 1.4-4.2Z" /></svg>
  ),
  install: (
    <svg {...stroke}><path d="M12 3.5v10" /><path d="m8 10 4 4 4-4" /><path d="M4.5 16.5v2a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2v-2" /></svg>
  ),
  transfer: (
    <svg {...stroke}><path d="M4 8h13" /><path d="m14 5 3 3-3 3" /><path d="M20 16H7" /><path d="m10 13-3 3 3 3" /></svg>
  ),
  key: (
    <svg {...stroke}><circle cx="8" cy="14" r="3.8" /><path d="m10.7 11.3 8-8" /><path d="m16.5 5.5 2 2" /><path d="m14 8 2 2" /></svg>
  ),
  pin: (
    <svg {...stroke}><rect x="4.5" y="10" width="15" height="10" rx="2.2" /><path d="M8 10V7.5a4 4 0 0 1 8 0V10" /><path d="M12 14v2" /></svg>
  ),
  lock: (
    <svg {...stroke}><rect x="4.5" y="10.5" width="15" height="9.5" rx="2.2" /><path d="M7.8 10.5V7.2a4.2 4.2 0 0 1 8.4 0v3.3" /></svg>
  ),
  info: (
    <svg {...stroke}><circle cx="12" cy="12" r="8.5" /><path d="M12 11v5.5" /><path d="M12 7.8h.01" /></svg>
  ),
  trash: (
    <svg {...stroke}><path d="M4.5 7h15" /><path d="M9.5 7V5.5a1.5 1.5 0 0 1 1.5-1.5h2a1.5 1.5 0 0 1 1.5 1.5V7" /><path d="M6.5 7l.8 11.6a2 2 0 0 0 2 1.9h5.4a2 2 0 0 0 2-1.9L17.5 7" /><path d="M10.5 11v6M13.5 11v6" /></svg>
  ),
};
