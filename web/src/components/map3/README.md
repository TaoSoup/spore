# map3: the WebGL renderer of /map

`/map` draws the whole pump.fun pair ecosystem (about 22.5k coins in 2.3k families) with three.js. This
folder is that renderer: a port of the Three.js prototype (60 planet families plus dust, an orthographic
camera, UnrealBloom, instanced spheres, hairline bundled links, HTML labels, coin dragging with a liquid local
response, pulses and births from real trades, render on demand). The classic Canvas 2D `BubbleMap` stays as
the fallback, and it still draws the coin page's family tree and the `/embed/*` pages.

`LANES.md` is the build log of the port (what each lane decided, measured). This file is the reference.

## Architecture

```
pages/Map.tsx ──eager──> map3/probe.ts       WebGL2 + EXT_color_buffer_float probe (memoised)
              ──eager──> map3/guard.tsx      error boundary, sticky fallback, kill switch
              ──lazy───> map3/ThreeMap.tsx   the React shell (own chunk: three + engine + map3.css)
                           ├─ adapter.ts         pure: nodes -> engine forest, values, shares, heat, tags, diffs, drift rule
                           ├─ use-engine-sync.ts live data -> engine (lib/events subscribe, heat, nodes, highlight, tags, motion)
                           ├─ debug-hooks.ts     window.__sporeMap for the QA scripts (only with DEBUG_HOOKS / ?debug)
                           ├─ map3.css           every selector under .m3 (tokens --m3-*, Geist / Geist Mono)
                           └─ engine/index.js    mountEngine(container, opts) -> EngineHandle (typed by engine/index.d.ts)
```

- **Data.** The engine never fetches and never opens a stream. ThreeMap hands it the page's already-loaded
  data: `useMapData` nodes (through `adapter.buildRoots`, which reproduces the server's DFS order), `useMapHeat`
  heat, and `lib/events.subscribe` for `trade` and `pair` events (the tab's one shared EventSource). Logos come
  from `lib/map/images.ts` (`imageFor` / `onImageLoaded` / `imageReady`).
- **Engine.** Plain JavaScript in `engine/` (ported from the prototype; blocks marked `(map3 port)` and
  `(final fix)` changed). `engine/index.d.ts` is the only typed surface; TypeScript never parses the JS.
  Modules talk through one shared state `S` (`state.js`). Every listener, timer, animation frame and observer
  goes through `S.life`, so `destroy()` releases everything. Build order, with a macrotask between steps and an
  abort check after each: ingest, layout (yields every 40 ms of work), dust, scene, bubbles, links (yields every
  40 ms), labels (font race of at most 1.5 s), motion, shader compile, first frame.
- **Lifecycle.** One engine per build. A build happens for the first paint and when the size mode, the roots
  limit or the phone band (container width ≤ 700 px) changes, for a selection the engine does not know, for
  drift (many unknown or removed coins while the map is idle), when the Key's last-trade mask changes (reason
  `last`: rebuilt from lib/map/visibility.ts buildSet's filtered set once the toggles settle), and after a lost WebGL
  context. A new engine
  renders hidden while the old one stays on screen; on success the old one fades out and is destroyed 160 ms
  later. An unmount aborts any build and destroys everything. `window.__sporeMap3.counters()` counts live
  engines (0 after every unmount).
- **The page owns selection.** The engine reports clicks through `onSelect`; Map.tsx writes `?focus=` and
  passes it back as `select`; the echo is a no-op when they agree. Insets (left column, side panel, sheet) and
  the page chrome's rectangles reach the engine before the echo, so a flight lands in the visible area.

## Every coin of a capped family: the swarm (`engine/swarm.js`, DESIGN-FAMILY-ALL.md)

`/api/map` draws a capped slice of every listed-asset family (ASSET_FAMILY_DRAW = 300 per asset plus the keep set); the
asset top's `children` is the true count. `data.js` sets `f.ghost` (asset tops: children − drawn kids) and `f.size` (members +
ghost: the planet label, the tooltip's family row, the pinned name and the canvas aria-label print it). Undrawn coins never
enter layout, links, the family value or the sim.

- **Ghosts.** One `THREE.Points` (renderOrder 1, after the dust field, under arcs / links / bubbles). Per ghosted family,
  `swarm-slots.js` (pure) lays `ghost + spare` slots on an area-true Vogel spiral seeded by FNV-1a(top mint), inner → outer
  (slot j = the j-th undrawn coin in server order), and keeps the drawn silhouette: the outer radius is the drawn extent +
  2 slot spacings (≤ 0.97 Rc), a candidate is accepted against a hash with probability w × taper × ramp (w = a box-blurred
  density map of the drawn members, so the grain sits where the family has coins; taper = the last few slot spacings
  before the edge; ramp = 0 inside a drawn disc + 0.3 u, rising over ≤ ⅓ member spacing + ½ R outside it, so the grain
  thins toward a seed head instead of a crater). Generated after the first frame in ≤ 8 ms slices (3 ms slack), then a
  400 ms fade. Drawn as the map draws coins: separate 1 device px dots at alpha 0.42 in the cold rim colour (#535b58, one
  step under a drawn cold coin), thinned by zoom (slot j shown when its hash rank < (σ / SIG_MIN)², σ = the densest slot
  spacing in device px, SIG_MIN = max(2.5 device px, 1.5 CSS px)): never a veil, more dots as you zoom in. Labels over a
  ghosted family (planet, children, gen tags, pinned name) mask the specks under them (`setMask`, ≤ 24 world rects).
  Visibility mirrors the family's drawn members; ghosts dim under any highlight.
- **Drag.** Every slot is anchored to its nearest drawn member (edge distance) and drawn at its build position plus that
  member's displacement (half an RGBA texel of the family texture per member of a ghosted family, rewritten on every `positions` event for the moved
  families): the grain trails with its chain, nothing is pushed, nothing springs back that the coins do not.
- **Real dust.** ThreeMap wires the page's family store (`families` prop): `onSwarmWant(tops)` (a ghosted family ≥ 0.22 of
  the inset rect's short side and ≥ 25 % on screen, or the focused one) → `families.want(tops, "view")`; chunks → `swarmAdd`
  (rows drain in ≤ 4 ms slices, drawn mints skipped, ghost → real crossfade 300 ms); evictions → `swarmDrop`; every rebuild
  replays the loaded chunks. A real speck has a heat colour (live / cooling; quiet / cold take the dust colour, alpha 0.42), 1 device px at the curve floor growing on a log scale with market cap to 2 CSS px, a trade flash, a tooltip and a pinned name;
  it is picked (`via "dust"`) when the slot spacing is ≥ 3 CSS px. Index space: `DUST0 = 4,194,304 + global slot`
  (`mintAt / indexOf / world / screen / select / hover / knows / topOf / pick` accept it; `coins / allXY / members /
  children` do not).
- **Tiers.** desktop: every ghost, ≤ 100k real per family; phone (≤ 700 px): ≤ 5k ghosts (a hash-rank cut) and ≤ 20k real per family;
  software GL (SwiftShader / llvmpipe): ≤ 3k ghosts per family and 30k in all, ≤ 20k real per family and 40k in all.
- **A/B.** `?swarm=0` (debug builds / `?debug`) mounts without the layer; `__sporeMap.call("swarmShow", false)` hides it on
  the same frame clock; `swarmTune({aDot, sigMin, aReal, kReal})` moves the look knobs live; `call("swarmMask")` / `call("swarmSample", top, step)` show the label rects and where slots are drawn now. `__sporeMap.swarm()` = EngineSwarmStats,
  `call("swarmCheck")` = {outside, onDrawn, overlaps, hash}, `call("swarmSynth", top, n)` = n synthetic rows through swarmAdd.
- QA: `test/make-swarm-fixture.mts` (prod counts, Σ ghost ≥ 300k), `test/map3-swarm.mts` (look / perf / phone / sw / build /
  mem / correct; mocks GET /api/map/family when the API answers 404), `test/map3-swarm.test.mts` (slots, ghost count).

## Switching renderers

| What | How |
|---|---|
| Force the classic map | `/map?renderer=classic` |
| Force the WebGL map | `/map?renderer=three` (also clears a remembered failure on this device) |
| Turn the WebGL map off for everyone, no rebuild | edit `web/dist/map-renderer.json` on the server to `{ "renderer": "classic" }` |
| Turn it off on phones only | `{ "renderer": "desktop" }` (container ≤ 700 px or a coarse pointer gets classic) |
| Turn it back on | `{ "renderer": "three" }` (the default shipped from `web/public/map-renderer.json`) |

The kill switch file is read once per /map visit with `cache: "no-store"`. A missing or broken file means
"three". The last value read is kept in localStorage, so a visitor who read "classic" starts their next visit
on classic without a flash; the fetch on that visit refreshes the value. A deploy restores the file from
`web/public`.

Automatic fallbacks (`__sporeMapPage.fallback()` names the reason):

| Reason | When | Remembered? |
|---|---|---|
| `param` | `?renderer=classic` | no |
| `no-webgl2` | no WebGL2 context or no `EXT_color_buffer_float` (probe) | no (re-probed each visit) |
| `chunk-load` | the lazy chunk failed to load (a deploy race, offline) | no |
| `webgl` | the engine could not create its own context | yes |
| `mount-error` | the engine build failed, or ThreeMap threw while rendering or in an effect (MapBoundary) | yes (not for `?m3fail`) |
| `context-lost` | the WebGL context was lost a third time (two rebuilds first) | yes |
| `off` | the kill switch | no (the flag itself is cached) |
| `sticky` | a remembered failure for this build within 24 h | — |

A remembered failure is keyed by the build (the main chunk's URL), so the next deploy clears it for
everyone. Every fallback logs one `console.warn`, never `console.error`.

## Runtime behaviour worth knowing

- **Breathing sleeps.** Live coins breathe and their rims shimmer (the prototype's look), which at the overview
  means 15 renders a second. 30 s after the last input on the map (pointer, wheel, touch, or a camera call
  from the page such as a key, a rail pick or a search pick) the breathing fades out over 1.5 s and the idle map
  renders at the motion loop's 2 Hz (about 20 renders per 10 s). The next input wakes it. Pulses, flashes,
  births and toasts are not affected. Constants: `BREATH_SLEEP_MS`, `BREATH_FADE_MS` in `engine/bubbles.js`.
- **Quality governor.** While frames render back to back (a pan, a zoom, a flight, a drag, pulses), the engine
  samples their intervals, 90 at a time, starting 3 s after mount. When the 80th percentile is over 24 ms
  (under ~42 fps) it steps down once and waits 2 s: drawing-buffer DPR 2 → 1.5 → 1, then the bloom pass off.
  It never steps back up within an engine (a rebuild starts at the top again). `__sporeMap.motion().quality`
  shows the state. On the M4 at 60 Hz the percentile is 16.7 ms and nothing changes.
- **Phone.** DPR capped at 2, bloom at half resolution, long-press (250 ms) grabs a coin, a plain touch pans,
  pinch is 1:1. The first tap shows a docked card at the bottom; a coin the card would cover glides up above
  it, and the +/− column steps aside while the card is up. A second tap or the card's button opens the family.
  The canvas suppresses the context menu and the iOS touch callout.
- **Labels.** Planet labels and the two callouts never sit on another family's colony (beyond its sparse outer
  30 % rim) and never lead a line across one; a label that cannot be placed is dropped.
  `__sporeMap.labelStats().foreignColony` counts violations (QA requires 0).
- **Logos.** `lib/map/images.ts` paces load starts with a token bucket: 120 at once, then 12.5 per second (at
  most 870 per minute, under the `/api/img` limit of 900 per minute per IP), 16 in flight. With a warm proxy
  the first screen's 114 logos are drawn about 0.5 s after the map is ready (it was about 10 s with the old
  80 ms spacing). On a real first visit the logos are bound by the network: `/api/img` sends the original
  images (some 0.5–0.7 MB) and fetches cache misses with a concurrency of 3 on the server.

## Debug hooks

With `?debug` in production (always in dev), `window.__sporeMap` exposes the engine by mint and in page px
(list in `debug-hooks.ts`; `__sporeMap.eng` is the raw index-based `EngineDebug`), `window.__sporeMapPage` adds
`renderer()` and `fallback()`, and `window.__sporeMap3.counters()` counts engines. `?m3fail` (debug only)
forces a mount error.

## QA

All scripts drive headless Chrome over the DevTools protocol (`test/map3-cdp.mts`) against a production build
served by `test/serve-prod.mts` (the production CSP and SPA behaviour, `/api` proxied to sporepad.com). Details
and the classic scripts: `test/README.md`.

```sh
cd web
T=$(mktemp -d); PROTO=<the prototype folder with map.json, heat.json and shots-final2/>
npx tsc -b && npm test && npx vite build --outDir $T/dist          # never build into web/dist for QA
(cd ../server && npm test)
node --import tsx test/serve-prod.mts --dist $T/dist --port 5260 &                                          # live data
node --import tsx test/serve-prod.mts --dist $T/dist --port 5261 --fixture $PROTO &                         # prototype data, idle stream
node --import tsx test/serve-prod.mts --dist $T/dist --port 5262 --fixture $PROTO --fixture-sse live &      # prototype data, live stream
node --import tsx test/map3-qa.mts    --url http://127.0.0.1:5260 --prod --shots $T/qa
node --import tsx test/map3-perf.mts  --url http://127.0.0.1:5260 --prod --out $T/perf
node --import tsx test/map3-shots.mts --url http://127.0.0.1:5261 --prod --ref $PROTO/shots-final2 --out test/shots-map3-final --live-url http://127.0.0.1:5262
node --import tsx test/map-ui.mts     --url http://127.0.0.1:5260 --prod --renderer three   --shots $T/ui3
node --import tsx test/map-ui.mts     --url http://127.0.0.1:5260 --prod --renderer classic --shots $T/uic
node --import tsx test/map-perf.mts   --prod http://127.0.0.1:5260
```

`npm test` runs `test/map3-adapter.test.mts` on the committed sample `test/fixtures/map3-sample.json`
(24 roots, 927 coins, cut from the prototype's data in server order); `MAP3_FIXTURE=<map.json>` runs it on a
full payload. `map3-shots` reads the reference shots from `--ref` (or `$MAP3_PROTO/shots-final2`).

### The feel gates: `test/map3-feel.mts` (owner list items 1–10, spec section 10)

One script for the owner's ten complaints. It prints a `| gate | check | status | value | need |` table
(PASS / FAIL / N/A) and the raw JSON, writes `<out>/map3-feel.json`, the shots (`overview`, `pump-4x`,
`usdc-deep`, `focus-{url,paste,phone}-{0.5s,0.6s,3.5s}`, `drag-rest`, `attach-si-8x`, `attach-si-focus`) and two
screencasts (`drag.mp4`, `paste.mp4`: CDP `Page.startScreencast` jpeg q80, every frame acked, then
`ffmpeg -framerate 30 … -pix_fmt yuv420p`; `$FFMPEG` overrides `/opt/homebrew/bin/ffmpeg`). It exits 1 on any
FAIL or N/A. Run it against the fixture server (`serve-prod --fixture <scratchpad>/mapThree`); `--ref` is the
folder with the owner's `ref-overview.png`, `ref-pump-4x.png` and `ref-usdc-deep.png`; `--only G1,G6` runs a subset.

```sh
node --import tsx test/serve-prod.mts --dist $T/dist --port 5471 --fixture $PROTO &
node --import tsx test/map3-feel.mts --url http://127.0.0.1:5471 --prod --out $T/feel --ref <galaxy-ref folder>
```

The engine interfaces come from the lanes through `?debug` (`__sporeMap.eng.call(name, …)` → `S.debugFns`):
`rope`, `home`, `moved` (physics), `veinPath` (veins), `coverage`, `logoCoverage` (visibility), `focusState`
(focus). A missing one reports `n/a (interface absent)` with status N/A, never a crash; where a measurement
without it exists (`screen()`, `logoPx()`, the straight chord) the JSON has it as `fallback`.

Pixel classes (sRGB 0–255): lit max ≥ 64; lime g ≥ 120 && g−r ≥ 20 && g−b ≥ 40; teal g ≥ 110 && b ≥ 100 &&
g−r ≥ 40; violet b−g ≥ 24 && r ≥ g && max ≥ 56; grey max−min ≤ 18 && max ≥ 56 (screenshots decoded with pngjs).

| gate | what | pass |
|---|---|---|
| G1 | `eng.veinShare(key)` (veins-only render) in the $PUMP disc at the overview / at 4×, the $USDC disc deep (fly, `focusFamily("USDC")`, `zoomTo` 2× that zoom) | ≥ 0.04 / ≥ 0.08 / ≥ 0.06 |
| G2 | violet share of the full render: $PUMP 4× disc; deep $USDC disc ∩ view | ≤ 0.03; ≤ 0.04 |
| G3 | 10 parent→child pairs of $SI (`3VPoXaRc…`) at 8× and at the focus view of its biggest gen-1 child: walking `veinPath` (else the straight chord: N/A, numbers in the JSON) in 0.5 px steps outside both drawn discs; a sample is dark below max(bg + 24, halfway between the local background — 10th percentile of a ring r+4…r+24 around that end — and the band's own median), bg = 10th percentile of the map inset rect; the longest dark run within 20 px of either rim (the sphere's anti-aliased edge may be lit, so the run need not touch it); also a family-framed ×2 view (information) | ≤ 1 px (baseline chord: 8–10 px at the child, family-framed; 4.5–9 px at the focus view) |
| G4 | `coverage()` and the `screen()` fallback: every family top on screen inside the inset rect, min radius; centre pixel of 200 sampled dust tops lit | all tops, ≥ 3 px; ≥ 95 % |
| G5 | cold browser: `logoCoverage()` rootsDrawn / rootsWithImage at 8 s after the first paint; kids10Drawn / kids10WithImage 3 s after a $PUMP 4× settle (12× when no child is ≥ 10 px at 4×, as on the baseline); responses with status 429 (Network.responseReceived, `page.responses` in map3-cdp) | ≥ 0.90; ≥ 0.90; 0 |
| G6 | `/map?focus=9bvuMWQt…pump`, a typed paste (`Input.insertText` into `.map-search input`, Enter only if nothing was selected), and the phone (390×844 DPR 2) ?focus: coin radius inside the inset rect; `focusState().t > 0` duration (per-frame trace in the page); the label in the DOM; lime share in the annulus [r+2, r+14] at 0.5 s after the pulse starts (fallback start: the flight's arrival); mean luminance outside the family disc at 0.6 s ÷ at 3.5 s (outside the coin's r+16 instead when the family disc covers ≥ 90 % of the view, as for this $PUMP child); `.map-side` visible + `selected()` | r ≥ 80 (phone ≥ 50); 2.0–3.0 s; yes; ≥ 0.25; ≤ 0.70; yes |
| G7 | real mouse drags of the $PUMP child `DzMwArmd…` at 4×: 250 px in 146 ms (9 moves), then 400 px in 100 ms; per rAF, \|(pointer − pointer₀) − (coin − coin₀)\| | ≤ 2 px |
| G8 | 1.5 s after release: distance to the drop point, displacement ÷ drag; 3 s: mean descendant displacement ÷ drag (N/A when the coin has no descendants); after size mcap → locked + resize 1280×800 → 1440×900: `world(g)` vs a fresh mount's ÷ both drags | ≤ 2 px & ≥ 95 %; ≥ 90 %; ≥ 90 % |
| G9 | `allXY()` diffed against the pre-drag snapshot on every frame of both drags, every coin outside g ∪ D | max \|Δ\| 0.0 |
| G10 | 600 ms / 200 px real drag of the $PUMP top: gen-1 kids trailing at mid-drag; last kid motion after release; median overshoot along the drag | most trail; ≤ 1.2 s; 2–20 % |
| G11 | `veinPath(g, 16)` first/last point vs `screen(parent)` / `screen(g)` on every drag frame | ≤ 1 px |
| G12 | console errors on every page (the fixture's /api/candles 404 ignored); `measure(3000)` p95 at the overview and at 4×; rAF p95 while a coin is held and wiggled; 5 SPA cycles: `__sporeMap3.counters().live` after leaving, `gl()` textures/programs after each return | 0; ≤ 16.8 ms; 0 each, equal |
| G13 | lit / lime / violet share of the map rect vs the whole reference PNG (overview, $PUMP 4×, deep $USDC); root meanLum is reported (the refs' root position is unknown: N/A); nebula: violet share in the annulus [1.1 Rcl, Rout] (Rcl = outermost planet edge, Rout = outermost family edge, around the world origin) vs the same annulus scaled to the ref's half min side around its centre; plus an information row "nebula haze" (18 ≤ max < 56 && b−g ≥ 6, the dim violet the violet class cannot see: on the baseline both violet shares are ≤ 0.0003, so the spec's nebula row passes while no nebula renders; haze ours 0.0001 vs ref 0.0162) | ±35 %; ≥ 50 % of the ref |
| G14 | `/map?look=flat` mounts (`look()` = flat), 0 errors | yes |

## Known gaps

- Measured only in headless Chrome 155 on an Apple M4 (the phone runs are a 390×844 DPR 2 viewport on the same
  GPU). Not run on Safari / iOS WebKit, Firefox or a real Android device. The governor, the sticky fallback and
  the kill switch are the safety nets; check `/map?debug` on real devices after a deploy.
- Logos on a first visit are network-bound (originals through `/api/img`, server cache misses at concurrency
  3). Server-side thumbnails would fix it; that is a server change outside this port.
- A returning visitor's cached map data (IndexedDB) comes back in mint order, so each family's inner
  arrangement differs from a first visit (the planets and their sizes are the same). Fixing it means keeping
  the server order in `lib/map/cache.ts`.
- The logo atlases (2048² each) are re-uploaded whole, at most every 400 ms, while logos stream in.
- The React lifecycle (`ThreeMap`, `use-engine-sync`) is tested end to end in Chrome (map3-qa a, h, n), not by
  unit tests: the repo has no DOM test library.
