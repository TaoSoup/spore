import { useEffect } from "react";
import { Link, useLocation } from "react-router-dom";
import Search from "../components/Search";
import SporeCanvas from "../components/SporeCanvas";
import LostSpore from "../components/illus/LostSpore";

/// The SPA 404: the server answers every unknown path with the app, so this page is the only "not
/// found" a reader sees. A drawn lost spore (a colony whose filament broke, one spore adrift) above
/// the headline; it names the path, offers a search and the three things people come here to do, and
/// tells the one likely story (a coin link) where to go instead.
export default function NotFound() {
  const { pathname } = useLocation();
  useEffect(() => { document.title = "Page not found · Spore"; return () => { document.title = "Spore"; }; }, []);
  const tail = pathname.replace(/^\/+/, "");
  const looksLikeMint = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(tail);
  return (
    <>
      <SporeCanvas density={0.5} />
      <div className="container">
        <div className="nf">
          <LostSpore className="nf-illus" />
          <span className="eyebrow">404 · not found</span>
          <h1>This page didn't <em>grow</em>.</h1>
          <p className="lead">There is no page at <span className="mono">{pathname}</span>.{looksLikeMint
            ? <> That looks like a mint address: coin pages live at <span className="mono">/c/&lt;mint&gt;</span>. <Link to={`/c/${tail}`}>Open it as a coin page →</Link></>
            : " The link may be old. Find the coin by name, or pick up from one of the places below."}</p>
          <div className="nf-search"><Search size="md" label="Find a pump.fun coin by name, ticker or mint" placeholder="Find any pump.fun coin by name, ticker or mint…" /></div>
          <div className="nf-actions">
            <Link to="/map" className="btn ghost">Explore the map</Link>
            <Link to="/launch" className="btn accent">Launch a coin</Link>
            <Link to="/agents" className="btn ghost">Watch the agents</Link>
          </div>
        </div>
      </div>
    </>
  );
}
