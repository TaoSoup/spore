// The agents in one line, for Home and Launch (redesign 2026-10-20, A11; elevated 2026-10-24 with
// the orbit glyph, a kind node on the "now" line and a glass skin): how many run and how many
// coins they launched, then a "now" line with the newest things they did (the API's titles), which
// rotates through the newest three every 6 s and holds still on hover, on focus and under reduced
// motion. Hidden until an agent exists.
import { useEffect, useState } from "react";
import { Link } from "react-router-dom";
import type { ActivityItem, AgentList, CoinRef } from "../../lib/api";
import { age, plural } from "../../lib/format";
import { useMotionPref } from "../SporeCanvas";
import { agentName, Icon } from "./bits";
import { hasJunk, kindPhrase, toneOf } from "./diary";
import { agentsCached, runState, type Loaded } from "./data";

const ROTATE_MS = 6_000;
type Now = { a: ActivityItem; root: CoinRef };

/// The API title verbatim, unless it carries JSON or a link: then "$SPREAD's agent · claimed fees".
function nowText({ a, root }: Now): { who: string; what: string } {
  const who = agentName(root);
  if (!a.title || hasJunk(a.title)) return { who, what: a.kind === "ai" || a.kind === "aifee" ? "paid its AI bill" : kindPhrase(a.kind) };
  return { who, what: a.title };
}

export default function AgentsStrip() {
  const [list, setList] = useState<Loaded<AgentList> | null>(null);
  const [i, setI] = useState(0);
  const [hold, setHold] = useState(false);
  const [paused] = useMotionPref();
  useEffect(() => {
    let alive = true;
    agentsCached().then((r) => { if (alive) setList(r); }, () => { /* no agents routes or the API is down: nothing to say */ });
    return () => { alive = false; };
  }, []);
  const agents = list?.agents.filter((a) => a.status !== "paused") ?? [];
  const recent: Now[] = agents.flatMap((ag) => ag.activity.filter((a) => toneOf(a.status) === "ok").map((a) => ({ a, root: ag.root }))).sort((x, y) => y.a.at - x.a.at).slice(0, 3);
  const n = recent.length;
  useEffect(() => {
    if (paused || hold || n < 2) return;
    const t = setInterval(() => setI((x) => (x + 1) % n), ROTATE_MS);
    return () => clearInterval(t);
  }, [paused, hold, n]);
  if (!list || agents.length === 0) return null;
  const live = agents.filter((a) => runState(a).state === "live").length;
  const launched = agents.reduce((s, a) => s + a.totals.launches, 0);
  const cur = n ? recent[paused ? 0 : i % n] : null;
  const t = cur ? nowText(cur) : null;
  return (
    <Link to="/agents" className="agents-strip" onMouseEnter={() => setHold(true)} onMouseLeave={() => setHold(false)} onFocus={() => setHold(true)} onBlur={() => setHold(false)}>
      <span className="agents-strip-ico" aria-hidden="true"><span className="agents-strip-orbit"><i /></span></span>
      <span className="agents-strip-text">
        <b>{plural(live, "agent")} live · {plural(launched, "coin")} launched by them</b>
        {cur && t && (
          <span className="agents-strip-now" key={`${cur.a.at}-${cur.a.kind}`}>
            <span className="agents-strip-now-tag mono">{Date.now() / 1000 - cur.a.at < 600 ? "now" : "latest"}</span>
            <span className={`agents-strip-k k-${cur.a.kind}`} aria-hidden="true"><Icon kind={cur.a.kind} /></span>
            <span className="agents-strip-now-text"><span className="who">{t.who}</span> · {t.what}</span>
            <time className="mono">{age(cur.a.at)}</time>
          </span>
        )}
      </span>
      <span className="agents-strip-cta">Watch the agents <span className="arrow">→</span></span>
    </Link>
  );
}
