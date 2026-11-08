// "Share ▾" on the coin header: copy the link, post on X, copy an embed of the family tree, copy
// the CA. A 220 px popover that closes on Escape or a click outside. On a phone with a native share
// sheet that sheet opens first; the popover is the fallback where sharing is not supported.
import { useEffect, useId, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { xShareUrl, type Coin } from "../../lib/api";
import { copyText } from "../../lib/hooks";
import { coinPageShareText } from "../../lib/map/share";
import { sym } from "../Bits";
import { useToast } from "../Toast";

const shareIcon = <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="M12 15V4M8 8l4-4 4 4" /><path d="M5 12v6.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V12" /></svg>;

/// `current` reads the live record (market cap moves with every trade) when the menu opens.
export default function ShareMenu({ coin: base, current, className = "" }: { coin: Coin; current?: () => Coin; className?: string }) {
  const [open, setOpen] = useState(false);
  const coin = open && current ? current() : base;
  const box = useRef<HTMLDivElement>(null);
  const btn = useRef<HTMLButtonElement>(null);
  const id = useId();
  const toast = useToast();
  const origin = typeof window !== "undefined" ? window.location.origin : "https://sporepad.com";
  const link = `${origin}/c/${coin.mint}`;
  // The post text comes from lib/map/share, so the coin page and the map say the same thing about a coin.
  const text = coinPageShareText(coin);
  const embed = `<iframe src="${origin}/embed/tree/${coin.mint}" width="100%" height="420" style="border:0"></iframe>`;

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.stopPropagation(); setOpen(false); btn.current?.focus(); } };
    const onDown = (e: PointerEvent) => { if (!box.current?.contains(e.target as Node)) setOpen(false); };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("pointerdown", onDown);
    // First item gets focus so the menu is usable from the keyboard at once.
    box.current?.querySelector<HTMLElement>("[role=menuitem]")?.focus({ preventScroll: true });
    return () => { window.removeEventListener("keydown", onKey, true); document.removeEventListener("pointerdown", onDown); };
  }, [open]);

  const copy = async (value: string, what: string) => {
    setOpen(false);
    if (await copyText(value)) toast.success(`${what} copied`); else toast.error(`Could not copy the ${what.toLowerCase()}`);
  };
  const toggle = async () => {
    if (open) { setOpen(false); return; }
    // Phones: the native sheet first; a cancel or an unsupported share falls back to the menu.
    const coarse = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches;
    if (coarse && typeof navigator !== "undefined" && typeof navigator.share === "function") {
      const c = current ? current() : base;
      const t = coinPageShareText(c);
      try { await navigator.share({ title: `${sym(c)} on Spore`, text: t, url: link }); return; }
      catch (e) { if ((e as Error).name === "AbortError") return; }
    }
    setOpen(true);
  };
  const onMenuKey = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return;
    e.preventDefault();
    const items = [...(box.current?.querySelectorAll<HTMLElement>("[role=menuitem]") ?? [])];
    const i = items.indexOf(document.activeElement as HTMLElement);
    items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
  };

  return (
    <div className={`share ${className}`} ref={box}>
      <button ref={btn} type="button" className="btn ghost sm share-btn" aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={toggle}>
        {shareIcon}Share<span className="caret" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="share-pop" id={id} role="menu" aria-label={`Share ${sym(coin)}`} onKeyDown={onMenuKey}>
          <button type="button" role="menuitem" onClick={() => copy(link, "Link")}><b>Copy link</b><small className="mono">{link.replace(/^https?:\/\//, "")}</small></button>
          <a role="menuitem" href={xShareUrl(text, link)} target="_blank" rel="noreferrer" onClick={() => setOpen(false)}><b>Post on X ↗</b><small>{text}</small></a>
          <button type="button" role="menuitem" onClick={() => copy(embed, "Embed code")}><b>Copy embed</b><small>The live family tree for any site</small></button>
          <button type="button" role="menuitem" onClick={() => copy(coin.mint, "Contract address")}><b>Copy CA</b><small className="mono">{coin.mint.slice(0, 6)}…{coin.mint.slice(-6)}</small></button>
        </div>
      )}
    </div>
  );
}
