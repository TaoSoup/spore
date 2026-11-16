# Spore — web

Vite 8 + React 19 + TypeScript front end for Spore, the pump.fun family-tree launchpad. It talks only to the Spore API under `/api/*` (same origin in production; proxied to `:8793` by Vite in development) and to the wallet in the browser. No RPC key, no private key, nothing custodial: every transaction is built client-side, simulated, then signed in the browser: by the trading wallet kept in this browser, or by Phantom/Solflare through wallet-adapter (see "Who signs").

## Launchpad rules the UI follows (DESIGN.md §4, §11)

- **Launch is the primary action.** The nav item and page are "Launch" (`/launch`; `/spawn` is kept as an alias that renders the same page so old links work). The form's **pool defaults to SOL**: the first coin of any tree is a plain pump.fun coin, no parent needed. `?parent=<mint>` makes that coin the pool instead; the pool card has "Change" (search over all of pump.fun) and "Use SOL instead". Eligibility comes from `GET /api/eligibility/sol?creator=` for the SOL pool (`ok:true`, depth 0, `pool:"sol"`) and `/api/eligibility/:mint?creator=` for a coin (`pool:<mint>`); both carry the shares and the launch fee. After a launch the success screen's first button is "Launch a coin under $NEW" (→ `/launch?parent=<newMint>`, hidden when the new coin sits at the depth cap) so the tree can grow at once.
- **"Launch a coin" everywhere** (`components/LaunchButton.tsx`): on every Explore card, the Home "Launched on Spore" cards, the Coin page header, its sidebar CTA and its children grid, always → `/launch?parent=<mint>`. It renders disabled with the reason in its tooltip when the coin is at the depth cap (`depth >= stats.maxDepth`) or in mayhem mode (`Coin.mayhem`, optional); the live checks (pending migration, delisted quote) stay on the launch page. `CoinCard` has an `action` slot for it; clicks inside the slot never open the card. Copy says "launch" wherever the user acts; "spawn" survives only in the family-tree story.
- **Fee split: creator 50% / Spore 50%**, two shareholders, paid in the coin's quote (SOL for a root, the parent coin for a child), written at launch with the admin revoked. Every piece of copy (Home "Three steps", How, Launch preview, Coin page CTA) says exactly that; `SplitPreview` renders whatever `eligibility.shares` the server sends, so if `SPLIT_BPS` re-enables upward shares the rows (labelled by parent/grandparent ticker) and the bar follow. Duplicates arrive merged (a platform-owned spawn is one "you + Spore · 100%" row).
- **Launch fee**: `eligibility.launchFee {to, lamports, sol}` (optional; `LAUNCH_FEE_SOL` on the server). `lib/flow.ts → launchFeeOf` turns it into the `LaunchFee` that `buildSpawnTx` adds as a SystemProgram transfer inside the create transaction. `components/CostBox.tsx` shows it before the sign button with the estimated network rent (~0.025 SOL: mint, curve, fee config, vault ATA), the optional first buy and the total, against the wallet balance (`useSolBalance`, polled through `/api/rpc`); the fee line is hidden when it is 0 and the button turns into "Not enough SOL" when the balance is short (1 mSOL margin for network fees).
- **"Ours only" mode**: with `SHOW=ours` the server lists only coins launched here (`Coin.ours` / `Coin.oursPending`, `Stats.mode|ourCoins|otherChildren`, `CoinPage.otherChildren`; all optional in `lib/api.ts` so an older server never breaks a card). The nav pill and Home strip say "N launches" / "Spore launches", Home/Explore/Map show the `NoSpawnsYet` card ("Nothing launched yet — launch the first coin", with the Launch button) instead of an empty table or a blank canvas, the Coin page says "N other children on pump.fun" and gets a "launched on Spore" / "verifying launch" chip, and search/eligibility still cover all of pump.fun (any pump.fun coin can be a parent). After a spawn lands, `runSpawn` fires `POST /api/spawned {mint, sig}` (one retry, never blocks) so the coin is listed while the indexer verifies its fee split.

## Run

```sh
cd web
npm run dev        # Vite on http://localhost:5174, /api → http://127.0.0.1:8793
npm run typecheck  # tsc -b, zero errors expected
npm run build      # tsc -b && vite build → web/dist (served by the server in production)
npm run preview    # serve the production build locally
```

Dependencies are already installed; do not run `npm install` here. The RPC endpoint is `window.location.origin + "/api/rpc"`, the server's allow-listed JSON-RPC proxy. Every page renders with loading skeletons, empty states and error notices when the API is down.

## Routes

The header links are Map and Portfolio (plus the Launch pill and the wallet). Coins (`/explore`), Agents (`/agents`), How it works (`/how`), Fees & rules (`/fees`) and API (`/docs/api`) keep their routes and are linked from the footer.

| Path | Page | What it shows |
|---|---|---|
| `/` | `pages/Home.tsx` | Hero over the spore canvas, search, stats strip, live launch feed (SSE), "Launched on Spore" cards (top 6 of `/api/feed` by locked then mcap, each with the Launch button), 3-step summary |
| `/explore` | `pages/Explore.tsx` | Card grid of every coin launched here (`/api/feed?limit=200`, SSE prepend) with client-side sort tabs new / locked / mcap / children, each card with "Launch a coin"; a secondary "Roots" tab keeps the old leaderboard table (`/api/roots`, load more); search; `NoSpawnsYet` card when empty |
| `/map` | `pages/Map.tsx` | Full-viewport ecosystem bubble map (`/api/map`): every root with (our) children as a cluster, size by locked or mcap, find-on-map search, top 30/60/120 roots; `NoSpawnsYet` card when empty |
| `/c/:mint` | `pages/Coin.tsx` | Coin header + parent-chain breadcrumbs (+ "launched on Spore" chip), stat tiles, price chart, family bubble map, children grid ("N other children on pump.fun" in ours mode), live trade tape, trade widget, "Launch a coin under $X" CTA, fee shares / "Lock fee split", details |
| `/launch` (`?parent=<mint>`) | `pages/Launch.tsx` | Pool card (SOL root by default; a coin via `?parent=`, "Change" search, "Use SOL instead"), eligibility + split preview, form, optional first buy, cost box with balance check, step-by-step progress, success screen with "Launch a coin under $NEW" + coin page / pump.fun / share links |
| `/spawn` | alias | Renders the same Launch page (old links and share posts) |
| `/how` | `pages/How.tsx` | Mechanism diagram, spawn steps, fee table (creator 50 / Spore 50), depth limits (live from `/api/stats`), trading, risks |
| `/portfolio` (`?wallet=<address>`) | `pages/Portfolio.tsx` | One wallet in three tabs (`/api/portfolio/:wallet` + `/api/claims/:wallet`, sorted in `lib/portfolio.ts`; `/api/pnl/:wallet` joined in `lib/pnl.ts`; `/api/activity/:wallet`; refreshed every 15 s). Summary: total value (with the SOL balance under it), unrealized P&L, realized P&L for a period (1d / 7d / 30d / All), fees to claim with "Claim all". **Holdings**: the coins the wallet bought and did not launch, one flat list by value (symbol, its pair, price block, amount, value, unrealized P&L, Buy / Sell; sort by value, P&L, volume or recent), with an Open / Closed switch: Closed lists the coins traded in the period and no longer held. **Activity**: the wallet's trades, newest first, 25 a page. See "Portfolio P&L" below. **Your spores**: the pairs the wallet launched, plus coins whose creator fees it shares (tagged "fee share"), one card per parent coin with market cap, volume, what is still held, per-coin Claim, Buy / Sell, "View on map" and "Launch a child". A coin is in one list only. Shows the trading wallet or the connected wallet; `?wallet=` is a read-only view of any address. Claims are signed by the account wallet (see "Who signs"): a locked trading wallet is asked to unlock first, and with both wallets the rows of coins the connected wallet launched are claimed by the trading wallet while their part goes to the connected wallet. The ticket trades with the active wallet (`lib/trader.ts`), so Sell shows only while that wallet is the one on the page; otherwise Buy only, with a line naming the wallet that trades, or an Unlock button when the trading wallet shown is locked. 10 holdings, 10 closed positions, 12 parent cards and 5 rows a card at first, the rest behind "Show all n" / "Show more" |
| `/claim` | `pages/Claim.tsx` | The older fee page (your coins' fees and the fees waiting across Spore); no longer linked from the header, claiming is on `/portfolio` |

## Portfolio P&L (`lib/pnl.ts`, `test/pnl.test.mts`)

P&L and Activity are for the wallet the page shows (the trading wallet when there is one, else the connected wallet, or the read-only `?wallet=` address). The server answers per coin what was bought, sold and realized, in the coin's quote (SOL, or the parent's token), and converts at **today's** price of that quote. `lib/pnl.ts` (pure) joins that with the holdings:

- **Unrealized** = value of the tokens held now minus their cost. The trades and the wallet can disagree (tokens sent in or out, a history that was cut), so only the part both agree on counts: `min(balance, heldBase)`, with the cost and the value scaled to it. It does not depend on the period.
- **Realized** = what the sells of the chosen period made (the server windows it by `since`); the percent is the profit over the cost of the tokens sold. The period also filters the **Closed** list: coins traded in it that the wallet no longer holds, or holds only as dust (under $1).
- An unrealized figure is marked **"~"** (approximate) when the wallet holds more than the trades explain, or the server flags the coin as partial: tokens received without a recorded buy are left out. A realized figure is marked only by the server's flag (tokens merely held on top of the trades do not change what the sells made).
- No recorded buy means no figure ("—"), never a zero. The tiles say how many coins were left out (no recorded buy, or no price); when every coin sold in the period is left out the Realized tile shows "—", not "$0". A percent that rounds to nothing reads "0.00%" without a sign.
- When the holdings could not be read, the realized figures still show; the unrealized ones and the Closed list wait for the holdings.

Limits, all said on the page: dollars are at today's price of SOL / the parent coin, not the price at the time of the trade; network fees and tips are not counted (the venue's trading fees are); the server reads a wallet's past transactions once in the background (about one a second, up to 1,000), so older trades can be missing ("Trades before <date> are not included") and some transactions may be unreadable ("Some trades may be missing"). While that read runs the page asks `/api/pnl` again every 5 s (never in a hidden tab) and shows "Reading your trade history: n of m transactions." One `/api/pnl` request runs at a time: a refresh asked for while one is in flight is skipped, so a slow answer still lands. A failed or rate-limited (429) P&L request leaves the rest of the page working with "—" in the P&L places; when the server tracks no more wallets or has the read switched off the line says P&L is not available.

### USD | SOL (`lib/money.ts`, `test/money.test.mts`)

A small "USD | SOL" switch beside the period (kept in this browser as `spore:pf-unit`, default USD) turns every **money** figure of the page into SOL at the current SOL price (`stats.solUsd`): the four tiles, a holding's value and P&L, the Closed list's bought / sold / realized, a spore row's market cap, 24 h volume, value held and the fee title, the second figure of an Activity row, the chart, and the titles that carry money. Percentages, token amounts and a coin's own price do not change. The page keeps its figures in USD and writes them through one helper: `makeMoney(unit, solUsd)` gives `{ unit, can, solUsd, money(usd, { signed, card }), other(usd, opts), toUnit(usd) }`, handed down by `MoneyCtx` / `useMoney()` in `pages/Portfolio.tsx` (the pure `formatMoney(usd, unit, solUsd, opts)` is under it). SOL text mirrors the dollar helpers: `0 SOL`, `1.25 SOL`, `12.4K SOL`, `< 0.0001 SOL` on a card, `+0.5000 SOL` / `−2.10 SOL` for a profit or a loss, and `≈ 0 SOL` under a cent (the same threshold as `≈ $0`, so the colour of a figure never changes with the unit). The SOL balance line under Total value always shows both: SOL first with its dollars after in SOL mode, the other way round in USD mode. An Activity row paid in SOL keeps its dollars as the second figure in both modes (the first is the SOL amount already). Without a SOL price the SOL button is disabled with a title saying why and the page stays in USD. The dust switch names its limit in the unit in use ("under $1", or that dollar's worth in SOL, e.g. "under 0.0067 SOL"); the limit itself stays $1. Not converted: the claim dialog.

### Realized P&L chart (`components/portfolio/PnlChart.tsx`, `lib/pnl-chart.ts`, `test/pnl-chart.test.mts`)

A card between the tiles and the tabs draws the wallet's cumulative realized profit over the period chosen, from `GET /api/pnl/:wallet/series?since=` (`api.pnlSeries`, type `PnlSeries`: `{ ok, wallet, at, since, solUsd, points: [{ t, usd }], unpriced }`, cumulative USD at today's quote prices, the first point at 0 and the last at `at`). Plain SVG, no library: one step line (realized profit only changes at a sell, so the line runs level and jumps), lime when the period ends above zero and red when below (muted at zero), a soft fill towards a dashed zero line that is always on the scale, a dot on the last point. Pointer or finger over it shows a crosshair and the head of the card reads that point (date and signed value in the unit chosen) instead of the period's end; under the line sit the first and last date and the low / high. About 140 px tall, 110 px when the card is narrower than 520 px (ResizeObserver). The accessible name says the change, the dates, the low and the high. The series is read with the P&L: same wallet and period guards, one request at a time, on the page's 15 s refresh and the 5 s poll while the history is read, never in a hidden tab. Fewer than two points, or no profit or loss among them, reads "No realized profit or loss in this period yet"; so does an API without the route (404). Another failure, or `ok: false`, reads "The chart could not be read just now."; the card is hidden while P&L is not available at all. `lib/pnl-chart.ts` is pure: `seriesPoints(raw)` (finite rows, time ascending), `hasSeries(points)`, `chartGeo(points, w, h, padX, padY)` (pixels, the step path, the area path, `zeroY`, low / high, tone) and `pointAt(xs, x)` (the step under the pointer).

**Activity** lists time, Buy / Sell, coin (link to the map), token amount, what was paid or received in the quote (with dollars at today's price when the page knows the quote's price) and a link to the transaction on Solscan; "Load more" follows the server's cursor. The first page is read again when the server stored more trades or the state of the history read changed (one request at a time); a list extended with "Load more" keeps its rows and takes the ones it lacks (`mergeFirstPage`), and gets "Load more" back when it had reached its end and the server now stores more.

## Who signs (`lib/trader.ts → useAccount`)

A user has one account wallet. `chooseAccount` picks it in one place, and the launch page, the claim flows and the fee-split card all read it through `useAccount()`:

- **A trading wallet exists in this browser** (`lib/trading-wallet.ts`): it is the account, locked or not. Its address is "me" (creator of a launch, payer, the wallet whose balance and eligibility are checked) and it signs. While it is locked nothing is signed: the action button itself says so ("Unlock trading wallet to launch", "Unlock to claim", "Unlock to pay out") and opens the unlock panel instead of the extension's connect modal. A connected extension never takes over from it. A trading wallet whose private key was never saved outside the browser (`unsaved`, the panel's "Save your private key" step) cannot launch yet: a launch makes it the coin's creator and fee shareholder for good, so the launch button reads "Save your trading wallet's key to launch" and opens that step.
- **No trading wallet**: the connected extension wallet is the account, exactly as before.

The trading wallet signs without a popup, so each flow asks once on the page before it signs, with what will happen, and nothing is sent on page load, on unlock or on a state change:

| Flow | Confirmation with the trading wallet | Signer |
|---|---|---|
| Launch (`pages/Launch.tsx`) | A dialog after the simulation and before anything is signed or persisted: creator and payer, the simulated spend, launch fee, agent gas, the fee split, and what is signed right after without another question (a fee split that did not fit, the first buy). Its rows are the values captured when the launch started (`AskView`), not the live form or URL. `lib/flow.ts` `SpawnInput.confirm`; "Cancel" ends the launch with nothing signed. One signing flow runs at a time (a launch, or finishing a fee split) | the account wallet (plus the fresh mint keypair) |
| Finish a fee split (Resume card / success screen) | The same dialog, with the simulated spend | the wallet that launched the coin: the trading wallet, or the connected extension for a launch made with it |
| Claim / pay out (`components/claim/useClaimFlow.tsx`, `components/ClaimFees.tsx`) | The existing confirm dialog (amounts per recipient, network fee). "Claim all" simulates every coin before Start and lists each payout with its recipients and its simulated cost, plus the total; Start signs only the coins listed with a cost, each simulated again and left out if it would cost more than shown (`withinQuotedCost`); the Claim all button stops the run after the coin in flight, and a run that did not pay out every coin says how many it did. `claimWords` writes the hint and the button (`paidToOf`: trading wallet, connected wallet, or both). A payout that fails because the trading wallet lacks SOL says so and opens its deposit view (`payerProblem`) | the account wallet |
| Lock a fee split (`components/FeeSplitAction.tsx`) | An inline second step with the simulated spend (and a note when the trading wallet's key is not saved yet) | the coin's creator only |

Two on-chain facts decide the rest. A payout is permissionless (`lib/pump/claim.ts`: the payer is the only signer) and pays the wallets of the coin's fee split whoever signs, so the trading wallet also runs the payouts of coins that were launched with the extension; the dialog then says the part goes to the connected wallet, not to the trading wallet. A fee split is not permissionless (`lib/pump/spawn.ts buildFeeSplitTx`: `create_fee_sharing_config` takes the creator as signer and the share update takes the creator as authority), so for a coin created with the extension the extension signs, and the card says so; a wallet that is not the creator is never offered the button.

The trading wallet pays the network fee of every payout it signs, also for coins whose part goes to the connected wallet, so it needs a little SOL of its own; `/claim` and `/portfolio` count and refresh both wallets' coins together. When the trading wallet locks in the middle of a flow, `friendlyError` says the step was not signed (the sender's own text speaks of trading).

`tradingSender()` signs only transactions the trading wallet pays for itself (`paysForItself`): alone, or as the last signer of a launch whose mint keypair has already signed.

## Launch flow (`lib/flow.ts → runSpawn`)

`SpawnInput.parent` is `Coin | null`: null is the SOL pool (a root coin), a coin is the parent.

1. `POST /api/upload` with name, ticker, description, socials and the image as a data URL (≤ 2 MB) → `metadataUri` (self-hosted, content-addressed metadata on Spore's Pages domain; pump.fun's IPFS endpoint is retired).
2. `GET /api/eligibility/sol?creator=<wallet>` (SOL pool) or `GET /api/eligibility/:mint?creator=<wallet>` (parent) was fetched when the pool was chosen; its `shares` are the exact fee split that gets signed (the server merges duplicates) and its `launchFee` is the transfer added to the transaction.
3. `buildSpawnTx(conn, wallet, parentMint | null, {name, symbol, uri, creatorFeeBps?}, shares, launchFee)` (null = SOL root) → one v0 transaction (`create_v2` + launch fee + fee-sharing config; a second `feeTx` only when the split does not fit), signed by the account wallet (see "Who signs") plus the fresh mint keypair, confirmed by polling. With the trading wallet the page asks for a confirmation after the simulation, before this signature. The step list names the fee amount.
4. `POST /api/spawned {mint, sig}` (fire-and-forget, one retry) so the listing shows the coin before the indexer verifies the fee split on-chain.
5. Optional first buy: a root's chain is `[{mint: new, quoteMint: null, tokenProgram: TOKEN_2022, quoteTokenProgram: SPL Token, migrated: false, depth: 0}]` (`chainForRoot`); a child's is `[{mint: new, quoteMint: parent, tokenProgram: TOKEN_2022, quoteTokenProgram: parent's, migrated: false, depth}, ...parentChain]`; `quoteSwap` simulates, `buildSwapTx` applies the chosen slippage, a second signature lands it. A failed first buy is reported separately and never masks the successful spawn.

## Trade widget (`components/TradeWidget.tsx`)

Buy from SOL / sell to SOL through every hop with `multi_hop_swap`. Quotes come from `quoteSwap` (a simulation that reads the final trade event), so the preview is what the program does. Slippage 1–5% sets `minAmountOut`. Buys can be quoted before a wallet is connected (simulated from a public probe key); sells need the wallet's token balance. Chains not rooted in SOL show a notice and a pump.fun link.

## Components

| File | Role |
|---|---|
| `SporeCanvas` | Full-screen drifting-spore canvas behind the hero; rAF, pauses when hidden, still frame under `prefers-reduced-motion` |
| `BubbleMap` (+ `CoinBubbleMap`, `bubblemap.css`) | d3-force bubble map on canvas: clusters per root, node area = locked USD or mcap, images in circles, ancestors stacked above the focused coin, drift dots child → parent, zoom/drag, hover tooltip, click navigates; `CoinBubbleMap` fetches `/api/tree` for the coin page, the Map page feeds it `/api/map` |
| `CostBox` | Launch fee (hidden at 0) + estimated rent + first buy = total, with the wallet balance and a "Not enough SOL" notice |
| `PriceChart` | lightweight-charts v5 candles + volume from `/api/candles`, resolution tabs, dust-price formatting, live refresh on SSE trades |
| `SpawnFeed` + `LiveDot` | Newest launches (roots included) with SSE prepend and highlight; stream status dot |
| `CoinCard` | Image, name, ticker, "↳ under $PARENT" pill, depth badge, mcap, locked, children, curve progress, age; optional `action` slot |
| `LaunchButton` | "Launch a coin" → `/launch?parent=<mint>`; disabled with a tooltip at the depth cap or in mayhem mode (`launchBlock`) |
| `ChainBreadcrumb` | `QUOTE › $ROOT › $PARENT › $COIN` |
| `SplitPreview` | The fee split as a bar + rows: two rows by default (you / Spore), a merged single row when the creator is the platform, parent/grandparent rows only if the server sends them |
| `FeeSplitAction` | "Lock fee split" for a coin of yours that has no sharing config yet (also what makes it "ours"); signed by whichever of your wallets is the coin's creator |
| `TradeWidget`, `Steps`, `Search`, `Stat`, `Toast`, `Bits` (Logo, DepthBadge, ParentPill, Chip, Addr, Ext, Skeleton*, Empty, NoSpawnsYet, ErrorBox) | as named |

## Lib

- `lib/api.ts` — typed client for every endpoint in DESIGN.md §7 (types copied verbatim; the §11 fields `ours`, `oursPending`, `mode`, `ourCoins`, `otherChildren`, `launchFee` are optional), `api.eligibilitySol`, `api.spawned`, `ApiError`, URL helpers.
- `lib/events.ts` — one shared `EventSource` to `/api/events` with refcounting and exponential-backoff reconnect; `useEvents`, `useStreamStatus`.
- `lib/hooks.ts` — `useAsync`, `useStats` (poll + SSE), `useSolBalance`, `useTick`, `useDebounced`, `useLocalPref`.
- `lib/chain.ts` — builds the tx library's `Chain` from API coins (`chainFor`, `chainForChild`, `chainForRoot`, `isSolRooted`, `routeLabels`).
- `lib/flow.ts` — `runSpawn`, `runSwap`, `launchFeeOf`, `withSlippage`, `QUOTE_PROBE`.
- `lib/steps.ts` — step model + `friendlyError` (wallet/program errors → short human causes).
- `lib/format.ts` — compact numbers, USD with subscript dust notation, SOL, percentages, bps, ages, addresses, exact decimal parsing.
- `lib/pump/` — the on-chain library (owned by the tx agent): `hopsFor`, `quoteSwap`, `buildSwapTx`, `buildSpawnTx`, `sendAndConfirm`, `splitShares`.

## Visual direction

Dark organic premium: background `#07100b → #0b1a12`, glass surfaces with lime borders, accent `#b6ff5c`, violet `#b08cff` for ancestry and sells, Geist / Geist Mono. Mobile-first, 16 px gutters, no horizontal scroll. Wallet logos come from wallet-adapter; the Spore mark lives in `public/mark.svg` / `public/favicon.svg` and `components/Mark.tsx`.
