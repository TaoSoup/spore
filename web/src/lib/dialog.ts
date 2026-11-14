// useDialog: what every modal surface needs (the phone trade sheet, the claim and trade confirm
// dialogs, the claim-all summary, the phone menu sheet). On open it remembers the focused element,
// focuses the first control (or `initialFocus`), traps Tab inside, closes the TOP dialog on
// Escape, and makes the page behind inert when the dialog is portalled outside #root. On close
// focus returns to where it was (or to `returnFocus`). Render the dialog with
// createPortal(…, document.body) and role="dialog" aria-modal="true" aria-labelledby=….
import { useEffect, useRef, type RefObject } from "react";

const stack: HTMLElement[] = [];
/// Whether any dialog is open: a page's own keyboard shortcuts stand down while one is (keys belong to the dialog).
export const isDialogOpen = () => stack.length > 0;
const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function useDialog<T extends HTMLElement = HTMLDivElement>(open: boolean, onClose: () => void, opts: { initialFocus?: RefObject<HTMLElement | null>; returnFocus?: RefObject<HTMLElement | null> } = {}): RefObject<T | null> {
  const ref = useRef<T>(null);
  const close = useRef(onClose);
  close.current = onClose;
  const { initialFocus, returnFocus } = opts;
  useEffect(() => {
    const node = ref.current;
    if (!open || !node) return;
    const before = document.activeElement as HTMLElement | null;
    // a control inside the dialog may already hold the focus (autoFocus, a child's effect): it keeps it, and it is no
    // place to return to (the opener is: `returnFocus`, or nothing)
    const inside = !!before && node.contains(before);
    stack.push(node);
    const root = document.getElementById("root");
    const makeInert = !!root && !root.contains(node);
    if (makeInert) root!.setAttribute("inert", "");
    const first = initialFocus?.current ?? (inside ? null : node.querySelector<HTMLElement>(FOCUSABLE) ?? node);
    if (first === node && !node.hasAttribute("tabindex")) node.setAttribute("tabindex", "-1");
    first?.focus({ preventScroll: true });
    const onKey = (e: KeyboardEvent) => {
      if (stack[stack.length - 1] !== node) return;
      // The wallet adapter's own modal (Connect wallet) opens over a dialog without joining this stack: its Escape
      // and Tab are its own, so the dialog underneath neither closes nor pulls the focus back.
      if (document.querySelector(".wallet-adapter-modal")) return;
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); close.current(); return; }
      if (e.key !== "Tab") return;
      const items = [...node.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (!items.length) { e.preventDefault(); return; }
      const a = items[0], z = items[items.length - 1];
      if (e.shiftKey && (document.activeElement === a || !node.contains(document.activeElement))) { e.preventDefault(); z.focus(); }
      else if (!e.shiftKey && (document.activeElement === z || !node.contains(document.activeElement))) { e.preventDefault(); a.focus(); }
    };
    document.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("keydown", onKey, true);
      const i = stack.lastIndexOf(node);
      if (i >= 0) stack.splice(i, 1);
      if (makeInert && !stack.some((n) => !root!.contains(n))) root!.removeAttribute("inert");
      (returnFocus?.current ?? (inside ? null : before))?.focus?.({ preventScroll: true });
    };
  }, [open, initialFocus, returnFocus]);
  return ref;
}
