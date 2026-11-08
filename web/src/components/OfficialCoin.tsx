// The official $SPORE strip, under the nav on every page but the map (owner 2026-10-19: "pin the
// official CA"): the one contract address to trust, shown in full and never middle-truncated, a copy
// button, the coin and pump.fun links, and the standing promise that Spore's share of the creator
// fees is collected, swapped into $SPORE and locked. One 40 px glass line on desktop, two rows on
// phones. Copying morphs the icon into a check and flashes "copied" inside the address pill.
import { useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { OFFICIAL_CA, OFFICIAL_NOTE } from "../lib/copy";
import { copyText } from "../lib/hooks";
import { useToast } from "./Toast";
import Term from "./Term";

const CopyIcon = () => <svg className="ic-copy" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><rect x="9" y="9" width="11" height="11" rx="2.5" /><path d="M15 9V6.5A2.5 2.5 0 0 0 12.5 4h-6A2.5 2.5 0 0 0 4 6.5v6A2.5 2.5 0 0 0 6.5 15H9" /></svg>;
const CheckIcon = () => <svg className="ic-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5" /></svg>;

export default function OfficialCoin() {
  const toast = useToast();
  const [done, setDone] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const copy = async () => {
    if (await copyText(OFFICIAL_CA)) {
      toast.success("Official $SPORE CA copied");
      setDone(true);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setDone(false), 1600);
    } else toast.error("Could not copy — select the address and copy it by hand");
  };
  return (
    <div className="official" role="region" aria-label="Official Spore coin">
      <div className="official-inner">
        <span className="official-badge"><i aria-hidden="true" />Official $SPORE</span>
        <span className={`official-ca-pill ${done ? "done" : ""}`}>
          <code className="official-ca" title="The official $SPORE contract address">{OFFICIAL_CA}</code>
          <span className="official-copied" aria-hidden="true">copied</span>
          <button type="button" className={`official-copy ${done ? "done" : ""}`} onClick={copy} aria-label="Copy the official $SPORE contract address" title="Copy the contract address"><CopyIcon /><CheckIcon /></button>
        </span>
        <Link className="official-link" to={`/c/${OFFICIAL_CA}`}>coin page →</Link>
        <a className="official-link ext" href={`https://pump.fun/coin/${OFFICIAL_CA}`} target="_blank" rel="noreferrer">pump.fun ↗</a>
        <span className="official-right">
          <Link className="official-fees" to="/fees">Spore's share buys &amp; locks $SPORE</Link>
          <Term k="creatorFee" icon text={OFFICIAL_NOTE}>Where Spore's share of the fees goes</Term>
        </span>
      </div>
    </div>
  );
}
