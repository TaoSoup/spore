// Logos of listed quote assets (the map's asset tops: USDC, WBTC, WETH, tokenized stocks, …).
//
// A coin quoted in a listed asset hangs under that asset's bubble (model.assetMapRef), and the bubble
// takes its logo from the asset mint's own metadata. Several of those mints carry no metadata image
// (USDC, WBTC and WETH among them), so their bubble had none. This asks the public Jupiter token list
// (tokens v2 search, no key, comma-separated mints) for the token's listed `icon`, for exactly those
// mints, once at boot and every 6 h, and stores it with model.setAssetIcons, which also registers the
// URL with the image proxy (model.knownImage). Nothing is drawn or made up here: a mint the list has
// no usable https icon for keeps no logo, and a mint's own metadata image always wins.
import { isAllowedImageUrl } from "./meta.mjs";

export const ASSET_ICON_URL = "https://lite-api.jup.ag/tokens/v2/search?query=";
export const ASSET_ICON_BATCH = 50;                 // mints per search call (measured 2026-10-21: 50 asked → 50 rows)
export const ASSET_ICON_EVERY_MS = 6 * 3600_000;
export const ASSET_ICON_TIMEOUT_MS = 6_000;
const MAX_URL = 1024;

const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

/** Asset mints (keys of model.assetFamilies()) whose mint metadata has no image: the ones that need an icon. */
export function assetMintsWithoutImage(model) {
  return [...model.assetFamilies().keys()].filter((mint) => !model.metaFor({ mint })?.image);
}

/** mint → icon URL from one search answer, for the asked mints only; a non-https, private-host or oversized URL is dropped. */
export function iconsFrom(rows, asked) {
  const out = {};
  if (!Array.isArray(rows)) return out;
  for (const r of rows) {
    const mint = r?.id, icon = r?.icon;
    if (typeof mint !== "string" || !asked.has(mint) || typeof icon !== "string") continue;
    if (icon.length > MAX_URL || !icon.startsWith("https://") || !isAllowedImageUrl(icon)) continue;
    out[mint] = icon;
  }
  return out;
}

/**
 * One pass: asks for every asset mint without a metadata image, in sequential batches of
 * ASSET_ICON_BATCH, and stores what came back in one model.setAssetIcons call. A failed batch keeps
 * the icons stored before. Returns { asked, calls, failed, found, changed }.
 */
export async function refreshAssetIcons({ model, fetchImpl = fetch, log = null, timeoutMs = ASSET_ICON_TIMEOUT_MS } = {}) {
  const mints = assetMintsWithoutImage(model);
  const got = {};
  let calls = 0, failed = 0;
  for (const batch of chunks(mints, ASSET_ICON_BATCH)) {
    calls++;
    try {
      const r = await fetchImpl(ASSET_ICON_URL + batch.join(","), { signal: AbortSignal.timeout(timeoutMs), headers: { accept: "application/json" } });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      Object.assign(got, iconsFrom(await r.json(), new Set(batch)));
    } catch (e) { failed++; log?.warn?.(`asset icons: batch of ${batch.length} failed: ${e?.message ?? e}`); }
  }
  const found = Object.keys(got).length;
  const changed = found ? model.setAssetIcons(got) : 0;
  return { asked: mints.length, calls, failed, found, changed };
}

/** Runs refreshAssetIcons at boot (after `bootDelayMs`) and every `everyMs`; both timers are unref'd. Returns { refresh, stop }. */
export function startAssetIcons({ model, log = null, fetchImpl = fetch, everyMs = ASSET_ICON_EVERY_MS, bootDelayMs = 0 } = {}) {
  const refresh = () => refreshAssetIcons({ model, fetchImpl, log })
    .then((r) => { if (r.asked) log?.info?.(`asset icons: ${r.found}/${r.asked} found, ${r.changed} new, ${r.failed} failed calls`); return r; })
    .catch((e) => { log?.warn?.(`asset icons: ${e?.message ?? e}`); return null; });
  const boot = setTimeout(refresh, bootDelayMs); boot.unref?.();
  const timer = setInterval(refresh, everyMs); timer.unref?.();
  return { refresh, stop: () => { clearTimeout(boot); clearInterval(timer); } };
}
