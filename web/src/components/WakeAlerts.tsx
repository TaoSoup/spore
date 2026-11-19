// Wake-up alerts: a browser notification when a family starts buying far above its normal level (the SSE `wake` event,
// lib/events.ts), on every page while a tab of the site is open. The Discover page's button turns them on (it asks the
// browser for permission) and off; the switch is kept in localStorage, so it holds across reloads, and read by every
// mounted reader through one small store here (a click on the page reaches the listener in the shell at once, another
// tab follows through the `storage` event). Off, nothing subscribes: the stream is not opened for alerts.
// At most one notification per parent in 3 h (lib/discover.ts alertDue; the memo is in localStorage too, so a reload
// does not repeat one), and each carries a tag per parent, so two open tabs show one. A click on it opens /discover.
// Storage that throws (a private window, blocked site data) leaves alerts on for this page's life only.
import { useCallback, useSyncExternalStore } from "react";
import { useNavigate } from "react-router-dom";
import { ALERT_KEY, ALERTED_KEY, alertDue, alertText, alertUi, noteAlert, parseAlertMemo, wakeFresh, type AlertMemo, type AlertUi } from "../lib/discover";
import { useEvents } from "../lib/events";

// Chrome on Android (and the browsers built on it) has window.Notification and grants it, but `new Notification` always
// throws there (only a service worker can show one, and this site registers none), so the switch would read "Alerts
// on" and nothing would ever appear: such a browser is "unsupported" from the start. Any other engine whose
// constructor throws is found out at its first alert (`ctorBroken`) and the button says so from then on.
let ctorBroken = false;
const pageNotify = () => typeof navigator === "undefined" || !/Android/i.test(navigator.userAgent);
const hasNotify = () => typeof window !== "undefined" && typeof window.Notification === "function" && !ctorBroken && pageNotify();
const permission = (): string | null => (hasNotify() ? Notification.permission : null);

// the switch, as stored; `mem` keeps it when storage throws
let mem: boolean | null = null;
const subs = new Set<() => void>();
function readOn(): boolean {
  try { const v = localStorage.getItem(ALERT_KEY); if (v !== null) return v === "on"; } catch { /* blocked storage: the page's own value */ }
  return mem ?? false;
}
function writeOn(on: boolean) {
  mem = on;
  try { localStorage.setItem(ALERT_KEY, on ? "on" : "off"); } catch { /* kept in memory */ }
  subs.forEach((f) => f());
}
// the store's snapshot: the switch and the permission as one string, so a permission change is seen on the next read
const snap = () => `${readOn() ? "on" : "off"}|${permission() ?? "none"}`;
function subscribe(f: () => void) {
  subs.add(f);
  const onStorage = (e: StorageEvent) => { if (e.key === ALERT_KEY) f(); };
  // a permission changed in the browser's settings is seen when the reader comes back to the tab
  const onVisible = () => { if (!document.hidden) f(); };
  window.addEventListener("storage", onStorage);
  document.addEventListener("visibilitychange", onVisible);
  return () => { subs.delete(f); window.removeEventListener("storage", onStorage); document.removeEventListener("visibilitychange", onVisible); };
}
const useAlertSnap = () => useSyncExternalStore(subscribe, snap, () => "off|none");

let memoMem: AlertMemo = {};
function readMemo(): AlertMemo {
  try { return parseAlertMemo(localStorage.getItem(ALERTED_KEY)); } catch { return memoMem; }
}
function writeMemo(m: AlertMemo) {
  memoMem = m;
  try { localStorage.setItem(ALERTED_KEY, JSON.stringify(m)); } catch { /* kept in memory */ }
}

/// The Discover page's button: what it shows and what a click does. Off: asks the browser for permission (when it has
/// not been asked) and turns alerts on once granted. On: turns them off. Blocked or unsupported: nothing.
export function useWakeAlertSwitch(): { ui: AlertUi; toggle: () => void } {
  const s = useAlertSnap();
  const ui = alertUi(s.split("|")[1], s.startsWith("on|"));
  const toggle = useCallback(() => {
    const p = permission();
    if (ui === "on") { writeOn(false); return; }
    if (p === "granted") { writeOn(true); return; }
    if (p !== "default") return;
    let asked: Promise<NotificationPermission> | undefined;
    try { asked = Notification.requestPermission(); } catch { asked = undefined; }
    // an old engine answers by callback only: the next visit to the tab reads the permission
    if (!asked) { subs.forEach((f) => f()); return; }
    asked.then((r) => { if (r === "granted") writeOn(true); else subs.forEach((f) => f()); }, () => subs.forEach((f) => f()));
  }, [ui]);
  return { ui, toggle };
}

/// Mounted once in the shell: listens for `wake` while alerts are on and shows the notification.
export default function WakeAlerts() {
  const nav = useNavigate();
  const s = useAlertSnap();
  const on = alertUi(s.split("|")[1], s.startsWith("on|")) === "on";
  useEvents({
    wake: (e) => {
      const now = Math.floor(Date.now() / 1000), mint = e.parent.mint;
      if (!wakeFresh(e, now) || permission() !== "granted") return;
      const memo = readMemo();
      if (!alertDue(memo, mint, now)) return;
      const t = alertText(e);
      try {
        const n = new Notification(t.title, { body: t.body, tag: `wake:${mint}`, icon: "/icon-192.png" });
        n.onclick = () => { try { window.focus(); } catch { /* focus refused */ } nav("/discover"); n.close(); };
      } catch {
        // notifications only through a service worker: the button turns to "can't show notifications" and the stream
        // closes; nothing is noted, so no 3 h slot is taken by an alert that never showed
        ctorBroken = true; subs.forEach((f) => f());
        return;
      }
      writeMemo(noteAlert(memo, mint, now));
    },
  }, on);
  return null;
}
