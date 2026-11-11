# Web tests: mainnet simulations + the dry-run launch flow

Nothing here signs or sends. Transactions are built exactly as the app builds them and run through
`simulateTransaction` with `sigVerify: false` and `replaceRecentBlockhash: true`, from real public
wallets that can never be charged by a simulation.

```sh
# the pump SDK's ESM build does not load under Node; the hook serves its CommonJS build instead
node --import ./test/cjs-sdk-hook.mjs --import tsx test/simulate.mts [parentMint] [buyCoin] [splitSubject] [sellCoin] [sellHolder] [tradeThenSplitRoot] [wsolHolder] [wsolCoin] [claimSolCoin] [claimTokenCoin]
npx tsx --test test/shares.test.mts

# end-to-end launch in the real page (dry mode), against a dev server on :5191 with the SHOW=all API
API_PORT=8794 npx vite --port 5191 --strictPort &
SHOT_DIR=/tmp/spore-e2e node --import tsx test/e2e-launch.mts both      # desktop | mobile | both
```

## simulate.mts — measured 2026-10-18 (public RPC, lookup table 5WK4tafybAnHV4grvSipYfLfV8Bd7Rzcwb5eNE1PQRnx, Spore's own, frozen)

| Flow | Subject | Bytes | Accounts | Compute units | Result |
|---|---|---|---|---|---|
| spawn: create_v2 under a depth-1 parent (child depth 2), split in a second tx | parent 8M8hAuus…pump, payer dBs75…TxXs | 954 (+ 837 for the second tx: sweep + vault ATA + config + split) | 18 | ~150–165k | ok |
| root launch: create_v2 (SOL) + 0.02 SOL launch fee + fee split, one tx | payer dBs75…TxXs | 1024 | 16 | ~241–251k | ok |
| fee split: sweep_creator_fee + vault ATA + create_fee_sharing_config + update_fee_shares_v2 | 2uprf2a8…pump, signer = its creator | 871 | 17 | 192k | ok ("Nothing to sweep": the empty sweep costs no rent) |
| fee split on a migrated coin: curve sweep + pool sweep + config with pool + split with pool | 8wa1G6GN…, Hukxg44m…, 83Yup6Y5… (depth 1, graduated, no config), signer = creator | 1055 | — | 274k–325k | ok (budget 450k) |
| trade, then split in ONE tx, no sweep: multi_hop_swap buy 0.001 SOL by the probe, then config + split by the creator | root 9L4yqKhJ…pump ('Lamport', depth 0, no config) | 1053 | 19 | 215k | **6095 CreatorFeesNotSwept, expected** |
| trade, then sweep + config + split in one tx | same | 1172 | 22 | 360k | ok |
| multi-hop buy, 3 hops (curve → curve → pool), 0.01 SOL | GtsYUp4G…pump (depth 2) | 905 | 20 | 196k | ok, 55.6M tokens, = SDK `simulateMultiHopSwap` |
| multi-hop sell, 2 hops (pool → pool), 1 000 tokens | 3ZvEeeLx…pump, signer = holder 2orGyHSp… | 762 | 16 | 118k | ok, = SDK reference |
| multi-hop sell by a holder with a funded WSOL account (7.33 SOL wrapped), 1 000 tokens, 1% slippage | BsbsB3WL…pump ($GTA, pool), signer = holder H9kuqGKN… | 629 | 12 | 67k | ok, quote 0.013412751 SOL = SDK reference, `unwrapped` = the account's lamports |
| claim creator fees (§11.6), migrated SOL root: pump-amm pool sweep + transfer_creator_fees_to_pump_v2 + distribute_creator_fees_v2 (2026-10-19) | $SPORE HfzNFxar…wJTJY (config = platform 100%), payer = probe dBs75…TxXs (not a shareholder) | 684 | 14 | 109k | ok, event: 5.179 SOL distributed, 100% to the platform; the vault's 650 240-lamport rent floor stays behind; payer spends 17 500 lamports (fees only) |
| claim creator fees, live child quoted in $SPORE: curve sweep + distribute_creator_fees_v2 (creates the creator's missing $SPORE ATA) | $SPCAT 75Waoewr…fGaU (creator 50 / platform 50), payer = probe | 663 | 14 | 112k | ok, event: 417 817.09 $SPORE distributed, 208 908.55 each; payer spends ~0.0015 SOL (one Token-2022 ATA + fees) |

Without the lookup table the 3-hop buy is 1,245 bytes and create + fee split together cannot be
encoded at all, which is why `buildSpawnTx` returns the split as a second transaction (`feeTx`)
when it does not fit. Holders sell: when the sell test says "could not find account", pick a recent
buyer from `/api/coin/3ZvEeeLx…/trades` and pass it as the fifth argument (done 2026-10-18, the
previous holder DvFZ1iuU… had emptied its account).

`shares.test.mts`: 6 pure tests of the split merging (duplicates, zero slices, missing ancestors).

## e2e-launch.mts — the launch page end to end, nothing on-chain

Headless Chrome over the DevTools protocol (like `tools/shot.mjs`) opens `/launch?dry=1`, fills the
form the way a user would (native value setters + input/focusout events, a 700×460 PNG drawn in
the page handed to the file input), presses Launch and waits for the success screen. In dry mode
(`lib/dry.ts`, development builds only: `import.meta.env.DEV` is a build-time constant, so
`isDry()` compiles to `() => false` in production and `window.sporeDry` is never created):

- the upload is skipped for a fixed https metadata URI;
- the wallet is `window.sporeTestWallet`, a shim `{ publicKey, signTransaction }` built from a
  throwaway `Keypair` generated in the page. It presents the funded public wallet
  `dBs75Gf7…TxXs` as payer because a simulation needs a payer with SOL (a fresh key has none and
  fails at the fee payer before any program runs); with `sigVerify: false` no signature is checked,
  and nothing is ever signed for real;
- every `send` becomes `simulateTransaction(sigVerify:false, replaceRecentBlockhash:true)`; the
  result is appended to `window.sporeDry.log` and a signature-shaped `dry…` marker stands in for
  the real one (no explorer link);
- `POST /api/spawned` and the localStorage record are skipped, so the dev index is not polluted;
- the first buy is quoted with pump's curve math (`estimateFirstBuy`) and not simulated, because
  the curve only exists after a real launch; a second fee-split transaction (needed when create +
  split do not fit 1232 bytes) is built and measured but recorded as `skipped` for the same reason —
  `simulate.mts` validates that builder on an existing coin.

The test asserts: the ticker was upper-cased, `@spore_e2e` became `https://x.com/spore_e2e`, the
image was cropped/resized to 512×512, the success screen appeared, and every entry of
`window.sporeDry.log` passed (`launch` present, no failures). A third scenario injects a persisted
mid-flight launch into localStorage and checks that the Resume card renders with "Finish the fee
split". Screenshots (`<flow>-<mode>-1-filled`, `-2-steps`, `-3-success`, `resume-<mode>`) go to `SHOT_DIR`.

Results 2026-10-18 (dev server on :5191 → API :8794 in SHOW=all; public RPC through `/api/rpc`):

| Scenario | Create tx | Simulation | Steps |
|---|---|---|---|
| SOL root, desktop + mobile, 0.05 SOL first buy | 1035 bytes, one tx (create + 0.02 SOL fee + split) | ok, ~258–261k CU, payer spends 0.0315 SOL | 7/7 done; first buy ≈ 1,763,352 tokens |
| child under BsbsB3WL…pump ($GTA, depth 0 → child depth 1), desktop + mobile | 912 bytes create; split 720 bytes in a second tx | create ok, ~149–155k CU, 0.0271 SOL; split built, skipped (needs the real mint) | 7/7 done; first buy ≈ 1,966,899 tokens |
| resume card from a persisted record | — | — | card shown with "Finish the fee split" |

Each scenario takes 3–20 s; the public RPC rate limit is the variance.

## What the simulations taught the builders

- `update_fee_shares_v2` distributes pending fees through the sharing config's creator vault and
  reads the vault's quote token account. On a fresh config it does not exist (`InvalidAccountData`),
  so the builders create it idempotently first (`vaultAtaIx`). Shareholder token accounts are not
  needed at this point; the permissionless `distribute_creator_fees_v2` creates them later.
- Holder-reward coins have a PDA as creator, so no wallet can ever sign their fee split; Spore
  spawns with holder rewards off.
- The public RPC refuses `getTokenLargestAccounts` ("Too many requests for a specific RPC call"),
  so the sell test takes the holder as an argument.
- `createV2` with a pump-coin quote needs the parent chain's curves (and pools once migrated) as
  remaining accounts; `OnlinePumpSdk.resolveQuoteMint` collects them and the depth.
- A pre-flight simulation with `accounts: [payer]` returns the payer's post-state, so the exact
  cost of a signature (rent + fees + launch fee) is known before the wallet opens
  (`lib/pump/simulate.ts → preflight`): 0.0315 SOL for a root launch with the 0.02 SOL fee.
- Vite's dev server binds `localhost` (::1 here); `127.0.0.1` is refused, so the e2e uses `localhost`.
- pump refuses `create_fee_sharing_config` (its `MigrateBondingCurveCreator` CPI) and `update_fee_shares_v2`
  while the curve's creator-fee bucket is nonzero: 6095 `CreatorFeesNotSwept`. Any trade between the
  create and a split sent later fills that bucket, which is exactly the window of a two-transaction
  spawn (wallet popup + confirmation) and of every "Lock fee split" retry. Measured 2026-10-18 on
  live coins with un-swept fees (NFV8jyFZ…, 88wbHmq3…) and reproduced in one transaction (the
  trade-then-split rows above). Every split therefore starts with `sweep_creator_fee` for the
  curve's current creator; with an empty bucket the instruction logs "Nothing to sweep" and costs
  only its compute (29k CU, no rent). `buildFeeSplitTx` reads the curve first: the sweep pays the
  creator it finds there, a complete curve gets its pool in the share update whatever the caller
  passed, and a migrated coin also gets the pool in the config and a pump-amm pool sweep.
- Claiming (§11.6, `lib/pump/claim.ts`) is permissionless: the probe wallet, which holds no share
  of either coin, built and simulated both payouts; the program pays the sharing config's wallets
  whoever signs. A SOL vault keeps a rent floor the distribution leaves behind (650 240 lamports on
  $SPORE: the API's `vault` figure includes it, the event's `distributed` does not), so the card's
  pending total can exceed the payout by that much on a SOL coin. On a migrated coin the fees sit
  in the pool's own `creator_fees` bucket (pool bytes 279..287) and the AMM creator vault's quote
  ATA (wrapped SOL for a SOL pool), which `transfer_creator_fees_to_pump_v2` unwraps into the
  pump vault; `readClaimState` sums both as `amm`. The curve sweep stays in the claim whenever the
  curve is still live even when its bucket reads 0 (the same race as the fee split: a trade
  between the read and the signature would make the distribution fail 6095), and is left out only
  on a migrated curve with an empty bucket. A token-quoted distribution creates a shareholder's
  missing ATA at the payer's cost (`shouldInitializeAta`), which `preflight`'s `spent` reports.
- A multi-hop route whose input or output is SOL creates the user's WSOL ATA idempotently and
  closes it at the end. If that account already existed, its rent and wrapped balance pour into the
  wallet in the same transaction: measured 2026-10-18, a 1 000-token $GTA sell by a holder with
  7.33 SOL wrapped "quoted" 7.347 SOL where the real output is 0.013 SOL, and a $SURGE sell by
  another such holder 6.766 SOL for 0.000276 SOL. `quoteSwap` now reads that account before and
  after the simulation so the quote equals the hop output `min_amount_out` is checked against (equal
  to the lamport to the SDK's `simulateMultiHopSwap`), and reports the closed account's lamports
  as `unwrapped` so the UI can warn that wrapped SOL gets unwrapped as a side effect.

## Map tests: the Three.js renderer ("map3") and the classic Canvas renderer

Since the map3 port (2026-10-21), `/map` renders the WebGL map (`src/components/map3/`) by default and
falls back to the classic `BubbleMap` for `?renderer=classic`, no WebGL2 (or no `EXT_color_buffer_float`),
a chunk that fails to load, an engine that fails to mount (`?m3fail` forces it when the debug hooks are on)
and a WebGL context that cannot be restored. The coin page's family tree and `/embed/*` keep the classic
renderer. Scripts tell the two apart with `__sporeMapPage.renderer()` (`"three"` | `"classic"`) and
`__sporeMapPage.fallback()` (`"param"`, `"no-webgl2"`, `"chunk-load"`, `"webgl"`, `"mount-error"`,
`"context-lost"` or null); the map3 debug hooks (`window.__sporeMap`, by mint, page px) are listed in the
architect's spec, and `window.__sporeMap3.counters()` gives the live engine count (0 after every unmount).

| file | what | needs |
|---|---|---|
| `map3-adapter.test.mts` | unit tests of `src/components/map3/adapter.ts` (DFS order, appended nodes, cycles, values, shares = `lib/map/dominance`, heat payload, tags, node diff, drift rule, highlight); runs in `npm test` | the committed `test/fixtures/map3-sample.json` (24 roots, 927 coins of the prototype's data in server order); `MAP3_FIXTURE=<map.json>` runs the fixture tests on any full `/api/map` payload |
| `map3-cdp.mts` | shared CDP harness: `launchChrome({ gpu: "metal" \| "swiftshader" \| "none", width, height, dpr, mobile, touch, reducedMotion, extraArgs })`, pages with `evalJs`/`waitFor`/`navigate`/`shot`, real mouse/wheel/touch/key input, Fetch intercept, `MOCK_ES` (EventSource mock, `window.__sse(type, data)`), `RAF_PROBE` (frame intervals + long tasks), error capture (console.error, exceptions, non-network Log errors, CSP violations through a binding) with network failures listed apart, a network log | Chrome at `$CHROME` (default: /Applications/Google Chrome.app) |
| `map3-qa.mts` | spec 13.3 (a)–(q), (q) being the Key's last-trade filter and the compact build: renderer + one stream + no refetch, overview (+ `labelStats().foreignColony` 0), click flow, page → map, hover, size toggle, highlight, live events, heat, drag, phone (the docked card never covers the tapped chip; the lowest chip is tapped so the nudge runs), reduced motion, fallback (+ the kill switch `/map-renderer.json` and the sticky fallback after three lost contexts), leak (5 SPA cycles), coin + embed pages, 0 console errors | a production build behind `serve-prod.mts` (live upstream) |
| `map3-perf.mts` | spec 13.5: `measure()` p95 at the overview, $PUMP 4× and the phone; natural rAF during a wheel zoom, a drag-pan and 60 s of live SSE; `dragCoin`; cold/warm first paint; idle renders (after the logo queue drains: awake ≤ 160 per 10 s, asleep — 30 s after the last input — ≤ 25 per 10 s, 0 under reduced motion, a pointer wakes it); the quality governor never steps down on the M4; heap | same, GPU (metal) |
| `map3-shots.mts` | spec 13.6: overview, $PUMP 4×, $Kimchi, phone, plus the prototype's f-hover, g-hover-child-4x, h-phone-tooltip (+ the card does not cover its coin, the +/− column hidden), mid-drag-overview and mid-drag-4x (real mouse; the drag must not select and must come home), each side by side with `PROTO/shots-final2/*.png` (composited in Chrome), + label/lime/HDR/link metrics and the share of logo cells drawn at each shot (`logoCover`; each shot waits settled + 1.5 s, no longer for the logo queue); `--live-url` adds a-overview-live and b-pump-4x-live with the live stream's pulses | `serve-prod.mts --fixture <PROTO>` (+ `--fixture-sse live` for `--live-url`); `--ref <PROTO>/shots-final2` or `$MAP3_PROTO` |
| `map3-feel.mts` | the owner-list gates G1–G14 (spec "map3 galaxy, owner list items 1 to 10" section 10): veinShare, violet wash, vein attachment, overview coverage, logos (+ 0 HTTP 429), focus flight (?focus, typed paste, phone), real-mouse drag lag, stay-where-dropped (+ size toggle + resize), neighbours untouched, rope chain, veins follow, perf/leak, look vs the owner's reference PNGs, ?look=flat; PASS/FAIL/N/A table + `map3-feel.json`, shots, `drag.mp4` + `paste.mp4` (CDP screencast → ffmpeg); gate list in `src/components/map3/README.md` | `serve-prod.mts --fixture <PROTO>`; `--ref <galaxy-ref folder>`; pngjs; `/opt/homebrew/bin/ffmpeg` (or `$FFMPEG`) |
| `serve-prod.mts` | the production server's static/SPA/CSP behaviour (nonce, `buildCsp` from `server/lib/http.mjs`) + `/api` proxied upstream with short caches and ONE fanned-out upstream SSE; `--fixture <dir>` answers `/api/map` (any query, `since=` too) with `<dir>/map.json`, `/api/map/heat` with `<dir>/heat.json`, and `/api/events` with an idle stream (`--fixture-sse live` keeps the upstream stream) | `--dist <vite build output>` |

GPU modes, measured on the M4 with Chrome 155: `--disable-gpu` gives no WebGL at all (the classic fallback);
`--use-angle=metal --ignore-gpu-blocklist` gives WebGL2 on "ANGLE Metal Renderer: Apple M4"; `--disable-gpu
--enable-unsafe-swiftshader` gives WebGL2 in software. Every production URL carries `?debug` (the hooks are
compiled in but gated on it).

Integrator notes (2026-10-21, measured on the M4, headless Chrome 155, metal):
- Frame intervals use the rAF timestamp (`RAF_PROBE` keeps `performance.now()` at the callback as `cbP95` /
  `cbMax` for information). The callback time carries the compositor's scheduling jitter: on `/` with no map
  at all its p95 is 18.4 ms while the timestamp p95 is 16.7 ms, so a 17.5 ms gate on it fails on an empty page.
- Idle renders are counted after the app's logo queue drains (`__sporeMap.images()` queued 0 and in flight 0,
  then 1.5 s): each arriving logo is one atlas-upload render.
  While someone uses the map the overview renders 15 times a second from the live coins' breathing and rim
  shimmer (the prototype's design; gate ≤ 160 per 10 s). Final fix: 30 s after the last input the breathing
  sleeps (`BREATH_SLEEP_MS` in engine/bubbles.js), and the spec's "≤ 25 per 10 s" gates that state; 0 under
  reduced motion.
- Reference shots of the port (fixture data) and their side-by-side composites: `test/shots-map3/` (integrator)
  and `test/shots-map3-final/` (after the final fixes). Their PNGs are git-ignored (regenerate with map3-shots);
  the JSON results stay.

The classic scripts measure the classic renderer and are pinned to it: `map-perf.mts`, `map-interact.mts` and
`map-sync.mts` add `renderer=classic` to every `/map` URL and keep `--disable-gpu`. `map-ui.mts` takes
`--renderer three|classic` (default three): three runs Chrome on the GPU (metal flags, no `--disable-gpu`),
classic adds `renderer=classic` to every `/map` URL; after every load it asserts `__sporeMapPage.renderer()`
(`renderers` in its output; a pre-map3 build without `renderer()` reads as classic). Under three, (g) expects
a phone deep link to leave `?roots` unset (map3 draws every root on every device); no check is skipped
(`skippedUnderThree` lists any that would be). `map-interact.mts` and `map-sync.mts` need the hooks without
`?debug`, i.e. a dev server.

Baseline hashes: before any map3 lane edited the app, `sha256` of the files the port must not touch
(`BubbleMap.tsx`, `components/map/{store,draw,camera,fx,sprites,layout.worker}.ts`, the panels except
MapKey, `pages/embed/*.tsx`, `components/coin/CoinActivity.tsx`, `src/lib/**`, `App.tsx`, `index.html`) were
written to `<scratchpad>/map3-baseline-hashes.json` (gate G11 compares against them):

```sh
node -e 'const fs=require("fs"),c=require("crypto"),b=JSON.parse(fs.readFileSync(process.argv[1],"utf8"));let bad=0;for(const[f,h]of Object.entries(b.files)){const n=fs.existsSync(f)?c.createHash("sha256").update(fs.readFileSync(f)).digest("hex"):null;if(n!==h){bad++;console.log("CHANGED",f)}}console.log(bad?bad+" changed":"all "+Object.keys(b.files).length+" unchanged")' <scratchpad>/map3-baseline-hashes.json
```

### The galaxy look (2026-10-21): `--look`, `MAP3_LOOK`, the galaxy gates and the flat parity

The galaxy look (spec "map3 GALAXY LOOK", architect 2026-10-21) was briefly the app's default; since the flat fix below
it sits behind `?look=galaxy` and the colony plate is the default. Every map3 script takes `--look galaxy|flat` (or the `MAP3_LOOK` env): `map3-cdp.mts` exports `LOOK` and
`withLook()`, and `page.navigate` appends `look=<LOOK>` to every `/map` URL (never to `/embed/*` or the coin page).
The Key's last-trade filter hides coins with no trade in 24 h by default, so `page.navigate` also appends `last=all` to
every `/map` URL without a `last=` (`withLast()`, which the scripts' SPA helpers call too); map-ui's `u()` adds it, and
map-interact, map-perf and map-sync carry it in their own URLs. map-ui (d) and map3-qa (q) test the filter itself.
SPA navigations inside the app carry no `?look`, so the scripts read `__sporeMap.look()` (debug-hooks) where the look
matters and gate on it; `__sporeMap.veinShare()` → `{share, px, lit}` is the galaxy's vein-coverage probe.

- `map3-shots.mts --look galaxy`: the galaxy shot set in `test/shots-map3-galaxy/` (default `--out`; refs in
  `test/shots-map3-galaxy/ref/` = the owner's reference PNGs, default `--ref`): a-overview (1440×900, k0) ↔
  ref-overview.png, b-pump-4x ($PUMP 4×) ↔ ref-pump-4x.png, c-usdc-deep (fly to the $USDC top, zoomTo(i, 2)) ↔
  ref-usdc-deep.png, d-phone (390×844, DPR 2) ↔ ref-overview.png (no phone reference), each with a `compare-*.png`
  composite. Gates (G-A): 0 console errors; `labelStats().overlaps` 0 and `foreignColony` 0 at every shot; titles ≥ 20
  at a, ≥ 6 at d; GEN labels ≥ 2 at b (`labelStats().gens` or visible `.lb.gen`); `limeShare()` at a in [0.01, 0.25];
  at b `hdrCheck().hdrPx` > 0 with offenders 0, `linkMaxPx()` in [2.5, 14], `veinShare().share` ≥ 0.05; at c
  `veinShare().share` ≥ 0.08 (a missing hook FAILS as "veinShare missing"). G-B animation proof: at b, settled, logos
  drained, pointer parked off the canvas, idle fixture stream: two frames 500 ms apart, decoded and diffed in Chrome
  (canvas getImageData), share of pixels differing by > 8/255 in any channel in [0.005, 0.20] (`animDiff` in
  map3-shots.json, PNGs `anim-b-pump-4x-{1,2,diff}.png`), and 0 under `--force-prefers-reduced-motion`
  (`animDiffReduced`).
- `map3-shots.mts --look flat --parity <baseDir>` (G-E): the flat shot set as before (gates unchanged: overlaps 0, HDR
  offenders 0, linkMaxPx ≤ 1.5, lime ≤ 0.001), then a-overview, b-pump-4x, d-phone, e-kimchi are diffed pixel-exact
  against `<baseDir>/<shot>.png` (a run of this script with `--drain-logos` on the tree before the galaxy lanes, same
  server/fixture; `--parity` implies `--drain-logos`: every settle also waits for the logo queue, so both runs show the
  same logos):
  gate 0 differing pixels, `{shot, diffPx, total}` + a diff PNG per shot in `--parity-out` (default `<out>/parity/`,
  `parity.json`), `logoCover` of both runs beside each result (the only accepted explanation for a nonzero count is
  logo-arrival timing, shown by the diff image); linkMaxPx must equal `test/shots-map3-final/map3-shots.json` (1.2; hdrPx
  moves with the logos drawn, so it is reported, not compared).
- `map3-perf.mts --look galaxy|flat` (G-C): measure() p95 ≤ 16.8 ms (both looks; drag-pan and dragCoin held p95 keep
  17.5); idle renders awake ≤ 330 per 10 s under galaxy (the 30 Hz galaxy frame hook; flat ≤ 160), asleep ≤ 25, reduced
  motion 0; `idleRenders10s.galHz` reports `motion().galHz`.
- `map3-qa.mts --look galaxy|flat` (G-D): (b) also checks every visible planet title's last line against the look's
  format — galaxy `^\d[\d,]* · .+%$` (or `^\d[\d,]* coins$`), flat `\d[\d,]* coins$`; (f) looks for the dominance
  tag as `… · 38%` under galaxy, `38% · …` under flat. Everything else (a)–(p) is unchanged and must pass under both.

```sh
S=<scratchpad>; SP=<scratchpad>; cd web
# flat baseline (today's tree, before any lane change) → the parity references
npx vite build --outDir $S/gal-qa/base/dist
node --import tsx test/serve-prod.mts --dist $S/gal-qa/base/dist --port 5380 --fixture $SP/mapThree &
node --import tsx test/map3-shots.mts --drain-logos --url http://127.0.0.1:5380 --prod --ref $SP/mapThree/shots-final2 --out $S/gal-qa/base/shots-drained
# the finished tree
npx vite build --outDir $S/gal-qa/final/dist
node --import tsx test/serve-prod.mts --dist $S/gal-qa/final/dist --port 5381 --fixture $SP/mapThree &   # fixture (shots)
node --import tsx test/serve-prod.mts --dist $S/gal-qa/final/dist --port 5382 &                          # live upstream (qa, perf)
node --import tsx test/map3-shots.mts --look galaxy --url http://127.0.0.1:5381 --prod                                   # G-A G-B → test/shots-map3-galaxy/
node --import tsx test/map3-shots.mts --look flat   --url http://127.0.0.1:5381 --prod --ref $SP/mapThree/shots-final2 --out $S/gal-qa/flat --parity $S/gal-qa/base/shots-drained --parity-out $S/gal-qa/parity   # G-E
node --import tsx test/map3-perf.mts  --look galaxy --url http://127.0.0.1:5382 --prod --out $S/gal-qa/perf-galaxy     # G-C
node --import tsx test/map3-perf.mts  --look flat   --url http://127.0.0.1:5382 --prod --out $S/gal-qa/perf-flat
node --import tsx test/map3-qa.mts    --look galaxy --url http://127.0.0.1:5382 --prod --shots $S/gal-qa/qa-galaxy      # G-D
node --import tsx test/map3-qa.mts    --look flat   --url http://127.0.0.1:5382 --prod --shots $S/gal-qa/qa-flat
grep -rlE 'jsdelivr|unpkg|cdnjs|googleapis' $S/gal-qa/final/dist   # must print nothing (G-F)
```

### The flat fix (2026-10-21 evening): flat is the default again, `--h2`, `map3-warm`, `map3-flat`

`/map` renders the flat colony plate by default (Map.tsx: `?look=galaxy` opts into the galaxy) and sizes families by
market cap (`?size=locked` sizes by locked value; no size param = mcap). A script run without `--look` therefore
measures flat (`map3-perf` treats only `--look galaxy` as the galaxy; `__sporeMap.look()` falls back to "flat" unless
the root carries `look-galaxy`).

- `serve-prod.mts --h2 [--cert-dir <dir>]`: HTTPS + HTTP/2 (node:http2 `createSecureServer`, `allowHTTP1`) on a
  self-signed cert that openssl makes once into `--cert-dir` (default `$SPORE_QA_CERT` or `<tmp>/spore-qa-cert`).
  Chrome caps HTTP/1.1 at 6 sockets per host, which starves the logo loader; over h2 every logo request shares one
  connection. `/api/img` answers now forward the upstream `x-img-thumb` and `cache-control` headers (h1 and h2). Any
  map3 script given an `https://127.0.0.1` / `https://localhost` URL launches Chrome with `--ignore-certificate-errors`
  (`launchChrome({ insecure })` overrides).
- `map3-warm.mts [--upstream https://sporepad.com] [--families 60] [--conc 24] [--rps 60] [--out f.json]`: read-only
  GETs of every family top's image plus the gen-1 children's images of the N biggest families, as `<image>&w=64`,
  two passes (cold, warm): status histogram, `x-img-thumb` share, p50/p90 latency, progress every 500. Run it before
  the logo gate. Cold thumbnails cost seconds each, so a full run (≈ 8k GETs) takes far longer than `--families 0`.
- `map3-flat.mts --url <u> --out <dir> [--tag t] [--json f] [--phone] [--coin] [--size-url <u> --base-url <u>] [--only G1,G2,…]`:
  the flat-fix gates G1 logos (cold profile, `logoCoverage` each second for 8 s after first paint; e429; CDP 429;
  `/api/img` protocol histogram; kids ≥ 10 px at $PUMP 4×), G2 veins (`linkMaxPx`, `linkMinPx("PUMP")`,
  `eng.veinShare("PUMP")` overview and 4×, `veinAlpha`, white wash min(R,G,B) ≥ 200 inside the $PUMP and $Kimchi
  discs), G3 far (`coverage`, `topVis`; `--phone` = 390×844 DPR 2, minTopPx ≥ 2.5), G4 (size toggle pressed "mcap"
  with no size param; with `--size-url` + `--base-url`, Pokémon is the largest $CARDS child at the CARDS 4× and ≥ 2× its
  radius on the base fixture), G5 (`kidVis("PUMP")` overview ≥ 0.80, 4× ≥ 0.95 per heat class, p10Max ≥ 56), C1
  (`--coin`: the coin page /c/<Baton> on the classic renderer, `__sporeRender.logoWant/logoLoaded/logoDrawn`, debug
  only, from draw.ts: every child at sr ≥ IMG_R whose logo loaded draws it within 5 s). The overview is the first load
  of `/map?debug` without a look param. A missing debug fn is FAIL "missing". Writes `<out>/flat-gates-<tag>.json`
  and merges `{tag: rows}` into `--json` (default `$SPORE_QA/flat-gates.json`); exits 1 on any FAIL.

```sh
S=<scratchpad>; cd web
npx vite build --outDir $S/lane-qa/dist
node --import tsx test/serve-prod.mts --dist $S/lane-qa/dist --port 5640 &                              # live, h1
node --import tsx test/serve-prod.mts --dist $S/lane-qa/dist --port 5641 --h2 --cert-dir $S/qa/cert &   # live, h2
node --import tsx test/serve-prod.mts --dist $S/lane-qa/dist --port 5642 --fixture $S/mapThree &        # fixture
node --import tsx test/map3-warm.mts --out $S/qa/warm.json
node --import tsx test/map3-flat.mts --url https://127.0.0.1:5641 --out $S/qa/flat --tag live-h2 --json $S/qa/flat-gates.json --coin
node --import tsx test/map3-flat.mts --url http://127.0.0.1:5640  --out $S/qa/flat --tag live-h1 --json $S/qa/flat-gates.json --only G1
node --import tsx test/map3-flat.mts --url https://127.0.0.1:5641 --out $S/qa/flat --tag phone --phone --json $S/qa/flat-gates.json
node --import tsx test/map3-flat.mts --url http://127.0.0.1:5642  --out $S/qa/flat --tag fixture --json $S/qa/flat-gates.json
```

### Running the gates (spec section 14), after every lane has finished

```sh
T=<scratchpad>/map3-qa; PROTO=<scratchpad>/mapThree; cd web
npx tsc -b && npm test && npx vite build --outDir $T/dist          # G1 G2 G3 (+ COPY_STRICT=1 COPY_FILES=src/pages/Map.tsx,src/components/map3/ThreeMap.tsx,src/components/map/panel/MapKey.tsx npm test)
(cd ../server && npm test)                                          # G4
node --import tsx test/serve-prod.mts --dist $T/dist --port 5260 &                    # live upstream
node --import tsx test/serve-prod.mts --dist $T/dist --port 5261 --fixture $PROTO &   # the prototype's data, idle stream
node --import tsx test/map3-qa.mts    --url http://127.0.0.1:5260 --prod --shots $T/qa                       # G5 G9 G10 G11(o) G12
node --import tsx test/map3-perf.mts  --url http://127.0.0.1:5260 --prod --out $T/perf                        # G8
node --import tsx test/map3-shots.mts --url http://127.0.0.1:5261 --prod --ref $PROTO/shots-final2 --out $T/shots   # G7
node --import tsx test/map-ui.mts     --url http://127.0.0.1:5260 --prod --renderer three   --shots $T/ui3    # G6 (known: "(h) whole ecosystem link is null")
node --import tsx test/map-ui.mts     --url http://127.0.0.1:5260 --prod --renderer classic --shots $T/uic    # G6
node --import tsx test/map-perf.mts   --prod http://127.0.0.1:5260                                            # G6
# optional dev mode: API_PORT=5260 npx vite --port 5252 --host 127.0.0.1, then the same scripts without --prod
```

Each script prints one JSON object (also written into its `--shots`/`--out` directory: `map3-qa.json`,
`map3-perf.json`, `map3-shots.json`) with `ok`, `failures`, `consoleErrors` and `networkErrors`, and exits 1
on any failure. `map3-qa --only a,c,k` runs a subset (each section sets up its own state); `--chrome-gpu
swiftshader` runs it on software WebGL.
