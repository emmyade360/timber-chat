// Picking a reaction.
//
// The envelope has always carried an arbitrary emoji -- `payloads.reaction`
// takes a string -- but the only way to send one was a hard-coded heart. This
// is the missing half: a row of the common ones, and a larger grid behind
// "more" for everything else.

import { useEffect, useRef, useState } from "react";

/** The six that cover almost every reaction anyone actually sends. */
const QUICK = ["❤️", "\u{1F602}", "\u{1F62E}", "\u{1F622}", "\u{1F64F}", "\u{1F44D}"];

const MORE = [
  "\u{1F525}", "\u{1F389}", "\u{1F44F}", "\u{1F440}", "\u{1F60D}", "\u{1F914}",
  "\u{1F621}", "\u{1F44E}", "✅", "❌", "\u{1F4AF}", "\u{1F971}",
  "\u{1F937}", "\u{1F926}", "\u{1F92F}", "\u{1F60E}", "\u{1F97A}", "\u{1F92C}",
];

export default function ReactionPicker({ onPick, onClose }) {
  const [expanded, setExpanded] = useState(false);
  const container = useRef(null);

  // A picker that outlives the tap that opened it is a picker that gets in the
  // way of reading, so anything outside it closes it.
  useEffect(() => {
    const onPointerDown = (event) => {
      if (!container.current?.contains(event.target)) onClose();
    };
    const onKeyDown = (event) => { if (event.key === "Escape") onClose(); };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [onClose]);

  return (
    <div className="reaction-picker" ref={container} role="menu" aria-label="Pick a reaction">
      <div className="reaction-picker-row">
        {QUICK.map((emoji) => (
          <button key={emoji} role="menuitem" aria-label={`React with ${emoji}`} onClick={() => onPick(emoji)}>
            {emoji}
          </button>
        ))}
        <button
          className="reaction-picker-more"
          aria-label={expanded ? "Fewer reactions" : "More reactions"}
          aria-expanded={expanded}
          onClick={() => setExpanded((open) => !open)}
        >
          {expanded ? "−" : "+"}
        </button>
      </div>
      {expanded && (
        <div className="reaction-picker-grid">
          {MORE.map((emoji) => (
            <button key={emoji} role="menuitem" aria-label={`React with ${emoji}`} onClick={() => onPick(emoji)}>
              {emoji}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
