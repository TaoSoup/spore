// The one click remembered across an unlock (lib/pending-intent.ts says when it fires and when it is dropped), for the
// coin page's trade card and its "Launch a child" card. The page calls `remember` from a click that found the trading
// wallet locked (and opens the unlock itself); when the wallet turns unlocked within 60 s, `onFire` gets that click's
// payload once, and runs it through the same path as a click (every check, a fresh quote). It is dropped when the panel
// closes without an unlock, when the tab is hidden or left, on another coin, when the card's state no longer matches
// the click (`keyNow`), when the trading wallet is removed, and when the wallet unlocked is not the one that was locked
// at the click ("Forgot the password?" then an import or a new wallet: nothing signs with a key nobody clicked with).
import { useCallback, useEffect, useRef } from "react";
import { INTENT_TTL_MS, OneShot, type IntentKind } from "../lib/pending-intent";
import { CLOSED_EVENT, useTradingWallet } from "../lib/trader";

const pageNow = () => (typeof window === "undefined" ? "" : window.location.pathname);

export function useUnlockContinuation<T>(kind: IntentKind, mint: string, keyNow: (payload: T) => string, onFire: (payload: T) => void) {
  const shot = useRef(new OneShot<T>()).current;
  const keyRef = useRef(keyNow);
  keyRef.current = keyNow;
  const fireRef = useRef(onFire);
  fireRef.current = onFire;
  const mintRef = useRef(mint);
  mintRef.current = mint;
  const tw = useTradingWallet();
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const drop = useCallback(() => { shot.drop(); if (timer.current) { clearTimeout(timer.current); timer.current = null; } }, [shot]);

  const addrRef = useRef(tw.address);
  addrRef.current = tw.address;
  const remember = useCallback((payload: T, key: string) => {
    const wallet = addrRef.current;
    if (!wallet) { drop(); return; }
    shot.remember({ kind, mint: mintRef.current, page: pageNow(), key, wallet, at: Date.now(), payload });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(drop, INTENT_TTL_MS + 50);
  }, [shot, kind, drop]);

  // the wallet turned unlocked: the remembered click, once, if nothing about it changed (the same wallet included);
  // the wallet removed: the click is gone for good, whatever wallet comes next
  useEffect(() => {
    const i = shot.pending;
    if (!i) return;
    if (tw.status === "none") { drop(); return; }
    if (tw.status !== "unlocked") return;
    const r = shot.take({ kind, mint: mintRef.current, page: pageNow(), key: keyRef.current(i.payload), wallet: tw.address, now: Date.now(), unlocked: true });
    drop();
    if (r) fireRef.current(r.payload);
  }, [tw.status, tw.address, shot, kind, drop]);

  // dropped: the panel closed without an unlock, the tab was hidden or left, another coin, unmount
  useEffect(() => {
    const onClosed = (e: Event) => { if (!(e as CustomEvent<{ unlocked?: boolean }>).detail?.unlocked) drop(); };
    const onHidden = () => { if (document.visibilityState === "hidden") drop(); };
    window.addEventListener(CLOSED_EVENT, onClosed);
    document.addEventListener("visibilitychange", onHidden);
    window.addEventListener("pagehide", drop);
    return () => { window.removeEventListener(CLOSED_EVENT, onClosed); document.removeEventListener("visibilitychange", onHidden); window.removeEventListener("pagehide", drop); };
  }, [drop]);
  useEffect(() => drop, [mint, drop]);

  return { remember, drop };
}
