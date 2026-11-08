import { useStreamStatus } from "../lib/events";
// Kept first in the import graph (App.tsx imports LiveDot), so discover.css keeps its place in the cascade.
import "./discover.css";

const STATUS_LABEL = { idle: "offline", connecting: "connecting", live: "live", reconnecting: "reconnecting" } as const;
/// The SSE connection state as a dot + word; used in the nav and above live lists.
export function LiveDot({ short = false }: { short?: boolean }) {
  const s = useStreamStatus();
  return <span className={`live ${s}`} title={`event stream: ${STATUS_LABEL[s]}`}><i aria-hidden="true" />{short ? null : STATUS_LABEL[s]}</span>;
}
