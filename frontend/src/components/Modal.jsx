// One modal, used everywhere.
//
// Chat, Explore and Settings each had their own copy of this markup, which is
// three chances for the backdrop click, the stop-propagation, the escape key or
// the focus behaviour to drift apart. They had already drifted: only some of
// them closed on Escape.

import { useEffect } from "react";

export default function Modal({ title, children, onClose, labelledBy }) {
  // Escape closes, and while a modal is up the page behind it must not scroll.
  useEffect(() => {
    const onKey = (event) => { if (event.key === "Escape") onClose?.(); };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className="modal glass-panel"
        role="dialog"
        aria-modal="true"
        aria-label={labelledBy ? undefined : title}
        aria-labelledby={labelledBy}
        onClick={(event) => event.stopPropagation()}
      >
        {title && <h3 className="modal-title">{title}</h3>}
        {children}
      </div>
    </div>
  );
}
