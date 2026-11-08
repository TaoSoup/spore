
## STYLES lane (map3.css, bubblemap.css page block)

Decisions taken inside the styles lane's files (spec section 9), for the other lanes:
- Root rule is written `.m3.bm` (same element and specificity as the spec's `.bm.m3`) so every selector in map3.css starts with `.m3`; the only other prefix is `html[data-motion="paused"] .m3`.
- Docked tooltip: `.m3 .m3-tip.dock` is keyed on the `.dock` class alone, not wrapped in `@media (max-width: 700px)`. The engine adds `.dock` exactly when its container is ≤ 700 px (S.phone()), and the container can be ≤ 700 px while the viewport is wider (a classic scrollbar, for instance). A media query would then leave a docked card undocked at its stale translate. The rules match the spec: left/right 12 px, `bottom: var(--m3-dock-bottom, 64px)`, `transform: none !important`, `pointer-events: auto` when `.on`.
- Tooltip values (`.tp-v`) wrap, balanced, instead of ending in an ellipsis; `.tp-v.mint` stays on one line. The spec's Family row ("1,481 coins · 37% of locked value") is 218 px in Geist Mono 11 against a 153 px value column in the prototype's 248 px card. It now reads "1,481 coins · 37%" / "of locked value", and the card keeps the prototype's width. Measured in headless Chrome over a mock DOM.
- Tooltip text minimum 11 px: `.tp-chip` 11/14 with 1 px vertical padding (the same 16 px chip height as the prototype's 10/12 + 2 px), `.tp-v.mint` 11, `.tp-foot` 11/14, `.tp-logo` monogram 600 11px/1. In-map labels keep the prototype's sizes, weights and letter-spacing (13/12/11 px Geist, 10 px Geist Mono), which the engine's measuring table F must match.
- `.lb.evt .ev`: the prototype's `font:` shorthand is spelled out as longhands so the mono group's `tabular-nums` is not reset by it.
- `.m3 .tp-x` keeps the prototype's `!important` on colour and font-size; it has to beat `.m3 .tp-act button`.
- Under the OS reduced-motion preference, the app's global rule `@media (prefers-reduced-motion: reduce) { * { transition: none !important } }` (styles.css) wins over the shortened `--m3-t-*` tokens, so labels, the tooltip and the layer crossfade switch instantly. Under the site's own toggle, `html[data-motion="paused"]`, the shortened durations apply (lab-in 100 ms, layer 100 ms, tip delay 0). This is the site's policy and was left alone.
- Label class contract: the engine must emit `lv`, not `live`, for recently traded children. The app's global `.live` (styles.css:260: inline-flex, mono, lowercase) would otherwise restyle the label.
- bubblemap.css gained one page-level rule, appended under `/* map3 (page level) */`: `.map-page .bm.bm-full[aria-busy="true"] { background: #0b0e0d; }`. It paints Map.tsx's Suspense placeholder (spec 7f markup) in map3 graphite, not the classic green gradient, while the lazy chunk loads. Nothing else on /map sets aria-busy on a .bm.

## ADAPTER lane (adapter.ts, use-engine-sync.ts, debug-hooks.ts)

Interface details the spec left open, decided here (the other lanes code against them):
- EngineDebug index convention (engine lane): every number that names a coin is a COIN index usable with `mintAt(i)`, and -1 means none. That covers `selected()`, `hovered()`, `hoverTop()`, `children()`, `members()`, `topOf()`, `families(n)[k].top`, `pick().i` / `pick().top`, `titles()`, `taggedTitles()`, `drag().i` / `drag().top` and `tip().i`. `hoverTop()`, `pick().top`, `families().top` and `drag().top` are the family TOP coin's index, never a family id.
- `EngineDebug.families(n)` is called with n = `coins()` by the `sample()` hook. It must clamp to the family count and return families by value, descending (planets first).
- `dragCoin(key)` and `hover(key)`: a mint the engine draws is passed as its index. Anything else is passed through as a string (a ticker), which the engine resolves as the prototype's famByKey did.
- Clocks: `lastInteract()` and `builtAt` may use either clock. A value above 1e12 is read as epoch ms, anything else as performance.now(). ThreeMap uses performance.now() for both.
- Drift (5.8):
  - `firstSyncAfterCache` = firstBuildFromCache, AND the first engine of the mount, AND less than 120 s since that engine's build.
  - onDrift fires at most once per 60 s per engine.
  - While the count threshold is met but the map is not idle (or not old) enough, the pass re-checks every 2 s even when no data arrives.
  - `coins` = nodes.length.
- diffNodes:
  - The hook seeds DiffState empty. The first pass records every coin the engine knows and sends no patches.
  - A known coin seen for the first time (a birth the engine placed, for example) is recorded, not patched.
  - A birth is offered again on every pass until `knows()` turns true; the engine dedupes.
  - A child of a coin born in the same pass waits one pass, because its parent is not known yet.
  - `removed` = recorded coins that are no longer in the node list.
- dataMs is recorded for each node pass, each heat conversion plus setHeat, and each stream event (applyEvent included).
- Debug values while no engine is mounted:
  - `zoom()` returns 0, not the handle's 1, so a script never reads "at overview" before a build;
  - `frameStats()`, `camera()`, `engine()`, `gl()`, `tip()` and `worker()` return null;
  - counts return 0 and lists return [].
- Other debug values:
  - `worker().settled` = `!sim().active`;
  - `node(mint)` = the latest BubbleNode from the page's byMint (or `{mint}` for a birth the page does not hold), plus engine world r/x/y;
  - `allXY()` converts the Float32Arrays to plain arrays (they survive CDP returnByValue).
- Page px = root.getBoundingClientRect() + root.clientLeft/Top + engine container px. The layer fills the root's padding box.

Measured (scratch scripts in SCRATCH/adapter-check, not in web/):
- PROTO/map.json through normalise and buildRoots:
  - 21,301 coins, 2,228 roots (fixture 2,228), cyclesBroken 0, max depth 3;
  - the pre-order matches the fixture's DFS exactly, and the coin objects are the BubbleNodes themselves.
- buildRoots takes 4-6 ms.
- familyShares vs dominance() byTop share:
  - locked: 2,152 priced families, 2,152 bit-identical, max delta 0;
  - mcap: the same.
- heatPayload round trip on PROTO/heat.json: 4,848 rows equal.
- A diffNodes pass over 21.3k nodes with 200 changed identities and 5 births takes 0.69 ms p50 and 2.36 ms max (node 24, M4).
- Warm-cache order (not fixable in this lane):
  - lib/map/cache.ts loadCache returns IndexedDB getAll(), which is in mint-key order, and useMapData keeps that insertion order.
  - So on a warm (returning) visit, buildRoots does not get the server DFS. Simulated on the fixture: 0 of 21,301 coins keep their index, 2 of 2,228 roots keep their position, and 982 of 2,869 parents get a different child order.
  - The engine's index-seeded jitter and family ids therefore differ between a cold and a warm visit. The same planets are chosen, by value, but the inner arrangement and the per-family rotation change.
  - The QA shots use a fresh profile, so the cache is cold and they match the prototype.
  - Fixing it needs a change in lib/map (keep the server order in the cache, for example a stored sequence number). That is the lead's call.

## REACT lane (types.ts, probe.ts, ThreeMap.tsx, pages/Map.tsx, map/panel/MapKey.tsx)

Interface details the spec left open, decided here:
- Clocks: `builtAt` (passed to useEngineSync) and `lastInteract()` are performance.now() ms. lastInteract starts at 0 (never touched = idle since page load).
- Idle tracking: besides pointerdown / wheel / touchstart (spec 6.5), ThreeMap also counts pointermove on the root and every onCamera report of the engine on screen (flights, inertia, drag-pan: the spec's "flight/drag activity"). A hovering pointer therefore holds off a drift rebuild.
- Engine callbacks act only while their engine is the one on screen. A pending engine's first-frame onCamera is dropped; ThreeMap reports `{k: h.zoom()}` itself right after the swap. onFirstFrame sets firstPaintAt once per mount (not for an aborted build).
- A resolved build whose container changed size meanwhile gets `h.resize()` at once. Insets and obstacles reach a new engine through the layout effect keyed on the engine (same commit as the swap), not through a call in the promise callback.
- Obstacles are re-read without a prop change too: a ResizeObserver on every matched element plus a MutationObserver (childList only) on `.map-page` and `.map-overlay` (a popover, toast, sheet or side panel added or removed), coalesced to one `setInset` per animation frame.
- Select echo: runs on `[select, engine, nodes]`, not only `[select, engine]`. On a nodes change alone it never re-flies; it only (a) selects-and-flies a selection that was waiting for its coin to arrive (a birth the engine places later), and (b) asks for a select-unknown rebuild. That rebuild is at most once per 30 s and never twice for the same mint (a coin the engine still does not know after a rebuild would otherwise rebuild every 30 s).
- `focusNode` and `fitCluster` call `onSelect` only with a node the page holds. The spec's `byMint.get(mint) ?? null` would clear ?focus while the engine keeps its ring.
- Rebuild requests for drift and select-unknown are ignored while a build is pending; a context loss always goes through (at most 2 per mount, the 3rd loss → onFallback("context-lost")).
- Engine exceptions inside ThreeMap's own effects (resize, setInset, select echo) are logged as `console.error("map3", e)`, at most 3 per mount, like use-engine-sync. The fallback path logs exactly one `console.warn` in ThreeMap (it carries the error object). Map.tsx's onFallback logs its own warn (spec 7c), so a fallback shows 2 warns and 0 errors.
- `lastBuild()` = `{reason, ...h.debug?.build()}`; reason is "first" | "mode" | "limit" | "band" | "select-unknown" | "drift" | "context", derived by comparing the new key with the engine on screen.
- MapKey "three" body:
  - The coin reference circles use the existing `sizeRefs()`, but only for values ≥ $10k (below that the engine draws coins on a steeper scale than rad()) and only where `worldRadius(v) > worldRadius(v/2)`. At the engine's rad() cap (about $16M) every larger value has the same radius, and sizeRefs would otherwise label that one circle "$50B".
  - The chip svg reuses `.map-key-size` (existing class): three circles side by side at chipRadius(0.25 / 0.05 / 0.01), labelled with sharePct.
  - The Keys section is now one shared const used by both bodies. The classic markup is unchanged: old vs new MapKey through renderToStaticMarkup, 4 of 4 cases byte-identical (pop locked, pop mcap, dock open, dock closed).

Requests to other lanes:
- ENGINE: setInset() during a running flight. On a click on an unfocused family, the engine flies (famTarget against the old inset rect) and calls onSelect. The page then opens the side panel (wide) or the peek sheet (phone), and ThreeMap calls setInset with the new inset in the next commit, while the flight is still running. Please retarget the running flight against the new inset rect (famTarget/coinTarget recomputed), rather than start a competing "keep the selected coin visible" ease or keep the stale target. Otherwise QA 13.3 (c) ("≥ 80 % of members inside the inset rect") and (k) (the selected coin between the overlay and the sheet) depend on timing.

## REACT lane (addendum: build key rule + measured)
- Build key: `lastBuild().reason` compares against the last build STARTED (aborted ones too). A key that goes away and comes back while its build is pending (mode toggled twice quickly) aborts that build and starts nothing; the engine on screen already has that key.
- Lifecycle harness (scratch only: SCRATCH/react-lane-check/harness). The real ThreeMap, adapter, use-engine-sync and debug-hooks run with a mock engine and a mock lib/events, under React.StrictMode in Vite dev, with headless Chrome over CDP, in real time. Result: 34/34 checks pass on 3 consecutive runs. Checked:
  - StrictMode mount: created 1, live 1, one .m3-layer.
  - Mode rebuild: the old engine is destroyed after the fade; reason "mode".
  - A double toggle while building: the pending build is aborted and builds() is unchanged.
  - "Building the map…" shows only after 300 ms and goes away when the build lands.
  - setInset runs before select(fly) in the same commit, and the side panel counts as an obstacle.
  - An engine click: onSelect reaches the page and the echo is a no-op. An empty click clears ?focus.
  - fitCluster, focusNode, scaleBy, panBy, hoverNode and fit reach the engine.
  - Band rebuild: 300 ms debounce, reason "band".
  - Context loss: 2 rebuilds, then the 3rd loss gives onFallback("context-lost").
  - Unmount during a build, and during the 160 ms fade: live 0.
  - ?m3fail gives onFallback("mount-error") with exactly 1 console.warn.
  - 5 mount/unmount cycles: live 0, created = destroyed, 0 stream subscriptions left, 0 console.error.
- probe.ts in headless Chrome 155:
  - --disable-gpu: false, with 0 console or Log entries;
  - --use-angle=metal --ignore-gpu-blocklist: true;
  - --disable-gpu --enable-unsafe-swiftshader: true.
  - The second call is memoised.

## QA lane (test/map3-*.mts, test/serve-prod.mts, test/README.md, renderer pins in map-ui/perf/interact/sync)

Interface details the spec left open, decided in the QA scripts (they only read the hooks list):
- Renderer reads: `__sporeMapPage.renderer()` when it is a function, else "classic" (a pre-map3 build); `fallback()` likewise, else "n/a". map-ui asserts the renderer after every load (`renderers` in its JSON).
- Chunk detection: a resource matching `/assets/…(ThreeMap|three.module|three.core|three-)…\.(js|css)` is "the map3 chunk". map3-qa (a) fails when nothing on /map matches it, so the "no chunk on / and /c/<mint>" checks cannot pass vacuously. (a) also fetches `/assets/index-*.js` and fails if it contains "WebGLRenderer".
- (c)/(e)/(j)/(k) click points come from `pick(x, y)` plus `document.elementFromPoint` being `.m3-canvas` (labels and the tooltip must keep pointer-events off, except the docked card). A planet chip is any point where `pick().cluster` is the family top, tried at `screenOf(top)` first, then `familyScreen(top)`.
- (f) planet labels are `.m3 .m3-labels .lb.pl`; a tagged one reads `<tag> · N coins`. (h) the birth toast is any `.m3 .m3-labels .lb` whose text contains "new ·". (k) the dock buttons are `.m3 .m3-tip.dock.on button` matching /open family|select/i. (e) the tooltip must contain "Market cap".
- (g) counts the mask with the raw `__sporeMap.eng.coins()` / `eng.hlBit(i)`, compared to `__sporeMapPage.hlCounts().ours`.
- (h) "a trade on a visible coin": tried on the largest visible child (sample order), then a visible planet top, then the next child; it passes on the first that lights `fx()` within 300 ms with `lastTrade` advanced. Every attempt is in the JSON.
- (l) and map3-perf's reduced-motion check require `motion().reduced === true` and `motion().renders` unchanged over the window; a window in which `sync().heatAt` moved (a 60 s heat poll that recolours coins) is re-measured once (qa) or excused (perf).
- (n) also checks that `window.__sporeMapPage` is gone after each unmount and that `__sporeMap3.counters().live === 1` after the last return.
- map3-perf "idle renders over 10 s ≤ 25" is measured on a second page with the EventSource mocked (no events), because live trades legitimately render; the live page's renders over its first 10 s are reported. Warm first paint is gated for both the SPA reopen and a full reload.
- map-ui under `--renderer three`: (g) expects `?roots` to stay unset on a phone deep link; no check is skipped (`skippedUnderThree` stays empty).

## ENGINE lane (engine/*.js, engine/index.d.ts, package.json + lockfile: three, vite.config.ts optimizeDeps)

three@0.169.0 is installed (exact pin in package.json). The engine is JavaScript behind index.d.ts (spec text, unchanged); TS
resolves `./engine/index.js` to the .d.ts (checked with a scratch tsconfig extending tsconfig.app.json: 0 errors, the JS is
not parsed). Interface details the spec left open, decided here:
- Engine indices: 0..N-1 are the built coins, N.. are newborns (bubbles' 512 spare instances). `mintAt`, `indexOf`,
  `world`, `screen`, `select`, `hover`, `knows`, `topOf` accept both. `families(n)` clamps to the family count and is
  ordered by value (desc). `pick(cx, cy)` takes container px; `via` is 'chip' | 'coin' | 'speck' | 'colony' | 'none'.
- `build()` returns the build numbers (buildMs, firstFrameMs, layoutMs, linksMs, bubblesMs, dustMs, labelsMs,
  labelsFontMs, compileMs, coins, families, planets, dust, linkVerts, three, ...) plus live gpu / dpr / w / h /
  contextLost / reduced / feed (primitives only).
- `fx()` = pulses in flight (links slots) + flashes / rims / pings / dust pings / births started < 1.5 s ago.
- `lastTrade(i)` is epoch ms (0 = none). `settled()` = no flight, tween, inertia, eased zoom or drag simulation, and the
  camera still for 120 ms.
- Hover sources: a pointer hover calls onHover on every change; `hover(mint)` (page) pins the hover (ring, lineage after the
  dwell, the card at the coin when it is on screen) until `hover(null)` or the next real pointermove, with no echo; a
  flight / grab / pinch that ends a POINTER hover calls onHover(null). A newborn hovered or selected by the page shows its
  ring only (newborns have no tooltip data).
- `setInset` during a flight retargets the flight against the new rect (family flights, coin flights and the overview
  flight), as the react lane asked. At the overview it eases to the new fit (snaps under reduced motion); otherwise a
  selected coin outside the inset rect is eased to the rect's centre. A family / coin flight that ends with the selected
  coin outside the inset rect eases it in as well (never after the overview flight, so fit() stays the overview).
- Framing: famTarget / coinTarget centre on the inset rect (6 px from the container edge), and a coin too small in its
  family's framing is centred at 14 px in the inset rect's centre.
- Heat: a build without heat (heat null) applies the first real payload whatever its `at`; that first payload sets classes
  only (no pulses, no newly-live rim flashes: its trades are not news).
- Context loss: S.contextLost stops the loop; onLost fires after 3 s, or at once on contextrestored. destroy() after a loss
  deletes no GPU object (they belong to the old context) but still runs renderer.dispose(); forceContextLoss() only when the
  context is not lost at that moment. 0 console messages on both paths (measured).
- Logos: `want(url, 256)` for planet tops, `want(url, 128)` for the others, lo first then hi, and inside each group the most
  important coin LAST, so the loader (newest want first) starts with $PUMP's chip. A coin drawn from a smaller thumbnail
  stays pending and is redrawn when the sharper one lands. The atlas uploads at most every 400 ms and renders once per
  upload (the prototype rendered every frame while an upload waited out its throttle).
- The scene's programs compile with renderer.compileAsync() before the first frame (first-frame task 36-59 ms instead of
  about 380 ms cold).

## INTEGRATOR (2026-10-21)
Changes made while running the gates (all measured on the M4, headless Chrome 155, metal, production build behind
test/serve-prod.mts with the live upstream unless noted):
- MapKey.tsx, RefCircles (three Key only; the classic SizeKey is untouched): the box was a fixed 72 px with the
  label stack pushed 11 px apart from the circle tops, so at the overview (coin radii of a few px) the circles sat at
  the bottom of an empty band and the 2nd/3rd labels ran past the bottom edge ($1M clipped). The box is now as tall as
  its content (max(2·rMax + 4, 11·n + 6)), the stack is clamped inside it, the leaders start at the largest radius.
- test/map3-cdp.mts RAF_PROBE/rafStatsJs: frame intervals from the rAF timestamp; performance.now() in the callback is
  kept as cbP95/cbMax. Measured on "/" (no map): callback p95 18.4 ms vs timestamp p95 16.7 ms.
- test/map3-qa.mts (l) and test/map3-perf.mts: idle renders are counted after the logo queue drains (+1.5 s); each logo
  arrival is one upload render. Steady state measured: 15 renders/s at the overview (the prototype's documented
  design), 0 under reduced motion (OS setting and html[data-motion=paused]). map3-perf's idle gate is ≤ 160 / 10 s.
- test/map3-qa.mts (l) opens the site first when run alone (--only l started on about:blank: localStorage denied).
- test/map3-shots.mts: + h-phone-tooltip, f-hover, g-hover-child-4x, mid-drag-overview, mid-drag-4x.
Not a bug, checked: on a live stream the engine's events equal the raw EventSource messages (89 = 89 cold; 35 = 33
trades + 2 pairs after 3 SPA cycles) on one /api/events connection. After 3 SPA cycles and a double GC nothing of the
map survives (0 WebGL2 contexts, 0 m3 canvases, observers back to the home page's 1/0).

## FINAL FIX (2026-10-21, after the two critics)

The reference for the finished renderer is `README.md` in this folder. Changes made after the integrator:
- Logos: `lib/map/images.ts` paces starts with a token bucket (burst 120, then 12.5/s, 16 in flight) instead of one
  start per 80 ms (8 in flight). Warm proxy: 114 of 122 logo cells drawn 0.5 s after map-ready (was ~10 s).
- Labels: planet labels and callouts may not sit on, or lead across, another family's colony beyond its outer 30 %
  rim; `labelStats().foreignColony` (QA gate 0). Tooltip Family row back to the prototype's one line ("1,481 coins · 37%";
  the paragraph about the wrapped row in the STYLES lane above is superseded).
- Phone: a docked card glides its coin up above it (`S.motion.keepAbove`); the +/- column hides while the card is up;
  contextmenu / touch callout / user-select suppressed on the stage.
- Battery: breathing + rim shimmer sleep 30 s after the last input (`BREATH_SLEEP_MS`), so an idle map renders at 2 Hz
  (spec gate ≤ 25 per 10 s restored for the asleep state; awake stays the prototype's 15/s).
- Quality governor (motion.js): DPR 2 → 1.5 → 1 → bloom off when back-to-back frames run under ~42 fps.
- Build: layout.js family loop and links.js geometry yield every 40 ms of work (async, same computation and order).
- Safety: `guard.tsx` (error boundary around the lazy ThreeMap; sticky fallback per build for 24 h; kill switch
  `/map-renderer.json`); FallbackReason gained "off" and "sticky".
- Tests: the adapter fixture is committed (`test/fixtures/map3-sample.json`); map3-shots takes `--ref` / `$MAP3_PROTO`
  and `--live-url`; map3-qa checks foreignColony, the docked card, the kill switch and the sticky fallback; map3-perf
  gates awake / asleep idle renders and the governor.

## galaxy — layout+veins (2026-10-21, 14:09Z–14:27Z)
Files: engine/layout.js, engine/links.js (engine/index.js: 0 changes). Flat path untouched: every change is behind
`const G = S.look === "galaxy"` / `#ifdef GALAXY` (material.defines = { GALAXY: 1 } only under galaxy); tokens read via
`const T = S.tok || TOK` with the spec's literals as fallbacks; uLook/uAnimT/uGalT/uFlow are taken from S.U when present,
else local stand-ins ({0,0,0,1}) inside the materials (spread after ...U so S.U wins once state.js has them).
- layout.js (P0 done): `layoutFamilyGalaxy(f)` = the monolith's radial tidy tree (d3 tree, separation
  (R[a]+R[b]+GAP)·(sameParent?1:1.35)/max(1,depth), GAP 0.7, GAPR 2.4, first ring ×1.6, step 2·maxR+1.4·GAP, sub-rings
  S=1..4 only when n>3S, accepted when outer<0.85×previous, rot = rnd(f.id,5)·TAU), used for EVERY family when G.
  Sets f.bandIn/bandOut (first/last sub-ring centre radius, as the reference), f.ring (mean), f.count, f.arcR (gutter below the
  band, flat-style consumers), f.genSpan = [[0,TAU]], f.noArc all false, f.coreR = R[top], f.Rc = last bandOut + last maxR
  (tight), f.layoutMode "galaxy". X/Y/TH/NR/DEP semantics unchanged; planet packing, dust placement and separate() untouched.
  S.debug.map.galaxyLayout = {subRingBands, maxGens}.
- links.js (P0 done): per-vertex `aW` = (world width tapered w0=GAL.linkW0(R[child]) → 0.32·w0, notable flag); GALAXY VS width
  wpx = aW·uPx floored mix(1,2.5,uGalT)·dpr, cov clamp(wpx/floor,0.42,1), cap 14·dpr, hw = wpx/2+0.6·dpr; colour
  GAL.link[class]×GAL.linkK (HDR, blooms), alpha (notable?0.70:0.42)·cov·mix(1,uDustExpand,isDust)·mix(0.55+0.45·notable,1,uGalT),
  hover ×(1+1.6·uDimMix) (others × dim), planet families keep max(ovT, 0.30) at the overview, births draw on (uGrowC), focus
  dim / fade / highlight / debugSolid shared with flat; vLive = 1 (additive). GALAXY FS flow: 28 px dash train
  parent→child, speed 0.9·(live 1.5 / cold 0.5 / else 1)·uFlow, amp mix(0.15,0.45,uGalT) (modulates a; additive ⇒ colour).
  Born links carry aW too (w0 from the child's radius).
- links.js (P1 done): gen rings — arcInfo under G = a full ring at f.ring[d] for every family with ≥2 generations (planets at
  every zoom: 0.16·smoothstep(0.12k0,0.5k0,k), hovered/focused ×2.5; dust families × uDustExpand, 48 segments, only ≥4 members),
  colour 0x1bbe93 additive, knock-outs kept, uArcOff/uArcFade apply to the tagged family only. aR is now vec3 (r, Rc, isDust)
  in both looks (flat reads .x/.y, same values). Orbit circles: a new mesh `orbits` (galaxy only, S.debug.obj.orbits):
  one 96-segment hairline per planet at 1.04·Rc, 0x5ce0c8, 0.75 px, alpha 0.10·(1−0.6·uGalT)·uFadeP, additive, renderOrder 3
  (the retired hull mesh stays as it is: a single uniform-driven circle cannot draw 60 orbits). `S.debugFns.linkMaxPx()` under
  G = min(14, max(1+1.5·uGalT, 1.4·S.cam.k)) CSS px.
- links.js (P2 done): `S.links.lightPath(i, nowSec)` walks par[] from coin i to the top, writes each link into the lit slots
  (uLitC/uLitT, 24, oldest reused); GALAXY VS: gain 1+0.8·clamp(1−(uTime−t0)/1.1) and colour forced lime×1.9 while lit; the
  existing invalidation loop keeps rendering while slots are fresh. No-op in flat (returns 0). motion.js must call it.
- Measured (scratch build with a local copy of state.js carrying the look plumbing, serve-prod --fixture mapThree, Chrome
  metal 1440×900): galaxy overview: 0 console errors, look "galaxy", linkMaxPx 1.0, titles 32, overlaps 0, foreignColony 0,
  lime 0.0025, linkVerts 850,166 (flat 651,160), linkCount 19,073, genArcVerts 100,190 over 653 families, orbitFams 60,
  layoutMs 59–67 (flat 194–196), linksMs 99 (flat 83), buildMs 616–1019 (flat 693), Rcl 1032 u (flat 276 u). $PUMP 4×:
  linkMaxPx 1.919, gens 5 (GEN labels shown), overlaps 0, hdrPx 1934 / offenders 0, renders in 500 ms idle: 67. Flat on the
  same build: linkMaxPx 1.2, hdrPx 0 (overview), lime 0.00033, titles 32 / 2, gens 0, 0 console errors — equal to
  test/shots-map3-final/map3-shots.json (a-overview, b-pump-4x) except hdrPx 12 at b (baseline 0; flat code untouched, likely
  a live core's bloom timing — QA's pixel parity decides). Shots: <scratchpad>/gal-layout/shots/{a-overview,b-pump-4x}-galaxy.png.
- Open / for the integrator: (1) the galaxy planet cluster is 3.7× wider in world units (Rcl 1032 vs 276), so k0 ≈ 0.34 at
  1440×900, NOT ≈1 as the spec's px examples assume: at $PUMP 4× S.cam.k ≈ 1.37, every vein lands on the 2.5 px floor
  (uGalT=1) and only an R=7 child reaches 1.9 px raw — the reference's thick veins need GAL.linkW0 (or the floor/cap) scaled
  by ~2.5–3, a token decision (planets lane owns tokens.js). (2) hdrCheck at the galaxy overview reports 1800 offenders
  (5105 hdrPx): HDR veins/orbits outside family discs; scene.js owns the galaxy hdrCheck rule. (3) uGalT/uAnimT/uFlow were
  constant (0/0/1) in my scratch run (motion.js not yet landed), so flow/opened-floor are untested in motion; shader compiles
  and draws. (4) orbits do not follow a dragged family (same as the retired hull). (5) P1 dust-family rings skip families
  with < 4 members (vertex budget: 100k ring verts total).

## galaxy — labels+legend+react (2026-10-21, 14:09–14:30Z)

Files: engine/labels.js, engine/index.d.ts, map3.css, ThreeMap.tsx, types.ts, debug-hooks.ts, src/pages/Map.tsx,
src/components/map/panel/MapKey.tsx (adapter.ts untouched).
- Plumbing: Map.tsx reads `?look` ONCE (`useState`): "flat" → flat, anything else → galaxy (default); passes `look` to
  `<ThreeMap>` and both `<MapKey>`s. ThreeMap passes `look` to mountEngine (not a BuildPart) and puts `look-galaxy |
  look-flat` on the root div. index.d.ts: EngineOptions.look, EngineDebug.veinShare(). debug-hooks: `__sporeMap.look()`
  (build().look, else the root's look-* class) and `__sporeMap.veinShare()`.
- labels.js (`const G = S.look === "galaxy"`, flat strings byte-identical): planet title line 2 `1,481 · 37%` (count, then
  the dominance tag; `N coins` without a tag), caption `+N small trees · X% of <mode word>`, GEN tags on EVERY family
  with f.Rc·k ≥ 220 px (flat: the focused family only), centred 1.2 u above `f.bandOut[g]` at 12 o'clock (the existing
  ±6° slide when blocked), measured with the 600 weight the galaxy CSS uses. `labelStats().gens` already existed.
- MapKey: `look` prop; galaxy key = traded < 30 min (lime, glow) / cooling < 3 h / quiet < 24 h / cold, "ring = 24 h trades
  · size = market cap (log)", then the shared Size / Motion / Drag / Keys sections; flat key renders the same DOM as before.
- map3.css: only `.m3.look-galaxy` rules (heat tokens, bg #07100b, .lb.gen teal 600 mono, .lb.cap #8ea596).
Measured (scratch build of the whole tree at 14:24Z, mapThree fixture, Chrome metal 1440×900, `?debug`): galaxy —
look() "galaxy", engine().look "galaxy", titles 32, $PUMP "1,481 · 37%" at the overview and at 4× (regex
^\d[\d,]* · .+%$ true), caption "+2,168 small trees · 6.2% of locked value", 4× gens DOM = GEN 1 · 136 / GEN 2 · 1,255 /
GEN 3 · 89 (+ GEN 2 · 12, GEN 2 · 5 of two neighbours ≥ 220 px), labelStats 4× {planets 5, gens 5, overlaps 0,
foreignColony 0}, 0 console errors; legend DOM shows the four galaxy rows (+ the ring row), swatch glow 0 0 8px.
flat (`?look=flat`) — look() "flat", "37% · 1,481 coins", "+2,168 smaller families · …", legend rows unchanged
("within 30 min" …), bg #0b0e0d, 0 console errors. tsc -b 0 errors; COPY_STRICT npm test 50/50; node --check ok.
Open: (1) families ≥ 10k members would print "12.3k · 37%" (fmtCount), outside the QA regex — none in the fixture;
(2) in flat the $PUMP planet label is not `.on` at 4× (pre-existing; QA should read the flat title at the overview);
(3) GEN tags on small neighbours at 4× follow the spec's ≥ 220 px rule — restrict to `f.planet` in labels.js if noisy;
(4) the dock's "ring = 24 h trades · size = market cap (log)" row wraps to two lines at 150 px.

## galaxy — planets+dust+bloom (2026-10-21, 14:09–14:30Z)

Files: engine/tokens.js, engine/scene.js, engine/bubbles.js, engine/dust.js (nothing else touched). Flat parity by construction:
every JS change sits behind `const G = S.look === "galaxy"` (undefined → flat), every GLSL change behind `#ifdef GALAXY … #else
<today's code> #endif` with `defines: G ? { GALAXY: 1 } : {}`; `TOK` is frozen and untouched; modules read `const T = S.tok || TOK`
(flat: T === TOK). New uniforms (uAnimT/uGalT/uFlow/uLook/uHeatK/uBirthCol) are declared in both looks and read only under GALAXY;
each material carries local fallbacks for uAnimT/uGalT/uFlow/uLook that `...S.U` overrides once state.js (anim lane) lands them.

- tokens.js: `GAL` pasted verbatim from spec §2; `GALTOK = Object.freeze({ ...TOK, ...GAL })`; `tokensFor(look)`.
- scene.js: galaxy clear/bg 0x07100b, vignette 0x0a1710 → 0x050c08; bloom = phone ? GAL.bloomPhone : GAL.bloom (0.72 / 0.42 / 0.85,
  phone 0.60); bloomTintColors mips 3,4 muted only under flat; `S.debug.map.bloom` reports the settings + look. `hdrCheck()` under
  galaxy counts offenders only OUTSIDE every family disc (grid of 48 px cells; disc = max(f.Rc·k, planet chipR + 6) + 3 px, dust
  families + their drift reach (5 + 0.45 Rc) u); reports `famPx` (HDR inside discs) and `look`. NEW `S.debugFns.veinShare()`:
  links mesh alone (every other Mesh/Points hidden, bloom off, black clear) rendered to the canvas, pixels inside the focused
  family's disc (uFocusFam ≥ 0, else uHoverFam, else planets[0]; r = f.Rc·k) with max(r,g,b) ≥ 64 → {share, px, lit, fam, sym, rPx, look};
  restores visibility/bloom/clear colour and invalidates. Works under both looks.
- bubbles.js (GALAXY): lit spheres from 3 px (vT.x = smoothstep(2.6, 3.4, rc)): n = (p, sqrt(1−|p|²)), L = normalize(−0.45, 0.55, 0.75),
  dif / spec pow 22 / fresnel pow 2.6; heat colour = GAL.rim[class] × heatK (HDR, crossfaded in time, pushed toward the pulse colour
  on a flash); plain body b = hc·0.82: b(0.55 + 0.55 dif) + 0.22 spec·min(1, hc + 0.3) + 0.55 fres·hc; logo: atlas(0.78 + 0.32 dif) +
  0.28 spec + 0.9 fres·hc (raw atlas colour, no sat/val tint); hover × 1.35 + white sweep band 0.5·exp(−((p.x − mix(−1.2, 1.2, hoverT))/0.25)²);
  no 0.92 cap, no core pin, no radius breathing / rim shimmer in galaxy; brightness breath on uAnimT: live × (0.75 + 0.35 sin(1.9 t + φ)),
  others × (0.9 + 0.1 sin(0.8 t + φ)), φ = rnd(i, 3)·τ, amplitude × uBreath (0 under reduced motion / asleep → steady 1.0).
  24 h rim = full annulus outside the disc [R + 1.3 dpr, + (0.5 + 0.7·level) dpr], level from aA.y (log sweep → n24: 0 / <20 / <200 /
  <2000 / else), colour hc × 1.15, alpha 0.95; quad extent grown for it. Birth ripple (existing aBirth): ring 1.0 R → 3.5 R over 1.2 s,
  0.25 R wide, alpha 0.6 → 0, 0xe9ffc9 × 1.3 additive (the discard test is max(a, rgb) under galaxy so additive fragments survive).
  Coronas: `S.bubbles.glows` InstancedMesh (galaxy only, else null), renderOrder 1, AdditiveBlending, two instances per planet:
  core r = 5 coreR (screen floor coreMinPx(share, maxShare)·2.6 dpr), alpha 0.30·(1 − 0.7·smoothstep(0.5 k0, 1.6 k0, k)) × breath;
  hull r = 1.1 Rc, alpha (live 0.045 / 0.025)·(1 − 0.6·smoothstep(0.8 k0, 3 k0, k)); family heat = min class over members (refreshed
  once a second from `cls`); FS g = exp(−4.2 d²)(1 − smoothstep(0.85, 1, d)); hover dim / focus dim / uFadeP like the bubbles; both
  follow S.X/S.Y of the family top every frame (drags carry them). `S.bubbles.flashCorona(i, tSec?)`: core alpha × (2 − t/0.6) for
  600 ms (motion lane calls it). `S.bubbles.look` = "galaxy" | "flat".
- dust.js (GALAXY): specks colour GAL.rim[class] × 0.9 heatK (live 1.71 → HDR, blooms), alpha 1 / 0.8 / 0.8 / 0.5, diameter
  max(2.6, 2.4 coreR) u clamped 1.6–56 dpr, every speck additive; drift in WORLD u on uAnimT: (sin(t sp + φ), cos(0.8 t sp + 1.3 φ))
  · (5 + 0.45 Rc)·(1 − uDustExpand)·uFlow; parallax as a lag on PANS: p += uCam·depth·(1 − uDustExpand), depth 0.04–0.14 (zero at
  the overview centre, so hit-testing holds there; a true "toward the centre" parallax would move specks 15–50 px off their hit
  positions). Nebula blobs: rnd(f.id, 7) < 0.12 of the dust families, instanced additive quads r = 6 Rc + 40 u, teal if f.age ≤ 3 h
  else 0x6a54b0, alpha 0.05 × the field's edge feather × (1 − 0.7 uDustExpand) × uFadeD. Ambient field: 6000 points (phone 2500)
  in a disc 1.5·max(Rout, Rcl), depth 0.25–0.85, size 1.2–3.4 px × clamp(k/k0, 0.75, 2), drift 3–11 u, 60 % teal / 40 % 0x8a6fe0,
  alpha 0.05 + 0.12 (1 − depth), never fades, renderOrder 0, FS exp(−3.2 d²) additive. `S.overview.nebula / ambPts`,
  `S.debug.obj.glows` (= nebula), `S.debug.map.galaxyDust = {nebula, ambient, ambientR}`. placeDust and the Rvis dissolve unchanged.

Measured (scratch build of this tree with a scratch-only state.js stub for S.look/S.tok/uAnimT=0, fixture SP/mapThree, Chrome metal,
1440×900 DPR 1, `?debug&look=…`), 0 console errors in every run:
- galaxy a-overview: hdrPx 5341 (bubbles layer 5195, layer 1 = dust/glows 127, links 6), famPx 5331, offenders 10 (lime 1.7 dust
  specks 11–14 px from the nearest coin, bottom-right of the field — hdrCheck's dust disc still misses a few drifted specks; the
  overview HDR gate is open), limeShare 0.00245 (gate [0.01, 0.25] NOT met: the HDR lime clips to white-lime after bloom, so dE to
  0xb6ff5c > 12), settled p95 ≈ 1.6–2.5 ms, quality steps [], labels overlaps 0, foreignColony 0, 32 planets labelled.
- galaxy b-pump-4x: hdrPx 1908 (links 678, bubbles 1228, pulses 13), offenders 0 (ok), limeShare 0.0013, gens 5, overlaps 0,
  scene draws 10 (flat 6: + glows, nebula, ambient, orbits), frame draws 24, settled p95 1.8–2.5 ms, linkMaxPx 1.92 (layout lane's).
- flat (`?look=flat`, same build): hdrPx 0, limeShare 0.00034 / 0.00009, linkMaxPx 1.2, draws 6/20, 0 errors — the final metrics of
  test/shots-map3-final hold. Pixel diff vs a pre-lane baseline not run here (QA lane, G-E).
- veinShare through `__sporeMap.veinShare()` returned null: the debug-hooks entry exists but motion.js's debug object has no
  `veinShare` yet (anim lane); `S.debugFns.veinShare` is in place.
Not done / open: reduced-motion proof, phone shot, G-B animation diff (uAnimT is driven by motion.js), `S.bubbles.flashCorona` and
`S.links.lightPath` calls (motion lane). Shots: SP/gal-planets/shots/{a-overview,b-pump-4x}-{galaxy,flat}.png + metrics-*.json.

## galaxy — anim (2026-10-21, 14:09Z–14:3xZ; engine/state.js + engine/motion.js)

Look plumbing (state.js, landed 14:21Z — an earlier write at 14:09Z never reached disk: `python3` here is the Xcode CLT
shim and exits on the unaccepted licence, so use node for scripted edits):
- `S.look` ("galaxy" default, "flat" only for opts.look === "flat"), `S.galaxy`, `S.tok = tokensFor(S.look)` (namespace
  import `import * as TOKENS from "./tokens.js"` + `typeof` guard, so the module links even without tokensFor; flat gets TOK).
- S.U: `uLook` (1 galaxy / 0 flat), `uAnimT` (seconds, animation clock), `uGalT` (opened-ness), `uFlow` (0 reduced / 1).
- Nothing else in state.js changed; flat reads the same uniforms with their default values (uAnimT stays 0 for ever).

Motion (motion.js, +46/-6 lines, all behind `const G = !!S.galaxy`):
- frame(): when G, `uGalT = smoothstep(1.3 k0, 2.6 k0, cam.k)`; `galAwake = now − S.lastInputAt < 30 000`; `uAnimT += dt`
  only when `!rm && galAwake` (frozen asleep / reduced). setReducedMotion also sets `uFlow` (0 / 1).
- Galaxy frame hook, registered ONLY when G: returns true when `!rm && galAwake && now − lastRenderT ≥ 33`. It gates on
  the time since the LAST render by any cause (not a private clock), so the breathing hook's own requests (bubbles.js,
  ~15 Hz) merge into the same 30 Hz instead of adding to it. Counted as "hook" in `why`; asleep → the existing 2 Hz floor.
- Trade (galaxy): `galTrade(i, now)` at the two places a drawn trade fires on a coin (pulse spawn, rim flash):
  `S.links.lightPath?.(i, U.uTime.value)` + `S.bubbles.flashCorona?.(i)` + animUntil ≥ now + 1200 ms (so asleep trades
  still animate the 1.1 s path light). Overview flashFamily path, births (aBirth), pulse arrival: unchanged.
- Hover: `HOV_MS = G ? DUR.l (400) : DUR.xs (120)` for the uHoverT 0→1 tween on hover change (the bubbles sweep); the
  1→0 leave tween and the drag-grab ring keep DUR.xs in both looks.
- `build()` adds `look`; `motion()` adds `look`, `galHz` (hook-triggered renders in the last second) and
  `galaxy: {awake, animT, galT, flow}`; EngineDebug adds `veinShare: fn("veinShare")` (null until scene.js lands / in flat).

Measured (scratch build 14:21Z of the whole tree as it was then, fixture SP/mapThree, headless Chrome metal 1440×900 DPR 1,
probe SP/gal-anim/probe.mts, results SP/gal-anim/probe.json):
- galaxy `/map?debug`: build().look = galaxy, __sporeMap.look() = galaxy; idle awake (after logos + load pulses, after
  fit()) 300 renders / 10 s, why = {hook: 300}, galHz 30; asleep (breathing asleep, galaxy.awake false) 20 renders / 10 s,
  why = {idle2Hz: 20}, galHz 0, uAnimT frozen (53.97 → 53.97); pointer move woke it; measure(3000,'idle') p95 16.7 ms at
  the overview and 16.7 ms at $PUMP 4× (zoomTo(PUMP, 4), k/k0 = 4.00); two shots 500 ms apart at 4×, settled, no pointer:
  10.08 % of pixels differ by > 8/255 (G-B window 0.5–20 %); 0 console errors, 0 network errors.
- flat `/map?debug&look=flat`: build().look = flat, look() = flat; awake 150 renders / 10 s, why = {hook: 150} (the
  breathing's 15 Hz, as before; galHz 0, uAnimT 0 — the galaxy hook is not registered); asleep 20 / 10 s (idle2Hz); p95
  16.7 ms overview / 16.8 ms at 4×; 0.20 % of pixels differ between two 4× shots 500 ms apart (the flat breathing, as
  before); 0 console errors. Pixel parity of flat vs the pre-lane baseline is the QA lane's G-E (not measured here).
- galaxy + prefers-reduced-motion (harness reducedMotion: true): build().reduced = true, look galaxy; awake 0 renders / 10 s
  (why = {}), galHz 0, uAnimT 0, uFlow 0; p95 16.7 / 16.8 ms; two 4× shots 500 ms apart: 0 differing pixels; 0 console
  errors. (G-B reduced = 0 holds in motion's part: nothing advances the clock and nothing asks for frames.)

Open / for the integrator:
- `S.links.lightPath` and `S.bubbles.flashCorona` are called through optional chaining; grep at 14:30Z says whether they
  exist in the tree (see the lane report). Until they do, a galaxy trade is today's pulse / rim flash only.
- `veinShare` reaches EngineDebug as `fn("veinShare")` → null until scene.js defines `S.debugFns.veinShare`.
- In galaxy the bubbles breathing hook (15 Hz requests) merges into the 30 Hz hook because the hook gates on lastRenderT;
  if the planets lane drops those requests under galaxy, nothing here changes.
- The galaxy 4× animation share (10.08 %) is whatever the 14:21Z snapshot of the other lanes' shaders drew on uAnimT +
  the breathing; it is the QA lane's G-B number to re-measure on the finished tree.
- `motion().galaxy` is null under flat (reporting only; changed after the flat probe read a stale `awake: true`).
- No file outside state.js / motion.js was touched. Not done: nothing from P0–P2 of this lane is missing; map3-perf's
  BUDGET.awakeRenders10s (160) must become 330 for `--look galaxy` (QA lane).

## galaxy — qa (2026-10-21, 14:09Z–14:44Z)
Owned: test/map3-cdp.mts, test/map3-shots.mts, test/map3-perf.mts, test/map3-qa.mts, test/README.md (galaxy section), test/shots-map3-galaxy/ (new; ref/ = the owner's 4 reference PNGs). src/ untouched.
- Harness: `--look galaxy|flat` / `MAP3_LOOK` (cdp `LOOK`, `withLook()`; `page.navigate` appends `look=` to every /map URL; SPA navigations carry none, scripts read `__sporeMap.look()`).
- map3-shots `--look galaxy`: shots a/b/c/d vs ref + composites in test/shots-map3-galaxy/, G-A gates, G-B animation proof (two frames 500 ms apart diffed in Chrome, > 8/255; and 0 under reduced motion). `--look flat --parity <baseDir>`: pixel diff of a/b/d/e vs a baseline run (drains logos, masks the live-fed DOM overlays), diff PNGs + parity.json.
- map3-perf `--look`: measure() p95 gate 16.8 (both looks), awake idle ≤ 330 under galaxy. map3-qa `--look`: per-look title format in (b), tag position in (f).
- Measured on the lanes' tree built at 14:25:30Z (fixture SP/mapThree, metal): galaxy a–d: 0 console errors, overlaps 0, foreignColony 0, titles 32 (a) / 8 (d), gens 5 (b), hdrPx 2149 + offenders 0 (b), linkMaxPx 2.5 (b), animDiff 0.114 (pass), animDiffReduced 0 (pass). FAIL: limeShare(a) 0.0023 (< 0.01), veinShare(b) 0.037 (< 0.05), veinShare(c) 0.035 (< 0.08; the probe measured $PUMP: uFocusFam stays -1 after fly/zoomTo/focusFamily — scene.js veinShare needs a family argument or focusFamily must set uFocusFam).
- perf galaxy: ok (p95 16.7–16.8 everywhere, drag-pan 16.8, idle awake 300/10 s, asleep 19, reduced 0). qa a–p: all ok under both looks except (b), whose failure was this harness' own regex (ticker-only labels); fixed and (b) re-run ok for both looks.
- Flat parity: NOT provable at 0 px with two Chrome launches — the identical baseline tree run twice differs by 9.7k–27.9k map px (text AA edges, chip rims, dust phase); final flat vs base: a 24.7k, b 19.4k, d 18.2k, e 37.6k px, same pattern, no galaxy features in the diffs; flat linkMaxPx 1.2, hdrPx 0, lime 0.00025 as before. A deterministic parity needs a frozen clock + font-ready + identical camera in the engine's debug API.
- G-F: node --check all engine .js ok, tsc -b ok, npm test 50/50; dist CDN grep hits only the pre-existing fonts.googleapis preload (also in the baseline dist); vendor-name grep hits only the app's agent model picker strings (pre-existing), none in map3.
- Not run: perf --look flat (started 14:35:41Z, box ended), a full qa re-run with the fixed (b).
- Addendum 14:39Z: perf --look flat finished inside the box and passed (ok, 0 failures: p95 16.7–16.8, drag-pan 16.7, idle awake 150/10 s, asleep ≤ 25, reduced 0, governor steps 0). Still not run: a full qa a–p re-run with the fixed (b).

## galaxy — integrator (2026-10-21, 14:40Z–15:02Z)

Build under test: the whole tree at 14:47Z, `npx vite build --outDir <scratchpad>/galaxy-qa/dist` (exit 0), served by serve-prod on
5280 (live upstream), 5281 (`--fixture SP/mapThree`), 5282 (`--fixture SP/mycelium`, same map.json shape); logs, JSON results, parity
diffs and the probe under `<scratchpad>/galaxy-qa/`. Galaxy shots + composites: `test/shots-map3-galaxy/` (G-A/G-B JSON there).

Integration fixes (no redesign; flat path untouched):
- engine/links.js: the galaxy vein width in the VS is divided by uK0 — the spec's px numbers (1.4 px overview / 5.6 px at 4x for an
  R = 7 child, 2.5 px floor, 14 px cap) assume k0 = 1; on the mapThree fixture the galaxy layout is ~3.7x wider than the flat one
  (k0 ≈ 0.34 px/u) so every vein sat on the floor (veinShare at $PUMP 4x 0.037 → 0.054). `S.debugFns.linkMaxPx()` (galaxy) uses
  1.4·k/k0 to match (1.4 at the overview, 5.6 at 4x, 14 capped). Inside `#ifdef GALAXY`; the GLSL comment sits on its own line
  (a trailing `//` on the brace line broke the shader in the first build: 5 console errors, fixed before the measured run).
- engine/scene.js: `veinShare(key?)` picks the family by an explicit key, else uFocusFam, else the hovered family, else the family
  whose disc holds the camera centre (zoomTo/snap cameras never set uFocusFam), else the largest planet (c now measures $USDC).
  `limeShare()` under galaxy counts a lime hue (g ≥ 0.55, g ≥ r + 0.04, b ≤ 0.72 g) or the strict dE ≤ 12 match — the HDR lime
  (x1.9) clips toward white after bloom and the strict match missed it (0.0023); `.last.strict` keeps the strict share; flat
  returns the strict share as before (0.00022 at a).
- test/map3-shots.mts: c-usdc-deep zooms to 2x the family-framing zoom focusFamily arrived at (zoomTo's factor is relative to k0;
  "2" on this fixture showed the whole map). Result k = 38 x k0 (13 px/u; the reference's labels read ~6.7 px/u).

Gates measured (Chrome 155 metal, M4; every URL with ?debug; 0 console errors in every run):
- G-F: node --check all engine .js OK; npx tsc -b exit 0; npm test 50/50; COPY_STRICT (Map.tsx, ThreeMap.tsx, MapKey.tsx) 50/50;
  script tags self-only; the CDN grep hits only the pre-existing fonts.googleapis stylesheet preload (also in the 14:09Z baseline);
  no AI/vendor names in map3 src or the map3 tests.
- G-A galaxy (fixture mapThree): a-overview titles 32 (≥ 20), overlaps 0, foreignColony 0, limeShare 0.0177 (0.01–0.25; strict
  0.0023), linkMaxPx 1.4, hdr offenders 4 (not gated at a); b-pump-4x gens 5 (≥ 2), hdrPx 4633 > 0 with offenders 0, linkMaxPx 5.6
  ([2.5, 14]), veinShare 0.0537 (≥ 0.05), overlaps 0; c-usdc-deep ($USDC, rPx 642, k 38 x k0) veinShare 0.0358 — FAIL (≥ 0.08):
  the lit test (max channel ≥ 64/255) only counts live/cooling veins at the spec's 0.42 alpha (quiet 0x7f68c4 x 0.42 = 0.25,
  cold 0.11) and $USDC's children are mostly quiet/cold; d-phone titles 8 (≥ 6), overlaps 0, offenders 0.
- G-B: two frames 500 ms apart at $PUMP 4x: 0.1104 of the pixels differ (143,073 / 1,296,000; 33 renders between; window
  0.005–0.20); under prefers-reduced-motion 0 (0 renders).
- G-C perf galaxy (map3-perf --look galaxy, live upstream): ok, 0 failures — measure() p95 16.7–16.8 ms at the overview / 4x /
  phone for idle/pan/zoom/hover; wheel 16.8; drag-pan 16.8 (0 long tasks); dragCoin $PUMP overview held p95 16.8, settle 1067 ms,
  coinsOffHome 0, intrusion 0; child at 4x held 16.7, settle 700 ms; live 60 s p95 16.7, heap growth −0.63 MB; idle awake 300 / 10 s
  (≤ 330), asleep 19 (≤ 25), reduced 0; governor steps [] desktop and phone. perf flat: frame gates all pass (p95 16.7–16.8,
  drag-pan 16.7, dragCoin held 16.8 / settle 1033 ms / offHome 0, awake 150, asleep 20, reduced 0, governor []), ONE failure:
  warm (reload) first paint 1581 ms (≤ 1500) — my reduced-motion probe launched a second Chrome on the same server during that
  window (galaxy's warm reload: 425 ms); not re-run (box).
- G-D qa: full a–p under both looks (0 console errors, 1 EventSource, 1 /api/map on the re-run): galaxy failures in the full run were
  (a) 2 /api/map requests, (l) 36 renders / 5 s under the site's data-motion=paused, (n) node count 3780 vs 4123; flat: (a) 2
  requests, (n) listeners 1062 vs 1121 — all four Chrome runs shared the live upstream at once. Re-run `--only a,l,n` alone:
  flat ok (a 1 request, l 0 renders, n stable); galaxy a 1 request, n stable (live 0, heap −20 MB), (l) 2 renders / 5 s under the
  site toggle (OS reduced-motion: 0 in qa, perf and shots) — not pinned; suspected live-feed content updates (heat class →
  setHeat invalidate) landing in the window.
- G-E flat parity vs the QA lane's pre-lane baseline (drained, masked): a 24,740 / b 18,775 / d 12,193 / e 37,656 map px differ —
  the same AA/text-edge/dust-speck pattern and magnitude as the baseline-vs-itself selftest (22,885 / 17,288 / 9,696 / 27,936);
  no galaxy feature in any diff image; flat metrics unchanged: linkMaxPx 1.2, hdrPx 0, lime 0.00022 (≤ 0.001), 0 errors.
Known visual gaps vs the refs (not gated): the opened $PUMP's 1,279 quiet gen-2 veins sum into a violet wash near the root; the
$USDC root sphere draws dark (logo body shading) where the reference shows a lit lime "U".

## qa — owner list gates G1–G14: test/map3-feel.mts (2026-10-21, 15:55–16:14Z)

Files: NEW `web/test/map3-feel.mts`; `web/test/map3-cdp.mts` (additive: `page.responses` = responses with status ≥ 400 from
Network.responseReceived, `page.on(method, fn)` = extra CDP event handlers, used for Page.screencastFrame; nothing else changed,
the other scripts are unaffected); `web/test/README.md` (one table row); `map3/README.md` (section "The feel gates": command,
interfaces, pixel classes, the gate table). Nothing in engine/ or the React files.

How to run (fixture server, scratch build): `npx vite build --outDir <S>/qa/dist`; `node --import tsx test/serve-prod.mts --dist
<S>/qa/dist --port 5471 --fixture <S>/mapThree &`; `node --import tsx test/map3-feel.mts --url http://127.0.0.1:5471 --prod --out
<S>/qa --ref <S>/galaxy-ref` (≈ 115 s; `--only G1,G6,…`). Exit 1 on any FAIL or N/A. Interfaces are read through
`__sporeMap.eng.call(name, …)` when it exists, else `eng[name]`, else "n/a (interface absent)" (N/A, no crash): rope, home, moved,
veinPath, coverage, logoCoverage, focusState. Fallback numbers (screen(), logoPx(), the straight chord) are in the JSON.

Baseline = the tree as built at 15:55Z (before the lanes' edits landed), fixture mapThree, Chrome 155 metal, M4, 1440×900 DPR 1:
19 PASS, 29 FAIL, 14 N/A (`<S>/qa/map3-feel.json`; the G13 re-run with the haze row: `<S>/qa/g13/map3-feel.json`).
- G1 veinShare: $PUMP overview 0.0072, 4× 0.0101, deep $USDC 0.0063 (k 38) — FAIL ×3.
- G2 violet: $PUMP 4× disc 0.0035 PASS; deep $USDC disc 0.0592 FAIL (≤ 0.04).
- G3 attachment (veinPath absent → chord fallback, N/A): dark run at the child rim 1.5–4 px at 8× ($SI is a 24-coin family, kids
  r 2.5–3.9 px at 8×), 7.5–9.5 px at the family-framed ×2 view (zoom 83.6), 6–17.5 px at the focus view of its biggest child. The
  threshold had to be local: bg + 24 with the frame/inset bg (13–18) misses the gap because the family glow lifts the floor to ≈ 37;
  a sample is dark below max(bg + 24, halfway between the ring background around that end and the band's median), and the run is
  the longest within 20 px of the rim (the sphere's AA edge is lit, so the run need not touch it).
- G4: coverage() absent; screen() fallback 2,218 / 2,228 tops inside the inset rect, min r 1.5 px (2,168 tops at 1–3 px), dust-top
  centre px lit 0.08 (≥ 0.95) — FAIL.
- G5: logoCoverage() absent (N/A). Fallback (screen + logoPx + node().image): 113 / 2,076 on-screen roots with an image drawn at
  8 s (0.054); images() ready 114, queue drained (the atlas/LO capacity is the limit, not the network). No child is ≥ 10 px at
  $PUMP 4× (0 kids), so the harness also measures 12×: 2 / 12 drawn (0.17). HTTP 429: 0.
- G6 focus (?focus=9bvu…pump, a typed paste, phone): coin r 5.58 px everywhere (≥ 80 / ≥ 50), label not in the DOM, lime annulus
  0, outside luminance ratio 1.0 (no dim), focusState absent; panel open + selected on desktop (url, paste); phone: selected but
  `.map-side` not visible (FAIL) — the focus lane should say which element is the phone panel if it is not `.map-side`.
  The pulse start falls back to the flight's arrival (paste: 799 ms) or settled with no flight seen (?focus: 1,530 ms).
  For this coin the $PUMP family disc covers the whole view, so "outside the family disc" is empty; the harness then uses
  "outside the coin's r + 16" (named in the row).
- G7 drag lag: 250 px / 146 ms max 0 px (11 frames), 400 px / 100 ms 0 px (8 frames) — PASS (the grabbed coin already follows).
- G8: 1.5 s after release the coin is 250 px from the drop point (springs home), descendants 0 % of the drag (70 of them), after
  mcap→locked + resize world(g) equals a fresh mount's — FAIL ×3.
- G9 neighbours: 24.07 world u = 32.45 px, 2 families moved — FAIL.
- G10 ($PUMP top, 600 ms / 200 px): 136 / 136 gen-1 kids trail at mid-drag PASS; last kid motion 0.91 s after release PASS (they
  spring home); overshoot N/A (final displacement 0).
- G11: veinPath absent (N/A).
- G12: 0 console errors; measure() p95 16.8 overview, 16.7 at 4×, rAF p95 16.7 while held; 5 SPA cycles live 0 each, gl 17
  textures / 31 programs each — PASS.
- G13 (map rect vs the whole ref PNG): overview lit 0.227 vs 0.169 (+35 %, edge), lime 0.051 vs 0.030 FAIL, violet 0.0025 vs 0.0065
  FAIL; $PUMP 4× lit 0.107 vs 0.186 FAIL, lime PASS, violet 0.0022 vs 0.0005 FAIL; deep lit PASS, lime 0.010 vs 0.056 FAIL, violet
  0.053 vs 0.0073 FAIL. Root meanLum: ours only (the refs' root position is unknown → N/A). Nebula row PASSES (3.0) but is
  degenerate: both violet shares in the annulus are ≤ 0.0003 because the violet class needs max ≥ 56 and the ref's haze is dim.
  Added an information row "nebula haze" (18 ≤ max < 56 && b−g ≥ 6): ours 0.0001 vs ref 0.0162 → 0.006, FAIL — that one shows
  the missing nebula.
- G14 ?look=flat: mounts, look() flat, 0 errors — PASS.
Artifacts in <S>/qa/: overview / pump-4x / usdc-deep / focus-{url,paste,phone}-{0.5s,0.6s,3.5s} / drag-rest / attach-si-{8x,deep,
focus} PNGs, drag.mp4 (360 frames), paste.mp4 (491 frames), the frame folders.

For the integrator: run it on the merged tree after a fresh scratch build. `pngjs` is resolved from web/node_modules where it is
only a hoisted transitive dependency (qrcode); add it as a devDependency if that matters (package.json is not mine).

## galaxy owner-list — lane:physics (rope drag), 2026-10-21 15:55–16:20Z

Files: engine/motion.js, engine/state.js (nothing else). Flat (`!S.galaxy`) keeps today's simStep verbatim (liquid sim,
spring-back, bodies, hull projection); every change below is behind `G`.

state.js: `S.U.uFocusCoin {-1}`, `uFocusT {0}`, `uFocusDim {0}` (shared, consumers still `??=`); `S.XD/S.YD` fields (null
until applyMoved / buildMotion fills them).

motion.js (galaxy):
- `simStep` → `ropeStep`: the grabbed coin g follows `toW(latest pointer) + grab offset` every frame (no smoothing, no
  clamp); D = descendants of g (BFS, parents first); nothing outside g ∪ D is ever written (no collide, no charge, no body
  push, no hull, no home pull, no settleK, no retire snap, no throw; fUx/fUy stay 0, fMode stays 0). Per c in D: A = P_p + r_c,
  e = P_c − A, L0 = max(|r_c|, R_p + R_c), G = 1 (s ≤ 0.6) else 1 + 12(s − 0.6)², a = −70·G·e − 6·v_c − 4·(v_c − v_p),
  semi-implicit Euler, n = clamp(round(dt/(1/120)), 1, 4) substeps of dt/n (dt ≤ 1/30; NOTE dt/n instead of a fixed 1/120 so
  144 Hz does not run fast), g interpolated across the substeps, then |e| ≤ L0 projection with the outward RELATIVE velocity
  removed. A coin still settling keeps its pending r_c when a new grab includes it. Constants: `S.debugFns.ropeTunables`.
- release (up / cancel / Esc): g exactly at the drop point (`grabbedTarget()` from the last pointer), v_g = 0. Rest test:
  |v|·k/60 < 0.05 px and |e|·k < 0.3 px for 8 frames, or 3 s. COMMIT: P_c = A exact; newborns under a moved parent get their
  offset baked (b.x += …, ox = 0); per touched family HX/HY and f.cx/f.cy += Δtop; world grid + dust grid re-bucketed, flat
  body grid dropped (rebuilt on use); X0/Y0 := X/Y; publishMoved(); `S.drag.version++`; `S.emit("positions", {...S.drag,
  committed: true, coins, moved: coins, nMoved})`; `callbacks.onMoved(entries)` (section 7 format; a coin that already had an
  entry re-emits even at ~0 so the page map never keeps a stale offset).
- While moving: S.X/S.Y in place, publishMoved as before (S.drag.moved/nMoved/version, overview.setPositions(famIds),
  labels.setPositions, "positions"), f.cx/f.cy = HX + (X[top] − X0[top]); `S.drag.settling` includes the rope.
- hitTest / grabHit: rope coins first by live X/Y, grid skips them; hit radius = `S.bubbles.drawnPx(i)` when it exists
  (else screenR / R·k); grab still needs ≥ 6 px drawn. hitTest's grid reach +6/k for px floors.
- K_MAX = 1600 (flat 80). NOTE: famK/coinTarget clamp to it too, so clicking a tiny family now frames its top at 64 px
  (was capped at k 80).
- `export applyMoved(S, moved)` (index.js already calls it after placeDust): S.XD/S.YD = copies, BFS disp inheritance,
  f.cx/f.cy += disp(top). buildMotion creates XD/YD itself when applyMoved did not run.
- S.api.select(m, {fly}) → `S.focus.fly(i)` when present (i < N), else flyToCoin; initial opts.select → `S.focus.target(i)`
  (validated, else coinTarget) and `S.focus.pulse(i)` two rAFs later.
- Debug: `EngineDebug.call(name, ...a)`; `S.debugFns.home(i)` → {x, y (committed home), xd, yd (designed)}; `rope()` →
  {active, held, n, set, maxDevPx, settling, maxStretch, lagPx, maxLagPx, grabs, commits, lastSettleMs, within05Ms};
  `moved()` → mints emitted since mount. `dragCoin` in galaxy = `dragCoinRope` → {maxLagPx, neighbourMaxPx, settleMs,
  within05Ms, dropDeltaPx, dropDelta1500Px, homeDeltaRatio1500, descRatio3s, trailMaxStretch, gen1LagFrames,
  overshootPct*/overshootL0Pct* (median/max), held/settle frame stats, simMax, committed}.

Measured (scratch build of the tree at 16:10Z, serve-prod --fixture mapThree, Chrome 155 metal, 1440×900, M4):
- real CDP mouse drag, $PUMP child DzMwArmd… at 8× (k 2.49): 250 px / 146 ms → rendered lag 0 px on all 16 held frames,
  neighbourMaxPx 0, g at 1.5 s 0.000003 px from the drop, moved 250.0 px, commit 1125 ms, held p95 16.8 ms; 400 px / 100 ms →
  lag 0 (12 frames), neighbours 0, drop Δ 0.000005 px, moved 400.0 px, commit 1431 ms, p95 16.7. Baseline: sprang back 250 px,
  neighbours 65.8 px.
- at 4× (k 1.245) that child is drawn 5.66 px < the 6 px grab floor, so a REAL press there pans (by spec). Synthetic dragCoin
  at 4×: lag 0, neighbours 0, drop Δ 0, ratio1500 1.0, descRatio3s 1.0; hold 0: within 0.5 px of the anchors 1098 ms
  (250/146), 1047 ms (−400/100), 797 ms (300/600); commit 1314 / 1263 / 1030 ms; overshoot (of L0) median 13.6 / 13.6 / 2.1 %,
  max 98.6 % in the 250/146 flick (a fast stop whips a clamped child across its anchor to the other limit; spec constants).
- real mouse drag of the $GTA top at the overview (220×90 px / 400 ms, 600 ms hold): lag 0 on 60 frames, neighbours 0, drop Δ
  6e-6 px, held p95 16.7 ms. $PUMP top held 1.5 s at the overview (1480 descendants): p95 16.7, simMax 1.6 ms, neighbours 0.
- persistence: $GTA top dragged 692 world u, then ?size=mcap (SPA, the engine IS rebuilt, XD differs) → displacement ratio
  1.0000; then a resize 1440→1200 → 1.0000. Hit test after commit: pick at the new spots returns the moved child / top.
- ?look=flat: mounts, 0 errors, dragCoin springs back (coinsOffHome 0). 0 console errors in every run.

Open / for the integrator: real-mouse G7 at "$PUMP 4×" will pan unless visibility's drawnPx puts that child ≥ 6 px (use 8×,
or the spec's 6 px floor changes). Births placed DURING a rope take the live parent position and then the drag offset too
(pre-existing double offset, gone after the commit). Overshoot can reach ~1 L0 on abrupt flicks; damping in the stretch zone
would cut it but is not in the spec.

## galaxy owner-list — lane:focus (2026-10-21, 15:55–16:20Z)

Files: NEW engine/focus.js; engine/labels.js, engine/index.js, engine/index.d.ts; ThreeMap.tsx, debug-hooks.ts, map3.css;
pages/Map.tsx (the brief's "components/map/Map.tsx" is web/src/pages/Map.tsx), components/map/panel/MapSearch.tsx.
Untouched in my set: adapter.ts, use-engine-sync.ts, Rails.tsx (Rails already picks through Map.tsx pickNode).

- focus.js `buildFocus(S)` (index.js: after buildLabels, before buildMotion) sets `S.focus = {target, fly, pulse, state, active}`.
  target(i): coin centred in the inset rect (motion's viewRect), k = max(kFam, P/Rd), P 80 desktop / 50 phone,
  Rd = S.Rdraw[i] || S.R[i], kFam = insetMin·0.94/(2·Rc·1.06), the coin's radius capped at 40 % of the inset's short
  side, k ≤ 1600. fly(i): S.motion.flyTo(target).then(pulse) (a newer fly or a cancelled flight never pulses; newborns
  i ≥ N use motion.flyToCoin). pulse(i): uFocusCoin = i, uFocusT/uFocusDim 0→1 in 150 ms, hold to 1.9 s, ease to 0 at
  2.5 s from an S.onFrame hook, then uFocusCoin = −1. Uniforms declared with ??= (physics declares them in state.js too).
  Label dim: the hook sets `--m3-fdim` (1 − 0.4·dim) on .m3-labels; map3.css multiplies every .lb.on opacity by it.
- index.js `installFocus(S)` wraps S.api.select: with {fly: true} and a coin in the layout it calls motion's select with
  fly false, then S.focus.fly(i) (so exactly one flight whatever motion's own branch does). A coin selected at mount
  (opts.select, ?focus) is framed with S.focus.target and pulsed on the first frame unless the physics mount pulse
  already runs (S.focus.active()). applyMoved(S, opts.moved ?? new Map()) runs right after placeDust (named import
  from motion.js, physics exported it at 16:04Z). Debug: EngineDebug.call(name, ...a) and focusState() are added when
  motion's engineDebug lacks them; window.__sporeMap.call() and .focusState() (+ mint, page-px screen) in debug-hooks.
- Persistence: ThreeMap movedRef (Map mint → {dx, dy}) lives for the mount, passed as opts.moved on every build;
  callbacks.onMoved merges entries (set by mint, the onMoved format is absolute per coin). Nothing stored.
- Re-pick: Map.tsx pickNode calls map.focusNode(mint) (= engine.select(m, {fly: true})) when the mint is already ?focus
  (the URL does not change, so the echo would not act). MapSearch reads a pasted mint from the raw input (no 120 ms
  debounce), so the flight starts on the paste.
- labels.js: a pinned label `.lb.pin.m3-pin` (ticker 600 15px + line 2: a top's 'N · share' title text, else mcap),
  the focused coin during the pulse else the selected coin; placed first in every pass under the sphere (drawnPx + 12 px
  while pulsing, + 7 otherwise; above when there is no room), never dimmed; that coin's own title / child label steps
  aside. Coins in S.drag.moved are visited by live X/Y (not by their grid cell) for obstacles and child labels; a
  committed "positions" event clears the visible-radius cache and dragMem and re-lays out at once. S.labels.pinned().

Measured (scratch build focus/dist, serve-prod --fixture mapThree on :5583, Chrome metal, M4):
- ?focus=9bvu…pump 1440×900: r = 80.0 px (k 320, zoom 1028× k0), centre (710, 481.5) inside the inset rect
  {348,79,1072,884}; pin label on ("$Attention $415"); panel open; focusState t > 0 for 2.28 s; labels at 0.6.
- 390×844 DPR 2: r = 50.0 px, inside inset {0,207,390,703}, label on, panel open, t > 0 for 2.36 s.
- typed paste (CDP Input.insertText into .map-search input from the overview): r = 80.0 px, inside, panel open, t > 0
  2.46 s; re-paste of the same mint from the overview re-flew (zoom 1 → 1028) and re-pulsed (2.38 s).
- persistence: a planet top dragged 646 world u (dragCoin 180,90 px), then size toggle mcap → locked (2 rebuilds):
  top at the dropped position, residual 0.0, kept ratio 1.00; its title still listed; moved() = 1.
- ?look=flat&focus=…: mounts, pin on, pulse runs, k clamps at 80 (r 20 px; flat K_MAX), 0 errors.
- 0 console errors in every run; overview pan p95 16.8 ms, during a pulse p95 16.7 ms.
- node --check focus.js labels.js index.js OK; npx tsc -b clean.

For the integrator: the focus VISUALS are other lanes' (spheres ring/halo, vein lighting, nebula dim). In the 1.1 s
shot of the paste (focus/probe/focus-paste-1.1s.png) the focused coin's halo quad shows a hard rectangular edge
(~390 px square around the coin) and the lit veins + bloom wash the whole view lime: bubbles.js halo needs to reach 0
inside the ×2.4 quad, and links.js focus boost (alpha × 2.5 + lime × 1.9) is strong at k ≈ 320. G6's lime-annulus and
dim-luminance numbers were not measured by this lane.

## look lane: nebula, ambient, fit, bloom, tokens, logo supply (2026-10-21, 15:55 to 16:23Z)

Files: engine/dust.js, engine/scene.js, engine/tokens.js, web/src/lib/map/images.ts, server/lib/config.mjs,
server/lib/meta.mjs, server/index.mjs, NEW server/test/img-thumb.test.mjs. server/lib/api.mjs was NOT changed: the route
`app.get("/api/img", limits.img, images.handler(...))` passes `w` through as is. All numbers come from the M4, headless Chrome
with metal, 1440x900 at DPR 1, `/map?debug` on my own scratch build served by serve-prod with `--fixture scratchpad/mapThree`
on port 5629. Port 5471 belongs to the qa lane. The build includes the other lanes' work as of 16:21Z.

### Nebula + ambient: the cause, fixed
- Cause (confirmed): `THREE.AdditiveBlending` with `premultipliedAlpha: false` is blendFunc(SRC_ALPHA, ONE). Both FS wrote alpha 0.0, so
  nothing was added. Also, `S.debug.obj.glows` was being overwritten with the nebula (bubbles builds before dust).
- Fix (dust.js `addMat`): CustomBlending with rgb One/One + AddEquation and alpha Zero/One (destination alpha kept). FS alpha is 1.0 (monolith M:389/M:418).
- Re-tune from the monolith: seed rnd(id, 14), r = 6 Rc + 40 world, teal when age <= 3 h else #6a54b0, no px floor (GAL.nebula.rMinPx 0).
  The final setting is GAL.nebula frac 0.30, a 0.09, which gives 638 blobs (0.12 / 0.05 would give about 260).
- Measured: the nebula + ambient together add only 0.4 to the overview meanLum (73.44 -> 73.0 toggled off; toggled with `call("lookLayers", ...)`).
  The ref's purple ring is made mostly by the monolith's soft dust POINTS (POINTS_FS, quiet = violet), not by its 12 % nebula. In this
  tree that ring now comes from the visibility lane's dust tops (bubbles.js).
- The nebula follows drags: an `S.on("positions")` handler re-reads f.cx/f.cy into aN (DynamicDraw). The specks re-sync on every "positions"
  event too, so this no longer depends on motion's famMode. Nebula, ambient and specks all apply × (1 − 0.4·uFocusDim)
  (`S.U.uFocusDim ??= {value: 0}`).
- Galaxy specks: no edge feather (edge = 1). They are hidden whenever `S.bubbles.drawsDustTops` is set, at build and in the frame hook.
  Measured: specks hidden, because the visibility lane sets the flag. dgrid/pick data, setPositions and the caption are kept.
- Debug: `S.debug.obj.nebula`, `.ambient` (= `.ambPts`) and `.dustPts` are set. obj.glows is no longer touched.
  NEW `S.debugFns.lookLayers({nebula, ambient, specks, bloom, bloomTints[5], bloomStrength, bloomRadius, bloomThreshold, hideOrders[]})`
  shows or hides layers and turns the bloom knobs for QA attribution (debug only, through `__sporeMap.call("lookLayers", {...})`).

### Overview fit (scene.js, galaxy only; flat unchanged)
- k0 = 0.96 (min(w', h') / 2) / Rout (the monolith fitTo), then lowered until the top coin of every family (plus a 6 px margin) is
  inside the fit rect. The 1.22 Rcl / 1.6 Rcl caps are gone in galaxy. Rvis = max(RoutMax, Rout, Rcl).
- Measured: fit rect 1076x805, Rcl 1032.4, Rout 1200.8, RoutMax 1330.3. k0 from Rout alone is 0.3218; final k0 is 0.31128
  (the all-tops constraint binds). `fitTopsOut` 0 of 2,228 tops. coverage(): 2,228 of 2,228 on screen, minTopPx 3, hist 3-6: 2,167, 6+: 61.
- dustTypR = min(median 6.309, 3.75/k0 = 12.05) = 6.309, so uDustExpand runs from k 0.951 to 2.22 (3.05 to 7.1 k0); before, it started
  at 1.6 k0. In galaxy the visibility lane no longer hides dust members by uDustExpand.
- New primitives in `__sporeMap.engine()`: fitK0, fitK0Rout, fitRcl, fitRout, fitRoutMax, fitW, fitH, fitTops, fitTopsOut, fitDustTypR.

### Bloom: deviates from the spec's 0.72, measured
- At 0.72 / 0.42 / 0.85 with all 5 mips on, the overview is a green wash. Measured vs ref-overview.png (sRGB classes, spec section 6):
  lit 0.472 vs 0.169, lime 0.174 vs 0.030, meanLum 73.7 vs 39.8. With bloom off: lit 0.144, lime 0.0175, meanLum 35.3, so the bloom is what washes.
- Variants measured (overall lit / lime / violet / meanLum):
  - mips 3-4 off, 0.72: 0.279 / 0.067 / 0.012 / 50.2
  - all mips, 0.35: 0.296 / 0.041 / 0.013 / 50.8
  - mips 3-4 off, 0.50: 0.235 / 0.039 / 0.016 / 44.8
  - mips 3-4 off, 0.40: 0.214 / 0.030 / 0.019 / 42.5 (CHOSEN)
- Now: GAL.bloom and GAL.bloomPhone = 0.40 / 0.42 / 0.85, and mips 3-4 are muted under both looks.
  - Final shot: lit 0.2146 (+27 % vs ref), lime 0.0291 (−4 %), meanLum 42.59 (+7 %), all inside ±35 %.
  - violet 0.0195 vs 0.0065 is +200 %: that is the visibility lane's violet dust-top rings, not mine.
  - hdrCheck: offenders 0, hdrPx 34,529.
  - If the sources get dimmer, the integrator can raise the strength again; `lookLayers` has the knobs.

### Nebula gate (spec section 6): NOT met
- Ref annulus, estimated: centre (720, 450), Rcl ≈ 330 px, Rout 432 px, so [363, 432] px. Ref violet there: 0.0478.
- Ours: centre (886, 481), [1.1 Rcl, Rout] = [353.5, 373.8] px, a thin ring because the dust hugs the colonies (Rout/Rcl = 1.16). Ours violet there: 0.0107, which is 22 % of the ref (the gate is >= 50 %).
- The ref's Rcl is my estimate from the image, not measured from the monolith.

### tokens.js
- New `GAL.heatHex(ageS)` -> [r, g, b] in 0..1, and `GAL.heatBoost(ageS)`, verbatim from M:17-24. Checked at 0 / 6300 / 10800 / 48600 / 86400 / 1e6 s:
  b6ff5c / 89f092 / 5ce0c8 / 6ea4c6 / 7f68c4 / 4a4466, and 1.9 / 1.25 / 1.0 / 0.9 / 0.9 / 0.75. A null or non-finite age is treated as cold.
- GAL.link* keys are unchanged.

### images.ts
- MAX_INFLIGHT 16 -> 48; BURST 120 -> 2400; MIN_START_MS 80 -> 25 (40/s); QUEUE_CAP 1500 -> 5000.
- PIXEL_BUDGET 24e6 -> 48e6, or 24e6 when innerWidth <= 700.
- New `fetchUrl(src, size)`: any /api/img URL gets `&w=64|128|256` (an src that already has w is left alone). Used by both the bitmap path and the <img> path.
  The cache key stays src.
- `imageStats()` adds e429 (429 responses) and thumbs (responses carrying x-img-thumb). Retry-After handling is kept.
- Measured over the first ~9 s:
  - 173 /api/img requests: 111 with w=64, 57 with w=256; 0 HTTP 429.
  - 48 in flight the whole time, about 1,860 queued; roots drawn with a logo: 120 of 2,086 with an image.
- Why G5 is not met here: serve-prod proxies /api/img to the LIVE sporepad.com, which still runs the old server (concurrency 3, no
  thumbnails, thumbs 0). The bottleneck is upstream latency, not client pacing. Re-measure after the server deploy, or with a local server.

### SERVER DIFF (the lead deploys server + web together)
- server/lib/config.mjs:14: `DEFAULT_RATES.img [900, 60_000]` -> `[6000, 60_000]`. RATE_IMG still overrides it.
  DEPLOY.md documents the rates and was not edited (not my file).
- server/index.mjs:46: `new ImageCache(..., { log, maxBytes: cfg.imgCacheBytes, concurrency: 8 })` (was the default 3).
- server/lib/meta.mjs (+90 lines). New exports:
  - IMAGE_THUMB_SIZES = {64, 128, 256};
  - renderThumb(bytes, type, w): @resvg/resvg-wasm draws an SVG of w×w with `<image href="data:...;base64,..." preserveAspectRatio="xMidYMid slice">`
    and returns PNG bytes. It returns null for anything other than png/jpeg/gif (webp) and for an all-transparent render.
  - resvg is initialised the agents-live/ailogo.mjs way: renderLogo() owns initWasm and "already initialised" is tolerated.
    lib/agents/logo.mjs does NOT tolerate a second init, so the order matters.
- New method ImageCache#thumb(url, hit, w):
  - writes `<sha>.w<w>.png` beside the original;
  - renders one at a time (a promise chain, setImmediate after each render), with in-flight dedupe and a 24 h negative cache per (w, url);
  - re-renders a thumbnail that is older than its original or past IMAGE_TTL.
- Thumbnails count in stats.bytes, and #evict removes an original's thumbnails with it.
  New stats: thumbs, thumbHits, thumbFailed.
- handler: with w in {64, 128, 256} it serves the thumbnail with `x-img-thumb: <w>` and `cache-control: public, max-age=604800, immutable`.
  On any failure, or for any other w, it serves the original exactly as before; an unknown w is never a 400.
  The original keeps `max-age=86400`, because test/api.test.mjs asserts it and that file is not mine.
- server/test/img-thumb.test.mjs (new, 3 tests): png + jpeg -> 64x64 png; webp -> null; w=100 -> null; the HTTP route through express
  (thumb header, 7-day cache, cached on disk, second read a hit, w=128, webp -> original, w=77 -> original, no w -> original);
  eviction takes the thumbnails with the original.
- Ran: `node --test test/meta.test.mjs test/api.test.mjs test/config.test.mjs test/agents-logo.test.mjs test/http.test.mjs test/img-thumb.test.mjs`:
  54 / 54 pass.

### Checks at box end
- node --check passes on dust.js, scene.js, tokens.js, meta.mjs, config.mjs, index.mjs and img-thumb.test.mjs.
- `npx tsc -b` in web exits 0.
- Overview: 0 console errors, measure(4000) p95 16.7 ms (max 16.8).
- Not measured: the phone fit (390x844), ?look=flat after this lane's changes, 4x/deep shots and the leak test.

## galaxy owner-list — lane:visibility+logos (bubbles.js only), 2026-10-21 15:55–16:26Z

Edited only `engine/bubbles.js` (node --check OK). Scratch build `<scratchpad>/vis/dist`, serve-prod `--fixture mapThree`
on :5487, Chrome metal, 1440×900. Backup of the file before this lane: `<scratchpad>/vis/bubbles.before.js`.

Exports (ready before buildLinks): `S.Rdraw` (= drawR.subarray(0, N), seed-head shrink applied), `S.minPx` (Float32Array N,
static CSS-px floor, phone ×0.85 applied, galaxy dust tops ≥ 2.5, dust members ≥ 1.0), `S.bubbles.drawnPx` (= screenR, the
JS mirror of the VS incl. the new galaxy dust floors), `S.bubbles.drawsDustTops` (= galaxy), `S.bubbles.atlasStats()`,
`S.debug.obj.coronas` (= glows). `S.U.uFocusCoin/uFocusT/uFocusDim ??=` before the materials.

Done:
- Overview visibility (galaxy): dust-family tops minPx = min(6, 3 + 3 sqrt(share/maxDustShare)) × uMinScale, floor 2.5,
  cov 1; dust members 1 px floor, alpha 0.7 → 1 by 3 px; no `mix(1, uDustExpand, isDust)` in galaxy; lit discs from 2.5 px.
  Measured `coverage()`: desktop tops 2,228, onScreen 2,228, hist {lt1 0, 1to3 0, 3to6 2,167, ge6 61}, minTopPx 3.0;
  phone 390×844: onScreen 2,228, minTopPx 2.55.
- Atlas rewrite: LO = 4096² render-target texture of 64 px cells (phone 2048²/32 px) = 4,096 cells; HI = 2048² of 256 px
  (phone 1024²/128) = 64 cells (62 planet tops, 62 = selected, 63 = uFocusCoin). Cleared to #123020 on the GPU (no CPU atlas
  canvas). Every family top owns a cell from the build (2,168 LO + 60 HI); children with drawnPx ≥ 10 on screen take LO cells
  biggest-first after the camera settles (≥ 250 ms apart), LRU eviction of unpinned cells. want(url, 64) LO, want(url, 256) HI
  (128 on phone). Upload = raw gl.texSubImage2D per dirty cell (the loader's bitmap directly when it is exactly the cell size,
  else via a cell-size scratch canvas), batches ≥ 250 ms apart, ≤ 2 ms each, then one generateMipmap per touched atlas.
  Shader lookup by uniforms uAtlHi/uAtlLo (cell, cols, size, maxLod); exact analytic lod clamped to log2(cell) − 3, so a mip
  texel never spans two cells; logo alpha composited over the pre-fill.
  Measured upload: up to 200 cells in one 2.1 ms batch, maxMs 2.2 (one 10.3 ms first batch in one run), mipMs ≈ 0.
  copyTextureToTexture was 3–5 cells per 2 ms (getParameter ×5 + rebind per call): replaced.
- Pre-fill (galaxy): a coin with a cell and an image URL draws #123020 lit + its first letter in its heat colour until the
  logo lands; a family top with NO image URL keeps the lit heat sphere with the inked monogram (code −50 − glyph).
- Lit sphere with logo = atlas (0.78 + 0.32 dif) + 0.28 spec + 0.9 rim·heat (monolith); logo at any size once landed (no LOD
  gate in galaxy). No-logo body + 24 h ring unchanged (already monolith).
- Coronas: real bug fixed (AdditiveBlending without premultipliedAlpha = SRC_ALPHA,ONE → alpha-0 FS added nothing). Now
  CustomBlending One/One (alpha Zero/One). Colour = heat colour WITHOUT heatK (monolith M:377; with ×1.9 it blew out);
  live core × (0.75 + 0.35 sin(1.9 t)) under uBreath.
- Focus visual: coin == uFocusCoin: quad ≥ 2.4 R, lime ring (R+4 → R+8 px) × (1 + 0.15 sin(2π·1.6 uAnimT)), lime ×1.9, halo
  0.35 exp(−((d−R)/1.2R)²) faded to 0 by 2.3 R (no square edge — fixes the focus lane's note); others' colour × (1 − 0.4 dim).
  Shot `<scratchpad>/vis/focus2.png` (?focus=9bvu…: focusState t 1, rPx 80, label true).
- Debug: `coverage()`, `logoCoverage()` (+ upload/assign/dirty/pending/failed/loCell/hiCell), `visToggle("bubbles"|"coronas", on)`.
  logoPx(i) = px of the landed logo (64/128/256), 0 otherwise.

Measured, NOT met (loader/server-bound, not the atlas):
- Roots with logo at 8 s after ready: 1,194 / 2,086 (57 %) on a warm run, 632 / 2,086 (30 %) cold; 12 s: 1,248. At 8 s the
  dirty queue is 0–5: the loader is the bottleneck (inflight pinned at 48, `thumbs: 0` = the live /api/img upstream ignores
  &w=, originals are fetched). 0 HTTP ≥ 400, 0 429s in every run.
- Deep $USDC (zoomTo 38): kids10 45, with image 39, assigned 39 at once, drawn 8 at 1 s, 9 at 3 s, 19 at 15 s — again loader
  throughput (≈ 1 completion/s at that point, queue 1,580). Needs the look lane's server thumbnails/rates deployed to measure.
- $PUMP zoomTo(…, 4): 0 children reach 10 px (kids10 0), so nothing to assign there.

Perf (dpr 2, measure 3000): overview idle p95 16.7, zoom 16.8; $PUMP 4× idle 16.7, pan 16.7. 0 console errors in every run
(galaxy, ?look=flat, phone, focus). ?look=flat mounts, draws logos through the new lookup (shot vis/flat-pump4x.png).
Not measured: GPU textures over 5 mounts (the two render targets + 2 scratch textures are disposed in S.life.onDispose).

For the integrator:
- The white disc over $Kimchi at the overview is NOT bubbles/coronas: it stays with both hidden (vis/ov-nobubbles.png) —
  additive veins of its 1,120 children converging on the root (links.js).
- At the focus view the lime band of a focused vein visibly continues inside the focused sphere (bloom of the HDR band,
  or vein order): bubbles keep body alpha 1 at renderOrder 10.
- Transparent logos uploaded straight from an ImageBitmap are composited with t.a in the shader; if a loader ever hands
  premultiplied bitmaps, edges darken slightly (no black squares).

## veins — live curves (lane:veins, 2026-10-21 15:55–16:31Z)
Owner file: engine/links.js only. node --check links.js OK; scratch build (vite --outDir scratchpad/veins/dist) OK.
- Galaxy draws a NEW vein mesh (S.links.mesh = S.debug.obj.links = `veins`): InstancedBufferGeometry, base strip (NSEG+1)x2
  (position = (t, side, 0); NSEG 20, 12 on phone), instances aEnds (p, c), aCtl (u1, v1, u2, v2 chord frame), aW (w0 at build,
  notable, gen, tTrade = uTime - age), aMeta (fam, flags 1 hover lineage | 2 branch, dust, s = clamp((log10 mc - 4)/3)).
  19,073 veins on the fixture (every par >= 0 coin, incl. the ones the flat rim cut drops). The baked hairline mesh is still built
  (heat/emphasis bookkeeping, linkInk, bornMesh shares its material) but is NOT added to the scene in galaxy (S.links.flatMesh).
- uPos: RGBA32F 2048 x ceil(N/2048), texel i = (S.X, S.Y, S.Rdraw ?? R, S.minPx ?? 0.5); a per-frame scan (frame hook + veins
  onBeforeRender) re-uploads on ANY change of the four (no event subscription needed). Control points: designed bundle at 1/3, 2/3
  arc length -> P1/P2 by the spec formula; VS rebuilds the cubic on the LIVE chord. Centre to centre, no end gaps, no R+0.25 cut;
  core capped at 1.6 rimPx at each end (+0.5 px per px past the rim). FS: AA core 0.6 px + 0.35 exp(-3 (d/gl)^2), additive
  vec4(col a, 0), dash amp 0.25, monolith heatHex/heatBoost continuous by age (uTime - tTrade), x0.85 when not live.
- Focus: S.U.uFocusCoin/uFocusT/uFocusDim ??= (spec 8); veins of the focus coin x(1 + 1.5 T) and -> lime x1.9; others x(1 - 0.4 dim).
- CPU: pathOfLink / linkPolyline / pulses ride the SAME live cubic (16 segs, refreshed when posSig changes), cut at drawn rims;
  spawn/spark/lightPath/setEmphasis/setBranch use hasLink() (vein exists). setLinkHeat moves tTrade into the class's age range.
  Orbits follow their family (top offset from uOff, aTop attribute). Gen arcs unchanged (arcFollow).
- Debug: linkMaxPx() = widest core CSS px (shader formula); veinPath(c | mint, n = 16) -> {pts CSS px parent->child, rimP, rimC,
  coreCss, posSig}; veinStats() -> {veins, nseg, posUploads, posSig, offsetCoins}.
- DEVIATIONS from spec numbers (VEIN const at the top of links.js): w0 is read as CSS px at k0 (w0 x k / uK0, VEIN.wPerK0 = 1;
  this layout's k0 ~0.17 px/u, so w0 x uPx stayed under the F floor until ~6x: veinShare 0.046 at 4x, 0.011 deep). Alphas aOther
  0.55->0.7, aGen2 0.6->0.75, aQuiet 0.55->0.8, aCold 0.4->0.7 (violet headroom was large). Set wPerK0 = 0 / restore to undo.
- MEASURED (M4 metal, 1440x900 dpr 1, fixture mapThree, tree incl. other lanes' in-flight edits):
  veinShare $PUMP 4x 0.0981 (gate 0.08 PASS; baseline 0.010); deep $USDC (zoom() 8) 0.0471 (gate 0.06 FAIL; baseline 0.0061);
  overview $PUMP: 0.1766 in a single-page run (gate 0.04 PASS) but 0 in my probe run that also opens a 2nd CDP page (unresolved:
  that page likely backgrounds the map tab; measure() also timed out there). Violet (full render, disc): $PUMP 4x 0.0253 (gate 0.03
  PASS, was 0.0003 before the alpha raise), deep 0.011 (gate 0.04 PASS). p95 idle at 1.5x (single page) 16.7 ms; 4x/overview p95
  NOT measured (probe measure timed out). 0 console errors in every run.
- NOT DONE / open: G3 attachment unverified: my $SI probe used zoomTo(si, 8) which did not frame $SI (tiny family off-centre, USDC
  panel open), so the rim-luminance check read all-dark windows (7.5 px) on cold 3.6 px coins; re-run G3 with a camera that frames
  $SI (focus lane's S.focus.target) and on the focus view. G11 (veinPath endpoints vs live centres during a drag) not run (physics
  lane's rope not merged in my build); by construction both ends are texel lookups of S.X/S.Y uploaded before the draw.

## galaxy owner-list — integrator (2026-10-21, 16:31–17:0xZ)
Merged tree, measured on the M4 (Chrome 155 metal, 1440×900 DPR 1 unless noted). Scratch builds `<S>/gf-qa/dist` (lanes as
delivered), `dist2` (= the final tree). Servers: serve-prod `--fixture <S>/mapThree` (:5711 / :5713) and live upstream
(:5712 / :5716). Gates: `node --check` all engine .js OK; `npx tsc -b` 0; `npm test` 50/50; server `node --test` 317 tests, 0 fail.

Integration fixes (no redesign):
- engine/focus.js `target()`: P = (phone ? 50 : 80) × 1.01. With exactly 80 the float32 Rdraw / px mirror ended at 79.99 px and
  G6 "r ≥ 80" failed; now r 80.8 (desktop) / 50.5 (phone).
- test/map3-feel.mts: G7–G11 drag at $PUMP 8× (was 4×: the drag coin DzMwArmd… is drawn 5.66 px there, under the 6 px grab floor,
  so the real press panned the map and G7/G8/G11 read 0 frames). G6 panel check accepts the phone's docked `.map-sheet`.
- test/map3-qa.mts (j): look-aware. Galaxy asserts dragCoin neighbourMaxPx 0 + dropDeltaPx ≤ 2, and after the real 200 px mouse
  drag: no coin outside the dragged family moved and the top kept ≥ 95 % of the drag (measured: 1,565 moved, 0 foreign, 200 px
  kept). Flat keeps the old spring-back assertions.
- test/map3-perf.mts: GALAXY = LOOK !== "flat" (no --look = the app default, galaxy; it had applied the flat awake budget 160 to
  galaxy's 30 Hz hook); dragCoin checks neighbourMaxPx 0 under galaxy instead of the flat-only coinsOffHome.
- test/map3-shots.mts animProof: logo-drain wait 30 s → 20 s. With 2,228 family logos queued against the live upstream the
  queue never drained, the 30 s wait outlived GAL_AWAKE_MS (30 s) and the proof shot a sleeping map (galHz 0, diff 0.00022).
- Tried and reverted: a per-family overview vein-energy damping in links.js for the white $Kimchi disc; no visible effect.

Feel gates (map3-feel; lanes' build, then G6–G11 on dist2): G1 PASS ×3 (overview 0.336, 4× 0.128, deep 0.105); G2 PASS ×2
(0.026, 0.029); G3 FAIL (worst rim gap 3 px at $SI 8× and ×2 framing via veinPath; focus view had 0 pairs); G4 coverage PASS
(2,228/2,228, minTopPx 3) but dust-top centre lit 0.68 FAIL; G5 FAIL (roots with logo 0.036 at 8 s, kids ≥10 px 0 at 3 s;
0 HTTP 429) — the live /api/img upstream is the old server (concurrency 3, no &w thumbnails); G6 r/label/t/annulus/panel PASS
for ?focus, typed paste and phone; "lum outside r+16 @0.6 s / @3.5 s" FAIL 1.7–2.3 (the lit lime veins + halo + bloom inside the
measured region make 0.6 s brighter, not darker); G7 PASS (0 px lag, 11 and 8 frames); G8 PASS ×3 (drop delta 0, desc ratio 1,
toggle+resize ratio 1); G9 PASS (0.0); G10 trail PASS, overshoot 4.5 % PASS, rest 1.66 s FAIL (≤ 1.2 s; $PUMP top, 1,564
descendants); G11 PASS (0.01 px, 19 frames); G12 PASS (p95 16.7/16.7/16.8 held, live 0 ×5, 18 textures/31 programs ×5, 0
errors); G13 FAIL except lime (overview lit +78 %, violet ×4.5, nebula 0.30 of ref); G14 PASS.
map3-qa (live): a–i, k, m, o, p ok; (j) ok after the galaxy fix; (l) FAIL (55 / 52 renders in 5 s idle under reduced motion —
the logo queue had not drained after 45 s, each arriving logo is one render); (n) FAIL DOM-node drift (live 7,727→8,285; fixture
2,533→4,942); the 15:55 baseline build also fails (n) on the fixture (2,081→5,380→1,882), so not attributed; engine live 0 and GL
objects stable every cycle.
map3-shots --look galaxy: 0 failures after the animProof fix (anim 0.080, reduced 0). Shots + composites + e/f/g + drag.mp4 +
paste.mp4 in test/shots-map3-galaxy/.
Open, visible: $Kimchi renders as a blown-out white disc at the overview; hiding renderOrder 4 (veins) removes it
(<S>/gf-qa/probe/kimchi-hide-4.png), so it is the additive veins of its 1,120 hot children (veins lane).

## fixer — both critics' fixes (2026-10-21 17:01–17:31Z)

Applied in impact order (feel first). Builds: scratchpad/gf-fix/dist (fixture serve-prod on :5721). Measurements below are the
feel harness (`map3-feel --only …`, runs feel/feel2/feel3/feel4 under scratchpad/gf-fix/) and pixel classes (section 6) on the
re-shot `test/shots-map3-galaxy/`.

- motion.js grabHit (galaxy): floor `SIM.grabMinPxG` 0.75 px (flat keeps 6), reach max(drawn + slop, 7 px mouse / 10 px touch;
  2 px less for coins drawn < 2.5 px), dust tops grabbable at the overview when `S.bubbles.drawsDustTops`. Real-mouse probe
  (scratchpad/gf-fix/grab.mts): overview 120/120 sampled on-screen tops grabbed, 120 of them the pressed coin (before: 61/2,228 had
  drawnPx ≥ 6). $PUMP 4× gen-1 kids: 9–11/60 only (kids r 0.5–5.5 px; even r 5.5 px kids mostly pan) — cause NOT found, open.
- motion.js RP: K 70→100, C_ABS 6→8 (ζ ≈ 0.6 kept), stretch-limit floor `floorPx` 24 / k, rest commit restEPx 0.5 × 4 frames.
  G10 rest 1.66 → 1.176 s PASS, overshoot 3.3 % PASS, trailing 136/136; G7 0 px, G8 ×3, G9 0.0, G11 0.01 px unchanged PASS.
- links.js galaxy veins: per-family overlap normaliser at the overview (new instance attr aDen = family Σ chord / (π Rc²);
  a ×= mix(clamp(1.2 / overlapPx, 0.04, 1), 1, uGalT)); hue-preserving additive cap 0.6 for non-notable / gen ≥ 2 veins (1.0 on
  the focus vein); quiet/cold non-notable veins grey-white #a8b0ac × 0.45, no dash, hairline (core F, no glow) from gen 2;
  dash 0.25 → 0.10 and faded to 0 over 1.5 rimPx past each rim; capPx 18 → 15, gl = min(0.9 core, 6 dpr) + 1.5 dpr, glowA 0.28;
  no neighbour recede in galaxy (FOCUS_DIM unused, CPU mirror too); focus vein: no alpha boost, LDR lime mix, others × (1 − 0.6 dim).
  $Kimchi disc (995,440 r72) white 0.863 → 0.032; blob (650,755 r25) 0.60 → 0.002; b-pump-4x map-area violet 0.0100 → 0.0018.
- bubbles.js galaxy: knock-out ground halo off; 24 h annulus × smoothstep(6, 12, rc) and additive (no dark cut over veins);
  heat × 0.9 floor for discs < 6 px without a landed logo (the #123020 pre-fill made dust tops dark: centre-lit 0.095 before this);
  focus ring breathes ±1.5 px (was × R, which threw it out of [r+2, r+14] on 80 px coins), LDR lime, halo 0.12 ending by r + 16 px;
  other coins × (1 − 0.6 dim); neighbour recede 0.75 → 1.0. G4 centre-lit 0.68 → 0.92–0.94 (gate 0.95).
- labels.js: no focus-family recede in galaxy (focOn false); map3.css galaxy title second line #c9d3cc.
- dust.js: uFocusDim factor 0.4 → 0.6 on specks, nebula, ambient. tokens.js nebula rMinPx 0 → 50 (30 measured nebula 0.28 of ref).

Gates after (feel3/feel4): G1 overview 0.050 PASS, 4× 0.104 PASS, deep $USDC 0.043 FAIL (≥ 0.06; was 0.105 before the width cut);
G2 0.0012 / 0.0096 PASS; G3 worst rim gap 3.5 → 2–2.5 px FAIL (focus-view probe still samples 0 pairs); G6 r / t / label / annulus
lime (0.46–0.48) / panel PASS ×3, lum ratio 1.72 → 1.12–1.14 FAIL (≤ 0.7: at k ≈ 1600 only the coin and its own veins are in view,
so the pulse cannot make the surround darker; metric decision for the lead); G13 nebula 1.15 of ref PASS at rMinPx 50, lime
PASS at overview and 4×, lit +47–84 %, overview violet × 9–13 (now mostly the 2,167 violet-lit quiet dust tops) FAIL.
Not run: G5 (logo supply needs the new server), G12 full perf (the feel G12 rows that ran: p95 16.7 / 16.7 / 16.8 held PASS,
live 0 × 5, 18/31 × 5, 0 errors), G14, map3-qa, map3-perf.

## sizing — flat fix (2026-10-21 20:13–20:48Z)

Owner item 4 ("size by mcap; Pokémon is a very big coin but looks tiny"). Server price chain + liquidity cap + one size rule in three places.

Server (SRV):
- lib/pricing.mjs: `export const LIQ_X = 50` (spec said 100, then lower to 50 if junk stays top 20 with known reserves: on the dev DB copy XTO ctJ2i4k7, locked $0.02, 2 children, pool 11,346 SOL / 0.155 % of supply in the pool, was #1 at 100 = $118.9M; at 50 it is $59.5M, still in the top 10). `mcapCapOf(mcapUsd, liqUsd)`, `liqQuoteOf(c, quoteDecimals)` (pool quote once migrated, virtual quote reserves before).
- lib/model.mjs: `setQuoteUsdMany(obj)` (one kvSet + one bump, only when a value moved); root "other" quote USD through `#rootOtherUsd` (listed price; a root whose quote is a coin we hold = a cycle → null) in both `priceOf` and `computed()` (still one O(n) pass); `mcapCapOf(c, mcapUsd)` reads the quote's USD from the computed table; `mcapCapUsd` on mapRef (map trees, since= nodes, pair) and view (/api/coin) only when capped.
- lib/indexer.mjs: `refreshQuoteUsd()` at start + every 120 s (QUOTE_USD_MS): keys of assetFamilies() minus SOL, USDC, CoinGecko's PUMP and tracked coins → Jupiter lite-api price/v3, 50 per call, sequential, 6 s timeout, `opts.fetch` injectable; accepts usdPrice > 0 with liquidity absent or ≥ $5,000; a failed batch keeps the last values. mapdelta rows carry `mcapCapUsd` always (null = no longer capped).
- lib/dominance.mjs valueOf("mcap") = asset ? 0 : (mcapCapUsd ?? mcapUsd); api.mjs /api/map/dominance with no mode → mcap; openapi MapCoin documents the two optional fields.
- test/quote-usd.test.mjs (new, 4 tests): CARDS 0.36422 → Pokémon priceUsd 3.567e-4 / mcap $356.7k, CHARIZARD 2.533e-5 / $25.3k (±1 %), priceOf == computed, CARDS asset family = Σ members; cycle → null; 79 mints = 2 sequential calls (50 + 29), 1 bump, < $5k liquidity rejected, PUMP never asked/overwritten, failure keeps values; mcapCapUsd present only when capped on map node / view / mapdelta (null clears). test/map-dominance.test.mjs: default mode mcap, asset excluded, cap used.
- `cd SRV && node --test --test-reporter=tap` → tests 321, pass 320, fail 0, skipped 1.

Web (TREE): types.ts BubbleNode `asset?`, `mcapCapUsd?`; sizing.ts valueOf mcap = asset ? 0 : (mcapCapUsd ?? mcapUsd) (adapter valueFn calls it, comment updated); nodes.ts fromMapCoin/sameNode/applyDelta carry both (a full tree that newly flags an asset replaces a cached node); use-map-data coinToMap carries mcapCapUsd. Tests: map-logic (+1 test), map-dominance, map3-adapter updated. `npx tsc -b` exit 0; `npm test` 51/51 pass.

Pre-deploy proof (S/lane-sizing/{proof,fetch-live,patch-live}.mjs, outputs *.out): live map S/flat-base/live-map-all.json (generated 20:00Z) + live Jupiter (80 unpriced asset tops, 2 calls, 80 priced, CARDS $0.36729) + live /api/coin views of the 70 biggest unpriced asset roots (86 calls, 0 × 429, paced 2/s) → S/size-fixture/{map.json,heat.json}: 2,566 coins got a predicted mcapUsd, 798 still null (not fetched), 7 capped (only coins whose reserves are in the dev DB copy of 2026-10-19). Pokémon predicted $419.3k (live priceQuote 0.0011416), CHARIZARD $32.0k. CARDS family mcap rank 2288 ($0) → 34 ($2.25M).
Top 20 by the new mcap weight on that fixture: XTO TbX69Z9Y $1075.7M (2 coins), AODF $452.0M (3), USDF $447.7M (2), NODF $381.5M (2), FOTF $177.3M (2), Kimchi hYAUVemg $83.3M (2), XTO ctJ2i4k7 $59.5M (10, capped), Kimchi CSocnzcR $41.0M (1,821), LUNC $15.2M, BTCs $13.7M, WOTF $13.4M, Baki $12.6M, TTWO $10.3M (asset, 332), BLACKCOIN $7.2M, USOE $5.7M, jobcoin $5.0M, EXFIL $4.5M (17), UHI $4.2M, CLAUDIA $4.2M (92), HOTBOT $3.8M (41). 14 of 20 match the junk rule (locked < $100, ≤ 3 children); their reserves are not in any public endpoint, so the fixture cannot cap them; after deploy the server caps every one at 50 × its quote liquidity, but a coin with real pool SOL and a tiny pool share of supply (XTO: $1.19M liquidity) stays large under any LIQ_X ≥ 20. Lead/owner decision: accept, lower LIQ_X further, or add a second junk guard.

For the lead (files outside this lane, exact changes):
- src/lib/api.ts: add `asset?: boolean; mcapCapUsd?: number | null` to MapCoin and `mcapCapUsd?: number | null` to MapDeltaEntry and Coin (then the local casts in nodes.ts / use-map-data.ts can go).
- src/lib/map/cache.ts: `CACHE_V = 3` → `4` (a warm cache synced within FULL_EVERY_MS keeps asset tops without `asset` until the next full sync, counting their own mcap).
- engine/data.js:43 `mc.push(c.mcapUsd > 0 ? c.mcapUsd : 0)` drives member radii (layout.js rad(mc)) and labels; for members to draw by the capped value too, radius should read `c.mcapCapUsd ?? c.mcapUsd` while labels keep mcapUsd.
P2 (ImageCache.warm thumbnail pre-warm): not done (time).
sizing CDP probe (S/lane-sizing/probe.mts, flat, ?renderer=three, 1440×900 DPR 1, metal, build S/lane-sizing/dist of the tree at 20:33Z; nodePx radius in CSS px): raw live map (:5631) → patched size-fixture (:5630), default size mode (mcap). Overview: CARDS top 3 → 6.5, Pokémon 1.5 → 1.25, coverage 2366/2366 tops, minTopPx 3 in both. CARDS 4×: CARDS top 3 → 11.94, Pokémon 1.5 → 9.55, CHARIZARD 1 → 5.96. ?size=locked on the patched fixture: CARDS 9.3 (overview) / 12.86 (4×), Pokémon 10.29 at 4×. 0 console errors on all three pages. (A build at 20:28Z failed to mount the engine, "Cannot access 'cr' before initialization" = links.js LZ used before its const at :201; the 20:33Z build mounts.)

## veins — flat fix (2026-10-21 20:13–20:48Z)

Owner item 2 ("the veins between the bubbles are invisible"), FLAT look only. Files: engine/links.js, engine/tokens.js (link
entries only). Galaxy: the old width lines now sit inside `#ifdef GALAXY` (its hwc is overridden there anyway), the G-only VEIN
block and every galaxy branch are unchanged.

Changes (line numbers after the edit)
- tokens.js:24-31: `link` [b6ff5c, 5ab0d6, 8c93b8, 9aa49f] (quiet 7c83a8 -> 8c93b8, cold 8a9490 -> 9aa49f, lime unchanged);
  `linkA` [0.90, 0.75, 0.65, 0.60]; `linkW` = W_OV [2.6, 2.3, 2.1, 2.0] CSS px at k0 (linkWGen1 folded in -> 0); `linkWMax` 6;
  new `linkWGen2` 0.75, `linkWFloor` 1.5, `linkAFloor1` 0.45, `linkInk` [0.35, 0.25].
- links.js:131-138: LINK_A = TOK.linkA; FLAT_LOD [0.2, 0.4, 0.2, 0.4] (x k0: no generation LOD under flat, the ink budget
  decides); FLAT_W (floor, gen2, cap, aFloor1, ink, wRef1 2.2, aRef1 0.65, sMax 2.5, smallFam [8, 24] px, long [200, 600, 0.8]).
- links.js:201: `LZ` = the look's LOD windows (galaxy keeps LOD_G2/LOD_G3), used by uLod and lodJS (:1321).
- links.js:375-376, 404, 422: per-family ink accumulators -> new attribute `aInk` (vec2: gen-1 ink, gen>=2 ink = sum of
  W_OV[cls] x g x polyline length (world) x LINK_A[cls]); born links get aInk 0 (:1235-1236, no budget).
- links.js:503: flat link colours = TOK.link (heat colours, premultiplied "over"; vLive stays 0, nothing additive).
- links.js:513-514, 529: uniforms uFlatW (floor, gen2, aFloor1, sMax), uInk (INK_MAX overview, >= 4 k0), attribute aInk.
- links.js:543-564 (vertex shader, `#else` of GALAXY): core w = W_OV[cls] x g x clamp(sqrt(k/k0), 1, 2.5), cap 6 px.
  Disc-ink budget per family: Bk = mix(0.35, 0.25, smoothstep(1, 4, k/k0)) x pi (Rc k)^2; gen-1 tier (gen 1 + pod trunks)
  first: thin by q1 = Bk / I1 toward the 1.5 px floor, then alpha by qa1 (floored at 0.45 later); gen>=2 take the rest
  R2 = Bk - used1: thin toward 1.5 px, then alpha qa2 (no floor: they may vanish in broods whose gen-1 already spend Bk).
- links.js:605-633 (flat alpha): a = LINK_A x budget (gen-1 >= min(a0, 0.45)); emphasised branch -> >= 0.8 a0; the
  1.3 k0 -> 2.2 k0 overview fade-in is GONE (veins at every zoom); small-family cut smoothstep(40, 140) -> smoothstep(8, 24)
  px of disc radius; long fade 0.22 by 320 px -> 0.8 by 600 px (no LONG_W thinning under flat); hover boost caps 0.95 / 0.9.
  Kept: hub fade, uDustExpand hand-off of dust families, pulses' lit links, births (draw-on + FRESH), hover/focus/highlight dims.
- links.js:1668-1708: linkMaxPx() under flat = widest core at the CURRENT zoom (flatWA, same formula as the shader);
  famOfKey(key) (symbol / mint / index via S.famBy, else focused family, else the family at the camera centre);
  NEW S.debugFns.linkMinPx(key?) (narrowest gen-1 core, CSS px) and S.debugFns.veinAlpha(key?) -> {n, min, p50, max,
  inkShare, kOverK0} (alphaOf after the budget; inkShare = sum(w x Lpx x a) / disc area px^2).
- links.js:1711-1731, 1755-1776: flatWA(c) (shader width + budget mirror) and alphaFlat(c) (shader alpha mirror);
  alphaOf() routes flat links to it (galaxy path unchanged).

Measured (probe: S/lane-veins/probe.mts, Chrome metal 1440x900 DPR 1, ?look=flat&debug; build S/lane-veins/dist of the
current tree incl. the bubbles fit: overview S.cam.k = 0.485 live / 0.519 fixture, was 1.116 on flat-base)
| metric | before (flat-base) | after live :5620 | after fixture :5621 | gate |
| linkMaxPx overview | 1.2 | 2.6 | 2.6 | >= 2.0 |
| linkMaxPx $PUMP 4x | 1.2 | 5.2 | 5.2 | |
| linkMinPx("PUMP") overview / 4x | (0.7, not exposed) | 2.0 / 4.0 | 2.0 / 4.0 | >= 1.5 |
| veinShare("PUMP") overview | 0 | 0.0978 (rPx 64) | 0.0989 (rPx 62) | 0.04..0.45 |
| veinShare("PUMP") 4x | 0 | 0.1066 (rPx 255) | 0.1042 (rPx 249) | 0.08..0.45 |
| veinAlpha("PUMP") overview | | n 1597, min 0.141, p50 0.141, max 0.9, ink 0.349 | n 1480, 0.151/0.151/0.9, ink 0.349 | |
| veinAlpha("PUMP") 4x | | min 0.6, p50 0.6, max 0.9, ink 0.25 | same | |
| wash $PUMP disc overview / 4x (min RGB >= 200) | 0.0037 / 0.0008 | 0.0005 / 0.0015 | 0.0003 / 0.0017 | <= 0.03 |
| wash $Kimchi disc overview / Kimchi 4x | | 0.0 / 0.0018 | 0.0147 / 0.0031 | <= 0.03 |
| veinShare("Kimchi") overview / Kimchi 4x | | 0.5788 / 0.4237 | 0.5535 / 0.4176 | (not gated) |
| console errors | | 0 | 0 | 0 |
Open: $Kimchi (1.1k-1.8k gen-1 children in a 50-55 px disc) is 2.5-3.7x over the ink budget at the overview even at the gen-1
floors (1.5 px, alpha 0.45), so its disc reads as a dense cyan fibre sheet (lit share 0.55-0.58, no white: wash <= 0.015).
Lowering FLAT_W.aFloor1 / linkAFloor1 for broods > ~500 gen-1 children (spec allows only gen >= 2 to vanish) would thin it;
not done (binding floor). test/map3-shots.mts:87 still checks flat linkMaxPx <= 1.5 (react_qa lane: now 2.6 by design).
sizing P2 (done after all): lib/meta.mjs `ImageCache.warm(urls, w = 64, concurrency = 4)` → {n, ok, failed} through get() + thumb() (fresh files = hits); lib/model.mjs `warmImageUrls(60)` = logos of allRoots() + asset tops + gen-1 of the 60 biggest families by descendants; index.mjs runs it 3 min after boot and every 30 min (cleared on shutdown) instead of "after backfill" (no hook there without touching the indexer's backfill flow). test/img-warm.test.mjs (2 tests, stub fetch): 11 urls → {n 11, ok 10, failed 1}, ≤ 4 in flight, second pass 0 fetches and 0 redraws; url list = tops + gen-1, not gen-2 nor childless roots. Server suite after P2: tests 323, pass 322, fail 0, skipped 1.
veins — gates run 20:34–20:43Z on S/lane-veins/dist (live upstream :5620):
- map3-perf --look flat: ok true, failures [], 0 console errors; p95 overview idle/pan/zoom/hover 16.8/16.7/16.7/16.7 ms,
  $PUMP 4x 16.8/16.8/16.8/16.7 ms, phone 16.8 ms; quality governor 0 steps (S/lane-veins/perf-flat.log).
- map3-qa --look flat --only a,b,c,e,i: 0 console errors; 1 failure "(b) titles() 19 at 1440x900 (need >= 20)" (labels at
  the new, smaller k0; not a links.js check); 3 network errors = upstream 404s (/api/candles x2, /api/map/heat).
- ?look=galaxy smoke: mounts as three, 0 console errors, linkMaxPx 2.341, veinShare 0.0324 (galaxy paths untouched).
- node --check links.js tokens.js ok; npx tsc -b exit 0.

## bubbles — flat fix (2026-10-21 20:13–20:47Z)
Owner items 1 (logos), 3 (far bubbles), 5 (every child visible). Files: engine/bubbles.js, engine/dust.js, engine/scene.js (fit only), src/lib/map/images.ts. tokens.js untouched (flat constants live in bubbles.js:79-95).
Changes
- bubbles.js:88-95 flat constants: STIP 1.0 / 1.25 px, COV_MIN_F 0.6, FLAT_F [0.80, 0.66, 0.70, 0.80] (was FLAT [0.80, 0.66, 0.62, 0.48]: cold disc max channel 51 -> 76, quiet 109 -> 122), FLAT_DOT_F [1, 0.95, 0.95, 1] (sub-px dots), BODY_TINT_F [0.22, 0.30, 0.34, 0.45] (8 px+ bodies: cold centre ~56 instead of 0x171b1a), TOP_MIN_PX 3, HI_UP_PX 32. Galaxy keeps FLAT / TOK.flatA / TOK.tint / STIP 0.75 / 1.0.
- bubbles.js:390 both looks: every dust-family top minPx = max(3, min(6, 3 + 3 sqrt(share / maxDustShare))) (planets TOK.chipR; phone x0.85 through uMinScale). Galaxy formula was already this.
- bubbles.js:487 VS flat branch: tops a = 1, cov = 1 at every zoom (no uDustExpand for tops); dust MEMBERS keep the uDustExpand hand-off. :467 flat sub-px cov clamp(rpx0/dpr, 0.6, 1); :469 flat radius floor 1 device px; :533 flat dust tops show the logo from 6 px (planets keep 4 px). screenR mirrors all of it (:1038).
- bubbles.js:1328 S.bubbles.drawsDustTops = true in both looks; dust.js:337/341 hides the specks whenever bubbles draws the tops (was G only).
- scene.js:155-176 flat desktop + phone: k0 = min(frame formula, largest k with every top centre +- max(R k, floor) inside the fit rect with a 6 px margin). S.debug.map.fitK0 / fitK0Frame / fitTopsOut.
- Logos: bubbles.js:231 planets ask 64 first (hiWant; 256 only once drawn >= 32 px, or the sel/focus cells); :312 build order = every top at 64 by share ascending (biggest asked last = served first); :1124 assignCells order P3 HI upgrades, then P2 kids >= 10 px, then P1 on-screen tops without a logo (asg.p1/p2/p3 in logoCoverage().assign). Galaxy keeps its old build order + 256 for planets.
- images.ts:28 MAX_INFLIGHT 96 (32 when innerWidth <= 700); :51/:172 a source loads first at the SMALLEST size asked (a 64 never waits behind a 256), :195 the larger size is re-queued with the source's original stamp; imageStats().maxInflight. BURST 2400 / MIN_START_MS 25 / &w= unchanged.
- Debug fns: coverage() + {minTopPxOnScreen, inRect, allOnScreen}; topVis(minMax); kidVis(key, minMax) {fam, sym, kids, inRect, drawn1px, visible, share, p10Max, p50Max, byHeat[4]{n, vis, share}, k, k0}; nodePx(key); logoCoverage().t. Probe = bubble mesh alone through the composer (bloom off, cleared to the ground), 3x3 device px max at each centre.
Measured (1440x900 DPR 1, metal; build /private/tmp/claude-501/-Users-metahuman/8b9f0123-db17-4735-be5c-50987e9a621c/scratchpad/lane-bubbles/dist made from a COPY of the tree at 20:28Z (/private/tmp/claude-501/-Users-metahuman/8b9f0123-db17-4735-be5c-50987e9a621c/scratchpad/lane-bubbles/tree) in which links.js line 512 'new THREE.Vector4(LZ[0]...)' was replaced by the inline array: the tree's links.js (veins lane, mtime 20:18Z) threw "Cannot access 'LZ' before initialization" at mount -> classic fallback "mount-error". Veins lane: LZ (links.js:1320) is read at :512 before its declaration.)
- coverage() overview: before (flat-base live) tops 2366 onScreen 1360 minTopPx 1.5 (2283 tops < 3 px) -> after live h2: tops 2377 onScreen 2377 minTopPx 3.00 allOnScreen true (hist 3to6 2316, ge6 61); fixture: 2228/2228, 3.00. k0 live 0.4997.
- topVis() overview: live share 1.0 (2377/2377) p10Max 76; fixture 1.0 p10Max 76. Phone 390x844 DPR 2 (fixture): coverage all 2228 on screen, minTopPx 2.55; topVis 0.9955 p10Max 72.
- kidVis("PUMP"): live overview share 1.0 (1597/1597) p10Max 82 p50 86; live 4x (k 1.999 = 4 k0) share 1.0 p10Max 76 p50 81, byHeat live 33/33 cooling 45/45 quiet 189/189 cold 1330/1330. Baseline (flat-base screenshot probe): 38 % overview / 91.6 % 4x. Same screenshot probe (full composite incl. veins) on this build: overview 0.961 p10 68, 4x 0.947 p10 56. Phone kidVis 0.9973 (live class 30/32).
- logoCoverage (live, h2 serve-prod :5612, cold Chrome profile, server thumbnails partly warmed by my earlier runs; NOT after map3-warm): rootsDrawn at 1/2/3/4/5/6/7/8 s = 53/262/487/903/1213/1443/1770/2071 of 2377 on screen (2271 with an image): 8 s = 0.871 of on-screen roots, 0.912 of roots with an image; images() inflight 96 queued 10 e429 0; HTTP 429 in the CDP log 0; requests w=64 2186. Baseline 35 of 1360 at 8 s. h1 fixture (:5611): 832 of 2228 at 8 s (h1 = 6 connections).
-  4x kids10: 0 kids >= 10 px at 4x after the new k0 (k0 dropped ~2x with the fit), so the kids10 gate is 0/0 at this camera.
- veinShare("PUMP") on this build (veins lane's links.js) overview 0.0984, linkMaxPx 2.6.
- Perf (fixture :5611, __sporeMap.measure(3000, 'pan')): overview p95 16.7 ms (max 33.4), 4x p95 16.8 ms (max 16.8). test/map3-perf.mts --look flat crashed at "timeout waiting for three map on /map" in its own flow (not investigated in the box).
- 0 console errors (flat desktop, flat phone, galaxy smoke on the fixture). galaxy: coverage 2228/2228 minTopPx 3, topVis 1.0.
- node --check bubbles.js dust.js scene.js ok; npx tsc -b exit 0.
Diffs for files nobody owns (lead applies): motion.js:569 `const dustTopsOn = G && !!S.bubbles.drawsDustTops;` -> `const dustTopsOn = !!S.bubbles.drawsDustTops;` so flat dust tops are hoverable/pickable at the overview like galaxy (today flat picks dust only through the hidden speck grid, showDust >= 0.5).

## react_qa — flat fix (2026-10-21 20:13–20:48Z)

Files: src/pages/Map.tsx (default look = flat, `?look=galaxy` opts in; default size = mcap, `?size=locked`; setMode writes
size=locked / deletes it), map3/ThreeMap.tsx (look fallback flat), map/panel/MapKey.tsx (look default flat), map3/debug-hooks.ts
(`look()` falls back to flat unless `.look-galaxy`), map/draw.ts (debug-only `__sporeRender.logoWant/logoLoaded/logoDrawn`),
test/serve-prod.mts (`--h2` + `--cert-dir`, forwards x-img-thumb + /api/img cache-control), test/map3-cdp.mts
(`--ignore-certificate-errors` for https://127.0.0.1 URLs, `insecure` opt), test/map3-perf.mts (`GALAXY = LOOK === "galaxy"`),
NEW test/map3-warm.mts, NEW test/map3-flat.mts, test/README.md ("The flat fix" section).

BLOCKER found in the integrated tree (veins lane, links.js, not mine): `const LZ` is declared at links.js:1320 but read at :512
(`uLod: new THREE.Vector4(LZ[0], …)`) → engine mount throws "Cannot access 'cr' before initialization" → /map falls back to
classic. Every number below is from a SCRATCH COPY of the tree ($S/lane-qa/tree-tdz) with that one line moved above
`const linkCol = TOK.link.map(` (build $S/lane-qa/dist-tdz). The TREE still has the bug at 20:45Z.

Warm (map3-warm --families 0, live): 2,195 top images, pass 1 cold 109.7 s, 200×2143 / 404×45 / err×7, x-img-thumb 70.5 %,
p50 1231 ms, p90 1853 ms; pass 2 warm 36.8 s, 200×2150 / 404×45, x-img-thumb 70.8 %, p50 227 ms, p90 666 ms, 0×429.
(A full run with 60 families = 8,100 GETs was killed after ~11 min: cold thumbnails at concurrency 24 are ~5 req/s.)

Gates (map3-flat, $S/qa/flat-gates.json; desktop 1440×900 DPR 1, cold profile, no look/size param):
| gate | value | target | | upstream |
|---|---|---|---|---|
| look() default | flat | flat | PASS | all |
| G1 roots logo @8 s | 0.891 (2116/2376, withImage 2270) | ≥ 0.90 | FAIL | live h2 (first run after warm) |
| G1 roots logo @8 s | 0.955 (2271/2377) | ≥ 0.90 | PASS | live h1 (second run, thumbs warm) |
| G1 e429 / CDP 429 | 0 / 0 | 0 | PASS | h2 + h1 |
| G1 maxInflight | 96 | 96 | PASS | |
| G1 kids ≥10 px @ $PUMP 4× | 0/0 (kids10 = 0) | ≥ 0.90 | n/a | no child reaches 10 px at $PUMP 4× |
| G2 linkMaxPx overview | 2.6 | ≥ 2 | PASS | live h2 |
| G2 linkMinPx(PUMP) overview | 2.0 | ≥ 1.5 | PASS | |
| G2 veinShare(PUMP) overview / 4× | 0.0974 / 0.1076 | 0.04–0.45 / 0.08–0.45 | PASS | |
| G2 white $PUMP ov / 4× | 0.0004 / 0.0013 | ≤ 0.03 | PASS | |
| G2 white $Kimchi ov / 4× | 0 / 0 | ≤ 0.03 | PASS | |
| G2 veinAlpha(PUMP) | n 1597, min 0.109, p50 0.109, max 0.9, inkShare 0.349 | (gen-1 ≥ 0.45 not separable) | report | |
| G3 tops on screen / minTopPx | 2376/2376 / 3 | all / ≥ 3 | PASS | |
| G3 topVis | 1.0 (p10Max 76) | ≥ 0.95 | PASS | |
| G3 phone 390×844 DPR 2 | 2377/2377, minTopPx 2.55 | all, ≥ 2.5 | PASS | |
| G4 toggle default | pressed [mcap], no size param | mcap | PASS | |
| G4 Pokémon in CARDS 4× | largest of 40 kids, r 9.55 vs 1.50 (×6.37) | largest, ≥ 2× | PASS | size-fixture vs mapThree |
| G5 kidVis(PUMP) overview / 4× | 1.0 / 1.0 (1597/1597), p10Max 76, live/cooling/quiet/cold 34/47/186/1330 all 1.0 | ≥ 0.80 / ≥ 0.95 | PASS | |
| C1 coin page /c/Baton#tree | want 11, loaded 11, drawn 11 within 5 s | drawn == loaded | PASS | live h2 |
| console errors | 0 | 0 | PASS | |

Other: `npx tsc -b` 0; `npm test` 51/51; server `node --test` 320 pass / 0 fail / 1 skipped. map3-qa (no --look, live h1,
dist-tdz): 0 console errors, ok false: (b) titles 18 (need ≥ 20); (f) ×4 because section (f) still clicks "mcap" and expects
?size=mcap — it must now start from `/map?size=locked`, click "mcap" and expect the size param gone (or click "locked" and
expect size=locked); (j) dragCoin intrusion visibleDiscPx 6.9. NOT RUN (box end): map3-qa --look flat / --look galaxy, map3-perf,
map3-shots into test/shots-map3-flat/.

## integrator — flat fix (2026-10-21 20:46–21:13Z)
Build: S/flat-qa/dist (integrated tree, `npx vite build`). Servers: :5650 live h1, :5651 live h2 (`--h2 --cert-dir S/qa/cert`), :5652 fixture S/mapThree, :5653 fixture S/size-fixture. Chrome metal, 1440×900 DPR 1.
Integration edits (all one-liners; old copies in S/flat-qa/before/ and S/flat-qa/map3-{qa,shots}.before.mts):
- engine/motion.js:569 `dustTopsOn = !!S.bubbles.drawsDustTops` (was `G && …`, the bubbles lane's request): flat dust tops are pickable now that dust specks hide.
- engine/data.js:43 member `mc` reads `mcapCapUsd` before `mcapUsd` (the sizing lane's request).
- lib/map/cache.ts `CACHE_V` 3 → 4 (the sizing lane's request: warm caches lack `asset` / `mcapCapUsd`).
- test/map3-qa.mts (f): mcap is the default; the check goes locked (→ ?size=locked) then mcap (→ no size param), and no longer clicks back to locked.
- test/map3-shots.mts: flat linkMaxPx gate is now 2.0–6.0 at the overview and 1.5–6.0 elsewhere (it was ≤ 1.5).
- The links.js LZ TDZ the lanes reported was already fixed in the tree (LZ is at :201, used at :513).
Gates:
- node --check engine/*.js ok; `npx tsc -b` 0; `npm test` 51/51; server 323 tests, 322 pass, 0 fail, 1 skipped.
- map3-flat on live h2 + `--coin` (S/flat-qa/flat/flat-gates-int-live-h2.json): default look flat; G1 0.538 FAIL (1281/2381 at 8 s, 2272 with image; e429 0, HTTP 429 0, maxInflight 96); G2 linkMaxPx 2.6, linkMinPx 2, veinShare 0.0999 overview / 0.108 4×, white $PUMP 0.0005/0.0015, $Kimchi 0.003/0; G3 2381/2381, minTopPx 3, topVis 1 (p10Max 76); G5 kidVis 1 overview, 1 at 4× (every class 1), p10Max 76; G1 kids10 0/0 (N/A); C1 Baton 11/11; 0 console errors.
- G4 on S/size-fixture vs S/mapThree: Pokémon is the largest $CARDS child, r 8.58 vs 1.50 (5.72×). Phone G3 (fixture): 2228/2228, minTopPx 2.55.
- map3-perf --look flat (live): ok, 0 failures; p95 16.7–16.8 at the overview, at $PUMP 4× and on the phone; quality governor never stepped down; reduced motion 0 renders.
- map3-shots --look flat (fixture): ok, 0 failures, 0 console errors → test/shots-map3-flat/ (+ c-coin-page.png from the C1 run).
- map3-qa --look flat (live, full): 0 console errors; fails (f) 1/5 mcap top families labelled, (j) dragCoin intrusion 2 coins (the dragged "biggest family" is now junk $XTO, 6.9 px disc), (l) 118 idle renders under OS reduced motion while logos were still loading (logoWaitMs 45058, not drained; the no-look rerun drained: 0), (n) DOM +300 / listeners +57 per cycle — flat-base :5500 shows the same per-cycle growth (1422 → 2681), so it is older than this round; engine live 0 after every unmount.
- map3-qa no --look (a,b,f,l): a ok, l ok; (b) titles 14 (need 20; the full --look flat run passed b), (f) 2/5. Galaxy smoke (a,b,c): ok, 0 console errors.
- G1 rerun at 21:13Z (live h2, cold Chrome profile, same serve-prod process): 0.954 (2272/2382, every root with an image; 2175 already by 2 s). This run was served from serve-prod's own /api/img proxy cache, which the first run had filled, so it does not show a production first visit. The first run (0.538, about 150/s for 4 s, then about 90/s) is the figure for live upstream latency at 20:54Z (warm pass p50 423 ms, p90 1678 ms, x-img-thumb 70.8 %).

## fixer — flat fix, critic round (2026-10-21 21:23–21:43Z)

Build: S/fixer/dist (S = scratchpad). Servers :5670 live h2, :5671 size-fixture, :5672 mapThree, :5673 fresh live h2; all stopped.
Results: S/fixer/flat-gates.json (tags fix-live-h2, fix-fixture, fix-live-h2-g1), logs S/fixer/*.log.

1. Thin-family guard (mcap mode), identical in web sizing.ts (isThinFamily + familyWeights), adapter.ts valueFn(mode, roots)
   (ThreeMap passes input.roots), server dominance.mjs familyShares: a family of <= 3 coins whose members lock < $100 in
   all is weighed by each member's locked-mode value. Size-fixture top 10 by the guarded weight: XTO(10 coins, capped),
   Kimchi, WOTF, TTWO, EXFIL, CLAUDIA, HOTBOT, PUMP (rank 8, 1.82 %, was 0.1 %), VEIL, ZEC; none matches the rule; CARDS rank 14.
   NOT caught: mapThree's 4-coin XTO ($953M, locked $0.03) still shows 89 % in the fixture overview shot; the size-fixture's
   10-coin XTO is held to $59M only by the server's mcapCapUsd (deploys with the server). Lead: THIN_MAX_COINS 3 -> 5 would
   catch the fixture case (no 4-5 coin family in the size-fixture top 60 matches).
2. images.ts MAX_INFLIGHT 192 was tried and REVERTED to 96: fresh serve-prod on live h2, G1 = 0.204 at 8 s with 192
   (~10 logos/s after the first 0.5 s); 0.275 with 96 on another fresh server. curl of live /api/img?w=64 at 30 concurrent:
   0.4-1.9 s each. The live thumbnailer is the bottleneck; the server pre-warm deploy is the fix, not the client cap.
3. links.js: the gen-1 floor now holds on the FINAL alpha (shader after coverage, alphaFlat mirror). veinAlpha gains gen1
   {n,min,p50}. Fixture: $PUMP gen-1 n 136, min 0.60, p50 0.60; the other 1,344 veins (p50 0.175) are gen >= 2 (spec lets
   them fade in broods > 500). veinShare($PUMP) 0.1007 / 0.1034 (4x); white $PUMP 0.0067 / 0.0022, $Kimchi 0 / 0.0001.
4. bubbles.js (flat only): every family top shows its logo from LOGO_MIN_PX = 4.5 px (was 4.0 non-dust / 6.0 dust tops);
   logoCoverage gains roots6 / roots6Drawn. Live: 127 tops >= 4.5 px, 116 with a logo, of 2,386 (critic: 61 >= 6 px, 59
   logos). Most tops sit at the 3 px floor, so this alone does not put logos on most far families (owner decision: 3 px
   logo threshold or a higher floor curve).
5. test/map3-flat.mts: G1 divides by rootsWithImage; maxInflight gate 96; "visible logos overview" row; kids-logo gate at
   $PUMP 12x (live: 0.92, 23/25, PASS); G2 gate on veinAlpha gen-1 min >= 0.45 (PASS 0.60).
6. server test/quote-usd.test.mjs: the 3-coin CARDS test family is thin now; asserts members' mcap = 356,700 + 25,330 and
   the guarded family value 1,000. Server: 323 tests, 322 pass, 0 fail, 1 skipped. Web npm test 51/51, tsc -b 0.
Shots: map3-shots --look flat on the mapThree fixture: ok, 0 failures, 0 console errors -> test/shots-map3-flat/.
- fixer addendum 21:43Z: THIN_MAX_COINS raised 3 -> 5 (web sizing.ts + server dominance.mjs, tests updated). Guarded mcap top 10:
  size-fixture XTO(10, capped) 30.9 %, Kimchi 21.3 %, WOTF, TTWO, EXFIL, CLAUDIA, HOTBOT, PUMP 1.86 % (rank 8), VEIL, ZEC;
  mapThree Kimchi 45.1 %, CLAUDIA, PUMP 3.67 % (rank 3), HOTBOT, EXFIL, nub, VEIL, DOPE, NTRNDM, Kimchi(12). The fixture's
  4-coin XTO ($953M) is out. Shots re-run on the new build: run 1 failed "mid-drag-overview: the map did not come to rest";
  run 2 ok, 0 failures, 0 console errors (flaky 1 of 2). Server 322/323 pass (1 skipped), web 51/51, tsc -b 0, node --check ok.
  G1/G2/G5 live and fixture numbers above were measured with THIN 3; the guard does not touch those gates.

## scope — all-scope coin view + listed-asset logos (2026-10-21 21:44–21:48Z)

Owner item 2 ("family value shows 0 for coins not launched on Spore though they have many pairs"). Server only; no web change.
- lib/model.mjs: `view(c, { all = false } = {})` → `all ? scopedAll(c) : scoped(c)` (only change inside view(); the default stays
  the listing scope). Above assetMapRef: `assetIcons` (class field), `setAssetIcons(obj)` (https only, adds each URL to
  imageUrls so knownImage() passes, kv "assetIcons", stamps one member so the asset node rides `since=`, one bump) and
  `assetIconOf(mint)`; assetMapRef `image:` = metadata image ?? asset icon; load() restores kv "assetIcons" after oursPending.
- lib/api.mjs: /api/coin and /api/tree view the coin, every child row and every node with `{ all: !oursOnly }`; the
  children/otherChildren override is gone (scopedAll.children == childrenOf().length and otherChildren 0 on every fixture coin,
  proven in coin-scope.test.mjs); /api/search both calls `{ all: true }`. `scope=ours`, /api/roots, /api/feed, /api/stats and the
  /api/spawned `coin` keep the listing scope. lib/indexer.mjs: the 3 SSE "coin" emits → `view(x, { all: true })`, filters unchanged.
- lib/asset-icons.mjs (new) + one line in index.mjs: Jupiter tokens v2 search (public, comma-separated mints, 50 per call, 6 s)
  for asset-family mints whose metadata has no image, at boot and every 6 h (unref'd); https + isAllowedImageUrl only; no logo
  is drawn or invented. /v1: unchanged (mapRef(c, true)), now covered by a test in ours mode.
- Tests: test/coin-scope.test.mjs (8), test/asset-icons.test.mjs (5); 4 of the 8 fail on the old api/indexer. Server suite:
  336 → 343 tests with the pricing lane's, 0 fail, 1 skipped.
- Measured, SHOW=ours on a copy of the 22.7k-coin local DB (:5292): $Kimchi /api/coin descendants 0 → 1,832, lockedUsd 0 →
  $95,197.53 (= /api/map?scope=all node, Δ 1.7e-7; /api/search, /api/tree, /v1 family the same); $baton 0 → 25 / $23,751.35
  (= its asset node when sampled together). Live sporepad.com before: Kimchi children 1,788, descendants 0, locked 0. Asset
  tops with an image 76/80 → 80/80 (USDC, WBTC, WETH, Jimothy); USDC logo through /api/img?w=64: 200 image/png.
- For the lead: model.warmImageUrls (flat lane) warms asset logos from metaFor() only; `?? this.assetIcons.get(mint)` in its
  `add` for asset mints would pre-warm the USDC/WBTC/WETH thumbnails too. Open: /api/coin/<listed asset> (PUMP) still 404s.

## pricing — mcap fix (lane:pricing, 2026-10-21 21:45–21:56Z; prepared in S/fix-pricing from 20:33Z)

Owner item "the system shows the market cap wrong for most coins". Server only; no web file touched.
- lib/pricing.mjs: `poolPriceQuote(poolQuote, poolBase, bd, qd, virtualQuote = null)` = (quote vault + the pool's signed
  i128 `virtual_quote_reserves`) / base vault, the sum in BigInt; effective side <= 0 or base <= 0 → null; null vq = the old
  number exactly. `priceQuoteOf` passes `c.poolVirtualQuote`. `liqQuoteOf` (LIQ_X cap) and every locked sum keep the real vault.
- lib/model.mjs: upsertCoin default `poolVirtualQuote: null`; `quoteMcap` map + `setQuoteMcap/quoteMcapOf` (kv "quoteMcap",
  restored in load()); assetMapRef `mcapUsd` = quoteMcapOf(mint) ?? quoteUsd × on-chain supply (display only; the asset top
  still counts 0 in mcap sizing).
- lib/db.mjs: `coins.pool_vquote TEXT` (CREATE + ALTER guarded by the column's absence, no version bump), upsert + both mappings.
- lib/indexer.mjs: CoinGecko call `&include_market_cap=true` → setQuoteMcap for QUOTE_PRICE_IDS (PUMP); ensurePools reads a
  known pool directly when vq is null (filter `migrated && (!poolQuoteVault || poolVirtualQuote == null)`), writes vq, returns
  {coins, read, vqNonZero, vqNegative}, logs on the full pass; `backfillPoolVq()` once at start(); refreshVaults reads
  [pool, base, quote] per coin, 33 coins (99 accounts) per call, a pool that does not decode keeps the old vq; ensureAncestors
  reads the pool of an ancestor that arrives already migrated (else the chain under it waits for the rolling refresh);
  #onPoolTrade prices with the stored vq. The three SSE "coin" emit sites are untouched (SCOPE lane).
- test/pool-vquote.test.mjs (new, 7 tests; all 7 fail on the unpatched code). test/quote-usd.test.mjs: the thin CARDS family
  assertion follows SPEC §3.1 (Σ lockedUsd, no $500 leaf slice; the WEB lane's dominance.mjs change made the old 1,000 fail).
- scripts/mcap-audit.mjs (new, committed copy of S/fix-pricing/mcap-audit.mjs): `--base --sample --seed --onchain --gate --json`
  + explicit mints; reference = pump.fun live (coins-v2 market_cap_quote × the quote's live USD, walked up pump.fun's chain);
  columns served / chain (every step read on chain incl. vq); prints `within5 k/n`, the miss list with class and pump.fun's
  last-trade age. Server suite: 343 tests, 342 pass, 0 fail, 1 skipped.
Measured: BEFORE sporepad.com seed 7: within5 17/50 (34 %); 24 migrated-pool, 8 token-quoted-chain, 1 supply (PUMP x2.076).
AFTER local patched SRV (DB copy 2026-10-19, 2,744 coins): seed 7 local sample 45/50 (90 %); the prod sample's 50 mints 46/50
(92 %). Gate 48/50 NOT met. Residual misses: PUMP x1.153-1.157 (CoinGecko circulating mcap vs pump.fun's 399.46B supply; class
supply), pump.fun-stale (chain = served, pump.fun's last trade 17.8-229.5 h old: KUNDALINI, Larp, Winnie, CHROG), one stale
curve (SATS, traded 6 h ago, x1.055) and Gato's pool lagging between refreshes (Mono/Vepe x0.862). Whole local map: 709
migrated coins, vq != 0 693 (29 negative), factor p50 3.83 / p90 19.45 / max 108.5; served off > 5 % vs the vq price 1/709
(vs the vault-only price 647/709). Pool backfill at start: 707 pools read, vq != 0 691, vq < 0 29.
Not verified: whether pool vq is immutable (it is re-read on every refreshVaults); whether pump-amm Buy/SellEvent reserves are
pre-trade (Gato's recorded trade prices rise across two sells, which fits pre-trade); pump-amm Buy/SellEvent also carry
`virtual_quote_reserves` (i128), which decode.mjs does not surface yet.

## web — size modes, logos in both modes, legend (lane:web-sizes+logos, 2026-10-21 21:45–22:0xZ; prepared in S/fix-web from 20:33Z)
Rule (one family rule everywhere: lib/map/sizing.ts familyValueOf = server lib/dominance.mjs familyValueOf = map3 adapter valueFn
= engine data.js defaults): mcap = Σ (asset ? 0 : mcapCapUsd ?? mcapUsd) over the family; locked = Σ lockedUsd. The leaf slice
min(2 % mcap, $500) is gone (valueOf stays as an alias). The flat workflow's thin-family guard is kept (a thin family in mcap is
weighed in locked terms, which is now Σ lockedUsd < $100, i.e. it stays small). Children (every non-top) are sized by their own
market cap in both modes: classic `coinRadius(coinMcap(d))` = clamp(floor, maxR, floor × mcapRadius / 0.55), mcapRadius = layout.js
rad() verbatim, coinMcap = mcapCapUsd > 0 ? cap : mcapUsd (the same as data.js mc[]); map3 rad() untouched. Tops: k = rangeR /
√(topMaxWeight), maxW over tops only (BubbleMap passes it). Coin-page card (focus): this coin and its ancestors keep the value scale;
every coin under it is coinRadius capped at 0.7 × maxR. map3 data.js: f.valueL/valueM, shareL/shareM, rankL/rankM; f.rank = order by
min(rankL, rankM), ties max(rankL, rankM), members desc, top mint; planets/dust/ranked are mode-independent; S.maxShare = largest
planet share of the current mode (planets[0] is no longer the max). ThreeMap passes `values: valueFns(input.roots)`. Legend: the
two SIZE_MODE_LINE strings (sizing.ts) in MapKey (classic + three) and as the toggle buttons' titles; Map.tsx classic lead no longer
says "sized by the value they lock".
Measured (M4 metal 1440×900, scratch bundle S/fix-web/dist from the tree, serve-prod --h2 :5293, live upstream sporepad.com):
- map3 flat overview, logos drained, locked → mcap → locked via the UI button: drawn-with-logo 59 → 58 → 59, kept 0.966 / 0.983
  (gate 0.95 PASS; before this change 58 → 61, kept 0.328 / 0.311); planet sets 60/60 identical (before 18/60); Σ share 1 ± 2e-15;
  chipFloored 26 / 26; planets with a logo 57/60 (no image: USDC, 2yeyNC83…, 2c1Kjiy…); 0 console errors.
- map3 galaxy: kept 0.982 / 0.982, planets 60/60, Σ share 1, 0 console errors.
- coin page /c/$Kimchi#tree (card, focus mode): kids drawn with logo 98 locked / 98 mcap, kept 1.0, kid radii 126/126 identical
  (before: 97 locked / 0 mcap: the owner's "mcap removes logos").
- classic /map overview (?renderer=classic, zoom 0.133): tops with a logo 5 / 5, kept 0.8 (gate FAIL on a set of 5; before 3 / 7,
  kept 0); non-top radii 21,067 same / 1 diff (a live mcap tick mid-run); offline on one snapshot (23,461 coins): 21,075 / 0 diff.
- server familyShares vs web dominance on the live forest (2,386 families): worst |Δ share| 0 (locked), 5.2e-18 (mcap).
- node --check engine/*.js ok; tsc -b 0; npm test 53/53; server node --test 336: 334 pass, 1 fail, 1 skip — the fail is
  test/quote-usd.test.mjs:67 `near(fam.value, 1_000)` (the thin CARDS test family was weighed by two $500 leaf slices; with the
  slice removed it weighs 0): pricing-lane file, left to the lead (fix: `assert.equal(fam.value, 0)` + comment).
Open: live mcap shares are dominated by one 11-coin family (ctJ2i…, 91 % of mcap on the live API, above THIN_MAX_COINS 5), so the
other mcap chips are small (chipFloored 26/60 in both modes) until the server's caps deploy; layout.js packs planets in f.share order with share-sized chip
hulls, so planet POSITIONS still move with the mode (the set and order do not); USDC logo pending the scope lane's server deploy.

## family-all — every asset-quoted coin as ghost / real dust (lane:ENGINE, 2026-10-24, DESIGN-FAMILY-ALL.md §5)

Owner: "hepsini ekle o %2.6'sı". Files: NEW engine/swarm.js, engine/swarm-slots.js; engine/data.js (f.ghost, f.size, S.ghostTotal),
labels.js (true size on the planet label / tooltip family row / pinned name / aria-label; dust tooltip; pinned name of a hovered or
selected speck), motion.js (dust index space DUST0 = 4,194,304 + slot in hitTest `via "dust"`, idxOf / mintOf / posOf / famOfIdx /
topOf, select / hover / flyToCoin / tooltip, trade flash on a speck, highlight to the swarm), focus.js (dust target k = max(family
frame, 16 / s_f), fly + pulse), index.js (buildSwarm after buildDust, swarm.start() after the first frame, swarmAdd / swarmDrop /
swarmFamilies, HEAVY), index.d.ts (§3b + EngineCoin.children, EngineOptions.swarm), ThreeMap.tsx (families prop: onSwarmWant →
want "view", chunk → swarmAdd, evict → swarmDrop, replay after every build, onSelect via families.node, echo on the store version,
no select-unknown rebuild while busy / familyOf), adapter.ts + use-engine-sync.ts (highlight resolves a speck through
families.node), debug-hooks.ts (swarm(), swarmFamilies(), swarmDrop(), clusters()[k].size). Tests: test/map3-swarm.test.mts (9),
test/map3-swarm.mts (CDP gates), test/make-swarm-fixture.mts.
- Retune (reported per §2): C_MAX 0.14 → 0.06 and a 25 % outer-edge alpha feather (EDGE). With 0.14 the overview drew a grey disc
  with a hard rim around $PUMP (+11.2 sRGB levels over the disc) and grey static at 4x; 0.06 + feather reads as a faint halo at
  the overview (+4.1 live / +5.2 fixture), a fine grain at 4x (+5.4 / +4.4) and separate dots from ~8x (A_GHOST caps). Knobs live:
  `__sporeMap.call("swarmTune", {cMax, aGhost, edge})`.
- index.js compiles the scene against the composer's linear target: compiled with no target bound, three keyed every program to
  the sRGB output and the first frame compiled each scene program again (programs 23 → 17 at ?swarm=0; the swarm adds exactly 1).
- Measured (M4, headless Chrome, scratch dist, serve-prod; fixture = live payload with prod asset counts, Σ ghost 301,455 drawn):
  metal @1 / @2 measure p95 16.7–16.8 ms at the overview (idle/pan/zoom/hover) and at $PUMP 4x / 12x with 76,228 real specks;
  phone 390×844 @2 60 fps, ghosts ≤ 5,000 and real ≤ 20,000 per family; SwiftShader overview p95 350 ms vs 383 ms at ?swarm=0
  (0.91×; 27,595 ghosts). Generation 71–75 ms CPU in ≤ 7.4 ms slices after the first frame; build / first frame −84…+15 ms vs
  ?swarm=0 (noise); no long task after the first frame through generation + 3 loads; drain slices p95 2.2–2.6 ms, max 2.5 ms on
  the store path, 3.8–5.8 ms with 200k synthetic rows made in one task (a V8 scavenge landing in a slice). Heap +9.3 MB with 3
  families (PUMP 76k, USDC 41k, SPCX 17k real), −4.3 MB after dropping PUMP and loading SPYx. swarmCheck outside 0, onDrawn 0,
  overlaps 0, hash equal across mounts; Σ ghost + N = indexed().derived.
- Feel / qa / perf vs the pre-lane build (scout dist), same live API: map3-feel flat 26 vs 28 PASS (the 2 flips re-measured as noise:
  G6 lum ratio = logo cache warmth, G13 pump4x violet 0–0.0005), galaxy 46 vs 44 PASS (G7–G11 drag identical PASS, G9 0.0);
  map3-qa: (b) planet title regex `\d[\d,]* coins` rejects the doc's `51.7k coins` (test file needs `\d[\d,.]*k? coins`), (o)
  fails on both builds; map3-perf ok (base: 2 flaky fails).
- Fix round after the critics (2026-10-24; critic-visual: "the previous look was nicer", a grey veil / "grey moon", a halo ring at
  0.8 Rc, craters, rank-sized specks, a rigid drag disc). The density-normalised alpha (C_MAX / A_GHOST / EDGE) is gone:
  - Look: separate 1 device px dots at a fixed alpha (A_DOT 0.42) in TOK.rim[3] (one step under a drawn cold coin), thinned by
    zoom: slot j shown when its hash rank (thinRank) < (σ / SIG_MIN)², σ = the family's densest slot spacing in device px,
    SIG_MIN = max(2.5 device px, 1.5 CSS px); ranks q … 1.25 q fade in. Tier caps are a hash-rank cut (rankCut), not j % stride.
    Real specks: live / cooling keep their heat colour (A_REAL 0.55, never thinned); quiet / cold at A_DOT × K_REAL 1.0; size by
    market cap (1 device px up to $4.5k, log to 2 CSS px at $450k), not rank. labels.js hands the swarm the rects of the labels
    over a ghosted family (planet, gen tags, children, pinned name; ≤ 24, 4 px soft edge): no dot between the words.
  - Field (swarm-slots): r1 = min(0.97 Rc, drawn extent + 2 s0); acceptance = w × taper × ramp against a seeded hash, w = a
    box-blurred density map of the drawn members normalised by 0.6 × its median (the grain sits where the coins are: no halo
    ring, no circle), ramp 0 inside R + 0.3 u, then up over min(2 s0, member spacing / 3) + R / 2 (no crater edge).
  - Drag: each slot is anchored to its nearest drawn member (edge distance); the anchor rows of the family texture (half an
    RGBA texel per member) follow every "positions" event, so the grain trails its chain (the layer still adds 1 texture).
  - Timing: generation slice deadline 8 − 3 ms (genSliceMaxMs 5.5–6.3), drain deadline 4 − 2 ms checked every 16 rows, mint
    arrays pre-sized (no 64k-element push copies in a slice). Generation CPU 245 ms for 306k slots / 100 families (was 71–75 ms
    with the uniform field; the silhouette fit + ramp cost it), wall 490 ms, all in ≤ 6.3 ms slices after the first frame.
  - Measured (M4, headless, scratch dist, serve-prod): live prod payload (fx-live, 67 ghosted families) on − off luma: overview
    +0.11 (was +0.48), $PUMP 2× +0.37 (was +1.37), 4× +0.45 (was +1.36), 8× +0.65 (was +2.42); radial on − off at $PUMP 4×:
    0–0.1 Rc +1.0 (was +7.0), 0.8 Rc +0.9 (was +3.2), ≤ +2.1 anywhere. map3-swarm on the prod-count fixture (Σ ghost 301,455):
    72 PASS / 0 FAIL / 2 N/A (overview luma +0.81, 4× +1.22, perf p95 16.7–16.8 @1 / @2, phone 60 fps, ghosts ≤ 5,000 / real ≤
    20,000 per family, SwiftShader 0.83× of ?swarm=0, build +10.5 ms, textures +1, addSliceMaxMs 3.6–3.7 on the first mount;
    the synthetic 200k-row path still sees one 4.1–5.2 ms slice on some second mounts, 0 alloc in it: a GC pause; the store
    path max is 2.1–2.6 ms). Drag (held, $PUMP 6×, 1,686 sampled slots moved ≥ 4 px): 76 % have a lit dot at build + anchor
    displacement vs 36 % at a 20 px chance offset. map3-feel G7–G11 on fx-live identical to the pre-lane scout build (flat 5 PASS / 5 FAIL, galaxy 7 /
    4, the fails are the same on both). Knobs: `__sporeMap.call("swarmTune", {aDot, sigMin, aReal, kReal})`.
