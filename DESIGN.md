# Spore — pump.fun family-tree launchpad

Working brand: **Spore** ("coins that grow coins"). Rename is a one-line change; do not spread the name into identifiers (use `spore` only in package names, titles and copy).

## 1. The idea

pump.fun's `create_v2` lets a new coin be quoted in another pump coin instead of SOL. The child's bonding curve collects **parent tokens**; every SOL buy of the child routes SOL → parent → child, so the parent is bought and parked in the child's curve, and locked in the child/parent PumpSwap pool once the child graduates. Spore:

1. **Indexes the whole tree** of pump.fun (every coin with `depth ≥ 1`, plus their ancestors) and shows it: feed of new spawns, root leaderboard, coin pages with ancestors + children, an animated tree.
2. **Spawns coins under a parent** from the browser (user signs with Phantom/Solflare; nothing is signed server-side).
3. **Routes creator fees upward** with pump's fee-sharing config, set once at creation: child creator, parent creator, grandparent creator, platform.
4. **Buys/sells any coin in the tree from SOL** with `multi_hop_swap`.

Nothing custodial. No private keys anywhere in this repo. Every on-chain action is built client-side, simulated, then signed by the wallet.

## 2. Verified on-chain facts (mainnet, 2026-10-17)

- Programs: pump `6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P`, pump-amm `pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA`, pump-fees `pfeeUxB6jkeY1Hxd7CsFCAjcbHA9rWtchMGdZ6VojVZ`. Metaplex token metadata `metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s`.
- `Global.maxCurveDepth = 2` (program hard cap `MAX_CURVE_DEPTH = 5`), `createV2Enabled = true`, `creatorFeeConfigurable = true` (max 300 bps), holder rewards enabled.
- 212 listed quote mints (SOL, USDC, 210 quote-control mints such as tokenized stocks). A coin quoted in a listed mint has `depth 0`; a coin quoted in a pump coin has `parent.depth + 1`.
- Live counts: 12,189 depth-1 curves, 184 depth-2 curves. `getProgramAccounts` on the pump program with memcmp filters works on the public RPC (~4.5 s each).
- `BondingCurve` account (Anchor, discriminator `[23,183,248,55,96,216,172,96]`), fields in order: virtual_token_reserves u64, virtual_quote_reserves u64, real_token_reserves u64, real_quote_reserves u64, token_total_supply u64, complete bool, creator pubkey, is_mayhem_mode bool, is_cashback_coin bool, quote_mint pubkey, creator_fee_bps u64, can_edit_creator_fee bool, is_holder_reward bool, creator_fee u64, protocol_fees u64, depth u8, initial_virtual_quote_reserves u64, post_complete_base_out u64, post_complete_quote_in u64. Offsets: creator 49, quote_mint 83, depth 141. **The curve does not store its mint.** Curve PDA = `["bonding-curve", mint]`. A SOL-quoted curve stores the zero pubkey as quote_mint.
- Migrated curve: all four reserves zero (`isBondingCurveMigrated`). Pool = `canonicalPumpPoolPdaWithQuote(mint, normalizeQuoteMint(quoteMint))`; pool account has `pool_base_token_account`, `pool_quote_token_account` (vault balances give reserves).
- Events are emitted as `Program data: <base64>` log lines of the pump program. `CreateEvent` fields: name, symbol, uri, mint, bonding_curve, user, creator, timestamp, virtual_token_reserves, virtual_sol_reserves, real_token_reserves, token_total_supply, token_program, is_mayhem_mode, is_cashback_enabled, quote_mint, virtual_quote_reserves, creator_fee_bps, is_holder_reward, depth. `TradeEvent` has mint, is_buy, user, timestamp, token_amount, quote_amount, virtual_quote_reserves, virtual_token_reserves, real_quote_reserves, real_token_reserves, quote_mint, fee fields. `CompleteEvent` marks graduation.
- Multi-hop fees: the protocol fee is charged once on the hop that trades the user's own currency, the creator/holder fee once on the far-end coin, intermediate hops charge nothing. **Parent creators earn nothing from child trades on their own** — the upward flow is the fee-sharing config.
- Fee sharing (pump-fees): `create_fee_sharing_config` (creator signs; `pool` only if graduated) then `update_fee_shares_v2` (≤ 10 shareholders, bps sum 10 000, no duplicates, no zero shares). Updating sets `admin_revoked`, so it is effectively **once**. Payouts are in the coin's quote mint (parent tokens → shareholder ATAs). `distribute_creator_fees_v2` is permissionless.
- New coins are Token-2022 (`create_v2` uses TOKEN_2022). Older pump coins can be SPL Token; always take the token program from the mint account owner (`resolveQuoteMint` returns `quoteTokenProgram`).
- A child cannot be created while any coin on the chain is complete but not yet migrated (6107); mayhem coins cannot be parents (6100); depth over `maxCurveDepth` fails (6105).

## 3. SDK: `@pump-fun/pump-sdk` 4.1.0 (installed in both packages)

```ts
import { OnlinePumpSdk, PUMP_SDK, PUMP_PROGRAM_ID, PUMP_AMM_PROGRAM_ID, PUMP_FEE_PROGRAM_ID, GLOBAL_PDA,
  bondingCurvePda, canonicalPumpPoolPdaWithQuote, normalizeQuoteMint, isBondingCurveMigrated, isLegacyQuoteMint,
  feeSharingConfigPda, MAX_CURVE_DEPTH, multiHopRouteEnds, type MultiHopHop } from "@pump-fun/pump-sdk";
const online = new OnlinePumpSdk(connection);
await online.fetchGlobal();                       // maxCurveDepth, createV2Enabled, ...
await online.fetchSupportedQuoteMints();          // 212 listed mints: {mint, source: "sol"|"global"|"quoteControl", initialVirtualQuoteReserves}
await online.resolveQuoteMint(parentMint);        // {mint, source:"pumpCoin", quoteTokenProgram, decimals, initialVirtualQuoteReserves, pumpQuote:{curve, accounts, depth}} — throws typed errors when the parent is not eligible
await online.fetchPumpQuote(parentMint, {global}); // {curve:{mint,bondingCurve,pool?,chain:[...]}, accounts:{pool?, chain:[{mint,pool?}]}} — the parent chain nearest-first down to depth 0
PUMP_SDK.decodeBondingCurve(accountInfo); PUMP_SDK.decodeCreateEventBc(buf); PUMP_SDK.decodeTradeEventBc(buf); PUMP_SDK.decodeCompleteEventBc(buf); PUMP_SDK.decodeSharingConfig(accountInfo);
await PUMP_SDK.createV2Instruction({ mint, name, symbol, uri, creator, user, mayhemMode:false, quoteMint: parentMint, quoteTokenProgram, creatorFeeBps?, holderReward?, pumpQuote: resolved.pumpQuote.accounts });
await PUMP_SDK.createFeeSharingConfig({ creator, mint, pool: null });
await PUMP_SDK.updateFeeSharesV2({ authority: creator, mint, currentShareholders: [creator], newShareholders: [{address, shareBps}], quoteMint: parentMint, quoteTokenProgram, bondingCurveComplete: false });
await PUMP_SDK.multiHopSwapInstructions({ user, hops, side: "buy"|"sell", amountIn: BN, minAmountOut: BN }); // hops: [{venue:"pool"|"curve", baseMint, quoteMint, baseTokenProgram, quoteTokenProgram}] ordered from the user's currency outward; SOL hops use NATIVE_MINT + TOKEN_PROGRAM_ID
```
Source of truth for signatures: `node_modules/@pump-fun/pump-sdk/src/{sdk,onlineSdk,state,bondingCurve}.ts`. Read them before guessing.

## 4. Fee split (configurable, defaults — owner decision 2026-10-18: two shareholders)

| Shareholder | bps |
|---|---|
| child creator | 5000 |
| parent creator (`parent.BondingCurve.creator`) | 0 (env `SPLIT_BPS` can re-enable upward shares, e.g. `5000,2500,1000,1500`) |
| grandparent creator | 0 |
| platform (`PLATFORM_WALLET`, default `FcbEAMqBvJVsfcFWDbED7geyBLR88ypcY88BoUSgmeT5`) | 5000 |

Default `SPLIT_BPS=5000,0,0,5000`: exactly two shareholders (creator, platform), the same two-shareholder model other launchpads use on Solana. Zero slices are dropped before the program sees them.

Merge duplicates (self-spawn, platform-owned parent) by summing bps; never send duplicates or zero shares. The split is shown before signing and is immutable afterwards. `creatorFeeBps` stays default (0 = pump schedule) unless the user picks a custom one (≤ 300). Holder rewards off by default (a holder-reward coin's `creator` is a PDA and the fee split would not apply).

## 5. Repository layout

```
spore/
  DESIGN.md
  server/            Node 25 ESM. express + node:sqlite (built in; no native modules — node-gyp is unavailable on this machine)
    index.mjs        boots everything (indexer + API + static web/dist in production)
    lib/*.mjs        rpc.mjs, decode.mjs, indexer.mjs, pricing.mjs, db.mjs, api.mjs, events.mjs (SSE), meta.mjs (metadata + image cache)
    test/*.test.mjs  node --test; pure-logic tests must not need the network, network tests skip when SPORE_NET=0
    data/            sqlite file + image cache (gitignored)
  web/               Vite 8 + React 19 + TypeScript + wallet-adapter (deps installed; vite.config.ts proxies /api → :8793)
    src/main.tsx App.tsx styles.css pages/ components/ lib/api.ts lib/format.ts lib/pump/*
    test/*.mts       tsx scripts: build spawn + swap transactions and simulate them on mainnet (no sending)
```

Ports: API 8793, Vite dev 5174. Env (server): `PORT`, `RPC_URL` (default `https://api.mainnet-beta.solana.com`), `WS_URL` (default derived from RPC_URL: https→wss), `DATA_DIR`, `PLATFORM_WALLET`, `SPLIT_BPS` (default `5000,2500,1000,1500`), `REFRESH_MS` (30000), `BACKFILL` (1), `ORIGIN` (CORS allowlist, optional). The RPC key never reaches the browser: the web app talks only to `/api/*`, including an allow-listed JSON-RPC proxy at `POST /api/rpc`.

## 6. Server: indexer

1. **Backfill (once, resumable, persisted):** `getProgramAccounts(pump, filters: [disc BondingCurve, depth == d])` for d = 1..`maxCurveDepth` (full data). Decode. The curve has no mint, so resolve it with `getTokenAccountsByOwner(curve, {programId: TOKEN_2022})` (and SPL Token if empty): the account whose mint ≠ quote_mint is the coin's mint; the other is the quote ATA (its amount = raised parent tokens). Rate-limit (configurable concurrency, default 4; back off on 429). Record `backfill_state` in sqlite so a restart continues. Then add every ancestor (walk quote_mint until depth 0) so the tree is complete; ancestors at depth 0 are tracked for pricing only.
2. **Live:** `logsSubscribe({mentions:[pump]})` via WS_URL. Parse every `Program data:` line, match the 8-byte discriminator, decode `CreateEvent` (depth ≥ 1 → insert child with name/symbol/uri/creator/quote_mint/depth/timestamp; also insert the parent if unknown), `TradeEvent` for tracked mints (update reserves, insert a trade row, push SSE), `CompleteEvent` (mark complete). Reconnect with backoff; on reconnect run a refresh.
3. **Refresh loop (REFRESH_MS):** `getMultipleAccounts` in batches of 100 over all tracked curves → reserves/complete; for migrated coins read the canonical pool's two vault balances (`getMultipleAccounts` of the vault token accounts; decode SPL/Token-2022 token account amount at offset 64). SOL/USD from CoinGecko simple price every 60 s (fallback keep last). Metadata: Metaplex metadata PDA `["metadata", program, mint]` decoded (name, symbol, uri; borsh strings are u32-length-prefixed with trailing NULs) in batches; off-chain JSON fetched lazily with a 6 h cache for `image`, `description`, `twitter`, `telegram`, `website`.
4. **Pricing:** `priceQuote` = quote per 1 base token (curve: `virtualQuoteReserves / virtualTokenReserves` scaled by decimals — base coins have 6 decimals, quote decimals from the mint; pool: `quoteVault / baseVault`). `priceSol` = product of priceQuote up the chain to a SOL-quoted root; a USDC root uses 1 USD / solUsd; other listed quote mints → `priceSol = null`. `mcapUsd = priceUsd × tokenTotalSupply`. `lockedQuote` for a coin = Σ over children of (child.realQuoteReserves, or the child's pool quote-vault balance once migrated); `lockedUsd` uses the coin's own priceUsd. `descendants` = recursive child count. `progress` = curve progress 0..1 (`1 − realTokenReserves / initialRealTokenReserves`, 1 when complete).
5. **Trades table** keeps `TradeEvent`s seen live (sig, mint, slot, time, isBuy, user, baseAmount, quoteAmount, priceQuote) → 24 h volume and a price series for the chart (`/api/candles`). Keep at most 2 000 trades per mint.

## 7. Server: API contract (all JSON, all fields present, nulls allowed as typed)

```ts
type CoinRef = { mint: string; name: string | null; symbol: string | null; image: string | null; depth: number };
type Shares = { address: string; bps: number }[];
type Coin = {
  mint: string; name: string | null; symbol: string | null; image: string | null; description: string | null;
  twitter: string | null; telegram: string | null; website: string | null;
  creator: string; quoteMint: string | null /* null = SOL */; quoteSymbol: string /* "SOL" | "USDC" | parent symbol | short mint */;
  depth: number; parent: CoinRef | null; root: CoinRef | null; ancestors: CoinRef[] /* nearest first, excludes self */;
  complete: boolean; migrated: boolean; pool: string | null; createdAt: number | null; createdSlot: number | null;
  tokenProgram: string; decimals: number; totalSupply: string;
  priceQuote: number | null; priceSol: number | null; priceUsd: number | null; mcapSol: number | null; mcapUsd: number | null; progress: number;
  children: number; descendants: number; lockedQuote: string; lockedUsd: number | null; volume24hUsd: number; trades24h: number;
  holderReward: boolean; creatorFeeBps: number; shares: Shares | null; updatedAt: number;
};
type Stats = { coins: number; roots: number; byDepth: number[]; lockedUsd: number; volume24hUsd: number; solUsd: number | null; maxDepth: number; backfill: { done: boolean; total: number; resolved: number }; updatedAt: number };
type Trade = { sig: string; mint: string; slot: number; time: number; isBuy: boolean; user: string; baseAmount: string; quoteAmount: string; priceQuote: number; priceUsd: number | null };
type TreeNode = { coin: Coin; children: TreeNode[] };
type Eligibility = { ok: boolean; reason: string | null; depth: number | null; chain: CoinRef[]; parentCreator: string | null; grandparentCreator: string | null; shares: Shares; platform: string };
type Heat = { at: number /* unix s */; since: number /* at − 86400 */; mint: string[]; t1h: number[] /* trades in the last 3600 s */; n24: number[] /* trades 24 h */; v24: number[] /* USD 24 h, cents */; last: number[] /* unix s of the last trade */; buys1h: number[] }; // parallel arrays, one entry per mint

GET  /api/stats                            → Stats
GET  /api/feed?limit=50&before=<createdAt> → { coins: Coin[] }                  newest spawns (depth ≥ 1)
GET  /api/roots?sort=locked|children|new|volume&limit=50&offset=0 → { roots: Coin[] }  depth-0 coins that have children
GET  /api/coin/:mint                       → { coin: Coin; children: Coin[] /* sorted by lockedUsd desc */; trades: Trade[] /* last 50 */ }
                                             `?children=0` / `?trades=0` return `children: []` / `trades: []` (same shape, same coin; the map's side panel needs only the coin)
GET  /api/tree/:mint?depth=3               → TreeNode                                      rooted at :mint (ancestors in coin.ancestors)
GET  /api/candles/:mint?res=60             → { candles: { t: number; o: number; h: number; l: number; c: number; v: number }[]; priceKey: "usd"|"quote" }
                                             `&scope=all`: any tracked coin whatever the listing mode (404 "unknown mint" / "not tracked"); without it, unchanged
GET  /api/map/heat                         → Heat                                          every tracked coin with a trade in 24 h whatever the mode, t1h desc then v24 desc; max-age 15 + ETag (§11.5 Activity)
GET  /api/map/dominance?mode=locked|mcap   → { mode; total: number; families: { mint; symbol; value; share; coins }[] }  every all-scope map family whatever the mode, biggest first; `&mint=<top>` narrows `families` to that row ([] for a non-top); 30 s cache + ETag (§11.5 Dominance)
GET  /api/search?q=                        → { coins: Coin[] }                              name/symbol prefix or exact mint, max 20
GET  /api/eligibility/:mint                → Eligibility                                   can :mint be a parent right now (depth, mayhem, pending migration, exists) + the split preview for the connected user (`?creator=<pubkey>` merges duplicates)
GET  /api/events                           → SSE: `event: coin|trade|stats`, `data: <json>`; heartbeat comment every 15 s
GET  /api/img?u=<https url>                → cached image proxy (allowlist: ipfs.io, *.pinata.cloud, *.pump.fun, arweave.net, *.arweave.net, cf-ipfs.com, *.ipfs.*; max 4 MB; 24 h cache; 404 otherwise). Coin.image already points here.
GET  /card/:mint.png (= /api/card/:mint.png) → image/png 1200×630: the coin’s share card (`server/lib/card.mjs`). The picture (the right ~60 %) is the coin’s family drawn as the live map: up to 72 bubbles (the shared coin, its chain to the family top — a coin, or a listed asset such as $PUMP drawn as its icon and never priced —, its biggest children, then the family largest first), each the cached logo clipped to a disc in the map’s depth colour (dashed for the shared coin’s ancestors, a cap dot on graduated coins, the beacon ring on Spore launches), sized by market cap, linked parent → child inside the family’s soft hull on the dot-grid ground, laid out by arithmetic alone so the same family always draws the same picture (the shared coin is drawn at 30 px or more with its eight largest children beside it; when a big family would shrink under that, members are dropped smallest first and counted in "+N more"; the svg's 800 KB budget never costs a member: each distinct logo is embedded once, and past the budget the smallest bubbles' logos are shed, never the shared coin's or the top's); the top is titled "$ROOT · 198 coins · 4.3% of the map · +127 more" and the shared coin is ringed lime and labelled "$TICKER" (+ the "1ST" pill) on the least crowded side, never over a neighbour's logo while any spot is free, and floated outside the family's blob on a hairline leader when none is. The slim HUD on the left states the facts in the og:description’s words and numbers (`server/lib/format.mjs`): status chips, the ticker (set smaller rather than cut, and smaller again so a firstborn's "1ST" pill stays beside it; the pill moves to the lineage line only when no size fits both), the name, the lineage ("↳ under $PARENT · under $ROOT"; two long tickers step the line to 22 px, then to "↳ under $PARENT · $ROOT"), MCAP · AGE · LOCKED BY CHILDREN (hidden under a cent) · CHILDREN / DESCENDANTS, the family block and the wordmark; a ticker or name the font cannot draw in full falls through to the name, then the short mint, and nothing is set under 22 px but the chips and the subline, so the card reads at 500 px wide. Server-rendered: the svg is rasterized on the image worker thread (`server/lib/img-worker.mjs`, the thread `/api/img` thumbnails use; resvg + the Geist TTFs vendored in `server/lib/fonts`, OFL, `server/lib/card-fonts.mjs`), never on the event loop; numbers from `server/lib/format.mjs`, the web's vocabulary, shared with the og:description. Per-mint LRU ≤ 200 entries, 60 s TTL (5 s for a card drawn with the placeholder, so the next crawler gets the logo; such a card is also sent with `max-age=5` instead of the usual `max-age=60, stale-while-revalidate=300`, so the edge never pins a lettered disc), strong ETag → 304. At most `CARD_MAX_INFLIGHT` (8) cards rasterize at once (the slot wraps only the drawing, never a logo wait); past that the route answers `302 → /og.png` with `Cache-Control: no-store` and `Retry-After: 2` and the refused card is drawn in the background (a backlog of ≤ `CARD_BACKLOG_MAX` mints), so a scan of fresh mints buys no extra drawing while the next real crawler finds the card in the LRU. The shared coin's and the top's logo not on disk yet is made the way `/api/img` makes it (`ImageCache.get` + `thumb`, waited for ≤ 1.5 s; the cache's negative memory of a dead upstream holds, `warm`'s skip list does not), else a letter avatar and the 5 s TTL; a member's missing logo is a letter avatar now and `warm`ed (≤ 24 per render, each url once a minute) for the next card. A ticker or name the font cannot draw in full (CJK, emoji, a mixed script such as "日本CAT") is never shown cut: the ticker falls through to the name, then to the short mint set as an address, and a half-drawable name line is left out. An untracked coin (looked up for its page, nothing spawned under it) renders as a plain root. 400 malformed; 404 unknown after one live lookup, which draws on the `api` rate limit (the picture itself on `img`); `?v=<minute>` is the cache-buster the OG tags carry.
POST /api/upload                           → { metadataUri } (pump.fun IPFS; body {name, symbol, description, image: dataURL, twitter, telegram, website}; copy the validation from ~/tldpad/app/server/index.mjs)
POST /api/rpc                              → allow-listed JSON-RPC proxy (getLatestBlockhash, sendTransaction, simulateTransaction, getSignatureStatuses, getBalance, getAccountInfo, getMultipleAccounts, getTokenAccountBalance, getTokenAccountsByOwner, getTokenSupply, getMinimumBalanceForRentExemption, getTransaction, getSlot, getBlockHeight, getBlockTime, getEpochInfo, isBlockhashValid, getRecentPrioritizationFees, getFeeForMessage, getHealth, getVersion, getAddressLookupTable, getProgramAccounts is NOT allowed)
```
Errors: `{ error: string }` with 4xx/5xx. Unknown mint → 404. Everything is CORS-same-origin in production (static build served by the server).

**Link unfurls (OG injection, `server/lib/og.mjs`).** Crawlers (X, Telegram, Discord) read the server's HTML, never the SPA's client-side meta changes. `GET /c/:mint` and `GET /map?focus=<mint>` (base58, 32–44 chars) serve `index.html` with the block between `<!-- og:start -->` and `<!-- og:end -->` in `web/index.html` replaced per coin: `og:url` absolute (canonical: `/c/<mint>`, or `/map?focus=<mint>` for a map link; other query parameters dropped), `og:title` "$KID under $PARENT · Spore" (a family top: "$ROOT · Spore"; a depth-0 coin paired with a listed asset: "$KID quoted in $PUMP · Spore"), one-line `og:description` in the words of the web's share texts (name · "mcap $12.4K" · a top's "1,352 coins under it" or a child's "12 children" + "14 descendants" / "no children yet" · "$5.2K locked" · "first child of $PARENT" · a top's "41% of the Spore map" or a member's "$PUMP family holds 4.3% of the map" · the lineage "$PUMP › $CAT › $KID" from depth 2; unknown parts left out), `og:image` = `<publicUrl>/api/card/<mint>.png?v=<floor(now / 60 000)>` with type, width, height and alt ("Family map of $KID on Spore: <description>"), the lineage named with `tickerOf` from `chain` (so "$🎃" stays a ticker in the text), `twitter:card summary_large_image` and the twitter title / description / image / alt; every value HTML-attribute-escaped. Every other path, an unknown mint, and HTML without the markers keep the static block (`/og.png`); the inline script of `index.html` fills in only path-absolute fallbacks, so the injected absolute tags survive crawlers that run scripts. The card data (`cardData(model, mint)`) is the same record the card is drawn from and both format numbers with `server/lib/format.mjs`, so the title, the description and the picture never disagree.

## 8. Web app

Routes: `/` Home (hero, live spawn feed via SSE, top roots, stats strip), `/explore` (root leaderboard with sort tabs + search), `/c/:mint` Coin (header with image/name/ticker/parent chain breadcrumbs, price/mcap/locked/progress, tree viz centered on this coin, children grid, trade widget, "Spawn under this coin" CTA, fee shares, creator links), `/spawn?parent=<mint>` Spawn (parent picker with search + eligibility, form name/ticker/image/description/socials, optional first buy in SOL, split preview, step-by-step progress, success screen with share links), `/how` (how it works, fees, depth limits, risks).

**Share cards (owner 2026-10-23).** A pasted `/c/<mint>` or `/map?focus=<mint>` link unfurls on X, Telegram and Discord as that coin's own 1200×630 card (`GET /api/card/<mint>.png`, §7) instead of the site's generic `/og.png`, so the post text only has to say the sentence the picture cannot. Every X intent on the site builds its text with `web/src/lib/map/share.ts`: one pure builder, `coinShareText`, over a flat fact record ({ self, parent, root, firstborn, children, descendants, lockedUsd, mcapUsd, dominance }); the map's side panel (`shareText`: parent and family top from the node set, "1st" from the firstborn set, the family's dominance for a top), the coin page's Share menu (`coinPageShareText` from the server's coin view, which has no firstborn set, so never "first child") and the launch success screen (`launchShareText`) adapt their records to it, so every surface says the same thing about the same coin. The shapes: a child "$KID, first child under $PARENT in the $ROOT family — 12 children, $5.2K locked. Live family tree:" (the family clause only when the parent is not the top; a leaf with nothing locked shows its mcap), a top "$PUMP family on Spore — 1,352 coins under it, $120K locked, 41% of all locked value on the map. Live family tree:", a launch "I just launched $KID under $PARENT on Spore — every buy routes through $PARENT. Family tree:". Rules: ≤ 200 characters (`SHARE_MAX`; a long name is clipped, then the family clause and the numbers are dropped in that order, never a cut mid-sentence), unknown parts are left out (never "—", "null" or a 0), no hashtags, no emoji, the link follows the text (it is the `url` of the intent, never pasted into the text). Tests: `web/test/share.test.mts`.

`lib/pump/` (owned by the transaction library, imported by pages):
```ts
export type Chain = { mint: string; quoteMint: string | null; tokenProgram: string; quoteTokenProgram: string; migrated: boolean; depth: number }[]; // self first, down to the depth-0 root
export function hopsFor(chain: Chain, side: "buy" | "sell"): MultiHopHop[];      // SOL → root → ... → coin (buy) or reverse (sell); only SOL-rooted chains are tradable here
export async function quoteSwap(conn: Connection, user: PublicKey, chain: Chain, side: "buy" | "sell", amountIn: bigint): Promise<{ amountOut: bigint; logs: string[]; unitsConsumed: number }>; // simulateTransaction with minAmountOut = 1, parse the final TradeEvent/BuyEvent from logs
export async function buildSwapTx(conn: Connection, user: PublicKey, chain: Chain, side: "buy" | "sell", amountIn: bigint, minAmountOut: bigint): Promise<VersionedTransaction>;
export type SpawnForm = { name: string; symbol: string; uri: string; creatorFeeBps?: number };
export async function buildSpawnTx(conn: Connection, creator: PublicKey, parentMint: PublicKey, form: SpawnForm, shares: { address: PublicKey; shareBps: number }[]): Promise<{ tx: VersionedTransaction; mint: Keypair; depth: number }>; // create_v2 (+ pumpQuote accounts) + create_fee_sharing_config + update_fee_shares_v2 in ONE v0 transaction; compute budget set; throws typed errors from resolveQuoteMint
export async function sendAndConfirm(conn: Connection, wallet: WalletContextState, tx: VersionedTransaction, extraSigners?: Keypair[]): Promise<string>; // poll-based confirm like ~/tldpad/app/web/src/lib/tx.ts (no websockets through the proxy)
```
If one transaction is too large (legacy limit 1232 bytes; v0 without a lookup table has the same byte limit), split into tx1 = create_v2, tx2 = fee sharing, and say so in the Spawn steps UI. Measure with `tx.serialize().length` in the simulation test and record the number in `web/test/README.md`.

Visual direction: dark, organic, premium. Palette: background `#07100b` → `#0b1a12`, surfaces glass `rgba(255,255,255,.04)` with 1px `rgba(182,255,92,.12)` borders, accent spore-lime `#b6ff5c`, secondary violet `#b08cff`, text `#e8f3e8` / muted `#8ea596`. Fonts: Geist + Geist Mono (Google Fonts, as in Handle). A full-screen canvas of slowly drifting glowing spores behind the hero (requestAnimationFrame, pauses when hidden, respects `prefers-reduced-motion`). Tree viz: d3-hierarchy radial tree in SVG with the centered coin in the middle, parents inward, children outward, node size by lockedUsd, coin images clipped in circles, hover tooltips, click navigates. Cards show coin image, name, ticker, parent ticker pill ("↳ under $PARENT"), depth badge, mcap, locked, age. Numbers formatted compactly (`$12.4K`, `1.2M`). Mobile-first responsive, 16px gutters, no horizontal scroll. Wallet buttons come from wallet-adapter (real wallet logos; never hand-drawn brand logos). Loading skeletons, empty states, error toasts. Light theme is not required.

## 9. Testing

- `server`: `node --test` pure tests for decoders (feed a real base64 `CreateEvent`/`TradeEvent` captured from mainnet into a fixture), pricing chain math, split merging, image allowlist. Network smoke (skipped with `SPORE_NET=0`): fetch one depth-2 curve and walk its chain.
- `web/test`: `npx tsx test/simulate.mts` builds (a) a spawn under a live depth-1 parent and (b) a SOL → depth-2 buy and a sell, simulates both on mainnet with `sigVerify:false, replaceRecentBlockhash:true` from a funded public wallet (`dBs75Gf7RXQMAsMLuTLYdH2fHV1ac9zgCEh6zC7TxXs`; it is a public key, nothing is signed or sent), and prints units consumed, serialized sizes, and the decoded result. Both must pass without "custom program error".
- `npm run typecheck` and `npm run build` in `web` must pass with zero errors.

## 10. Rules for everyone working in this repo

- No secrets, ever: no private keys, no RPC keys in source. Read `RPC_URL` from env. Never read `.env` files.
- Never send a transaction from tests or scripts. Simulation only. Launching a coin on mainnet happens only when the owner does it in the browser.
- Do not run `npm install` in `web` (deps are installed; `d3`, `lightweight-charts`, `bn.js`, `tsx` included). The server may add a dependency only if truly needed.
- Node 25: `node:sqlite` (`DatabaseSync`) is available; no native modules.
- Comments explain why, not what. Keep files focused; no 2 000-line files.

## 11. Launchpad rules (owner decisions, 2026-10-18)

**Spore is a launchpad, not a coin project.** Spore never launches coins itself; revenue is commission on other people's launches. The platform wallet is `FcbEAMqBvJVsfcFWDbED7geyBLR88ypcY88BoUSgmeT5` (env `PLATFORM_WALLET`).

### 11.1 "Ours only" (default `SHOW=ours`, env; `SHOW=all` restores the full pump.fun tree for development)
A coin is **ours** when its on-chain fee-sharing config gives the platform wallet at least `PLATFORM_MIN_BPS` (env, default = the platform slice of `SPLIT_BPS`, i.e. 5000; a config that merely lists the wallet at 1 bps does not count), or, for the first minutes after a spawn, when the UI reported it through `POST /api/spawned {mint, sig}` and the server verified the signature on-chain (`getTransaction`: a pump CreateEvent for that mint, a wallet creator, and a platform balance gain ≥ `LAUNCH_FEE_SOL`; self-launches by the platform wallet are exempt). Verified reports set the pending flag (TTL 10 min, map capped at 500) and persist `feePaid`; the indexer then confirms the sharing config and drops the flag if it never appears. Reports without a valid signature are refused (400; 404 + retry-after while the RPC has not seen it). Depth-0 roots launched here are ours too and appear in the feed. Every coin gets `ours: boolean`, `oursPending: boolean` and `feePaid: string|null` in the API.
In `ours` mode: `/api/feed`, `/api/stats`, `/api/roots`, `/api/map`, `/api/tree`, `/api/candles` and the `children` of `/api/coin` include only our coins; ancestors of our coins are served as context (`ours:false`, shown in breadcrumbs, the map and as the "root" of a cluster); roots are the depth-0 ancestors of our coins (one row per root, counts = our descendants only). `/api/search` and `/api/eligibility` keep covering all of pump.fun (anyone may spawn under any coin). `Stats` gains `{ mode: "ours"|"all", ourCoins, otherChildren }` so the UI can say "and N other children on pump.fun". The indexer keeps indexing the whole tree in both modes. The map's side panel charts any coin it draws through `/api/candles/:mint?scope=all` (the map is the all-scope surface, §11.5); without `scope` the defaults stay ours-only.
Empty states (nothing launched yet): Home/Explore/Map show a "No spawns yet — be the first" card with the Spawn CTA, never a broken layout.

**Client-side policy (security review 2026-10-18, finding #1):** the web bundle pins the platform wallet, the maximum launch fee (0.02 SOL) and the split (`web/src/lib/policy.ts`). `flow.ts` derives the shares with `splitShares` and refuses to build when the server's `shares` or `launchFee` differ (`PolicyError`, shown on the Launch page); the fee-split retry and the coin page's "Lock fee split" derive from the policy too, never from a stored record or the API. The server can explain and preview the split but cannot move money. Server side, `POST /api/spawned` accepts a CreateEvent only from the pump program's own log frame, requires the mint among the signers, and the self-launch exemption only when the platform wallet signed; the pending window is anchored to the transaction's block time.

### 11.5 The map shows everything, live (owner 2026-10-19: "anlık olsun ve mapte her şey gözüksün")

The Map page is the one surface that shows the **whole pump.fun custom-pair ecosystem** (every root with a tracked child and every descendant, ~15 k coins and growing), whatever the listing mode; Spore launches carry `ours: true` and a lime ring. Explore, feed, stats and roots stay ours-only.

**Server contract**
- `GET /api/map?scope=all&limit=all[&depth=2]` → `{ roots: MapNode[], scope: "all", version, generatedAt }` with **every** root and **every** descendant (no fan-out cap when `limit=all`); `limit=<n>` keeps the top-n behaviour. The all-tree is built at most once per 10 s (cached per model version), gzip/ETag as every JSON route; building it for 20 k nodes must stay under 300 ms (`mapRef` only, no `view()`).
- SSE `pair` (new): emitted for every coin the live stream sees whose parent is tracked (depth ≥ 1), in both modes, and again when a known child's parent becomes known during adopt/enrich (deduped per mint for 60 s). Payload `{ coin: MapCoin, parent: MapCoin }` (both `mapRef`), so a client can add the root when it is not drawn yet. `coin` keeps its ours-only semantics.
- SSE `mapdelta` (new): at most every 3 s, only when something changed: `{ at, updated: [{ mint, mcapUsd, lockedUsd, children, descendants, migrated }] }` for coins whose numbers moved (trades, refresh ticks, completes), capped at 500 entries per batch (largest lockedUsd first when capped). `trade` stays as is.
- Tests: all-tree route (shape, no cap, version), `pair` emission on a live CreateEvent with a tracked parent, `mapdelta` batching and cap.

**Web contract**
- Map page defaults to **everything** (`limit=all`); the roots control becomes all · top 200 · top 60 (URL-synced, `all` default on desktop; phones default to top 200 with "all" available, documented in the UI).
- Performance budget at 20 k nodes (headless Chrome, software raster, 1440×900): ≤ 16 ms per frame while settled, ≤ 33 ms while the layout settles, first paint of the bubbles within 2 s of the data arriving. How is an implementation choice (force simulation in a Web Worker with transferred Float32Array positions, or per-root `d3.pack` plus a cluster-level force) and must be written in a comment at the top of BubbleMap.tsx. Sprites cached, offscreen culling, labels only when zoomed in (cap 120 visible), hull glows only for the 60 largest clusters, no per-frame allocation in the draw loop.
- Live: `pair` inserts the child (and its root when absent) with the pulse animation, placed by a deterministic rule and never relaxed (Map v3 below; until 2026-10-20 a local relaxation); `mapdelta` tweens radius/values; `stats` updates the panel counters; the LIVE dot reflects the stream status. Pan/zoom/hover/click/search/`?focus=` keep working at full size; Esc clears.
- Verified by a CDP script in web/test (frame timings at full load, console errors = 0, screenshots at 1440 and 390, a synthetic `pair` event inserted through the EventSource mock or a real one observed).

**Owner feedback 2026-10-19 (must be met):** "opening the map lags a lot; does it re-request everything each time? Only the new ones should be added; and coin names and logos are sometimes missing."

**Delta sync + client cache (no full reload on every open)**
- Every coin row carries `updated_at` (ms); `GET /api/map?scope=all&limit=all&since=<ms>` returns only nodes with `updated_at > since` (each with its `parentMint`; the client already has the rest), plus `removed: []` (reserved), `generatedAt` and `total`. Without `since` the full tree comes back. Both variants ≤ 300 ms to build, cached 10 s.
- The web client persists the full node set **and the layout positions** in IndexedDB (key: node mint; store `generatedAt`), renders from the cache immediately on open (bubbles painted < 500 ms after navigation on a warm cache), then asks `since=<generatedAt>` and merges: new nodes are placed next to their parent (Map v3: by the deterministic rule, no relaxation; a cache missing up to 64 coins places them the same way, more settle among the pinned rest), changed values tween, nothing restarts. A cold cache does one full load. The cache survives reloads and republishes; a schema `v` bump clears it.
- Live `pair` / `mapdelta` events patch the same cache, so the next open is already current.

**Metadata coverage (names and logos must show)**
- On-chain name/symbol exist for 99.9 % of mints (`mints` table) and are what the map labels use; a bubble without off-chain metadata still shows its on-chain name. Never draw a nameless bubble when the mint has a name.
- Off-chain metadata (image, socials) is fetched for **every tracked coin** in both modes, not only in-scope ones: a background queue ordered by locked value / recency, concurrency 6, persisted in `meta`, retried with backoff (403/404/timeouts from one gateway are not final). IPFS URIs (`ipfs://` included) are tried through a gateway rotation (pump.fun's pinata → ipfs.filebase.io → 4everland.io → ipfs.io → dweb.link → gateway.pinata.cloud → w3s.link; cf-ipfs.com is dead) and the image proxy uses the same rotation for `ipfs://`/`/ipfs/` URLs; a rotation in which no public gateway looked for the file (each one paused, rate-limited, out of budget, failing on the network or with a 5xx other than 504) is a deferral, asked again within the hour, not a failed attempt. Target: ≥ 95 % of tracked coins with a resolved image within an hour of first sight; `/api/health.meta` reports coverage (`withImage/total`).
- Labels: the map draws the ticker label for every bubble whose on-screen radius ≥ 9 px (not only the largest), culls by overlap (cap 160 visible), shows the full name + ticker on hover/tap, and draws the logo whenever the image is loaded (letter avatar meanwhile, swapped in without a flicker when it arrives).
- Image re-check: `META_IMAGE_RULE` (lib/meta.mjs) versions the rule that decides which image URLs are usable. When the rule recorded in `kv.metaImageRule` (default 1) is older, the first sweep after boot treats every resolved row without an image as due whatever its age (usual order: locked value, then recency, so the largest roots come first), logs `meta: image recheck queued N` and records the new rule: once per rule change, never once per boot. Rows that have an image are never refetched by it and no TTL changes. Rule 2 (2026-10-19, any public https host) re-checked 5 204 rows and took tracked coins with a logo from 59.1 % to 94.6 % within six minutes of the first boot (NTRNDM, simulator and UHI among them). Bump the rule whenever it widens again. A restart before the queue drains leaves the rest to the regular 24 h no-image TTL.

**Activity (heat)**
- `lib/activity.mjs` keeps exact sliding windows per mint: trades and USD volume over the last 24 h, trades and buys over the last hour, and the last trade's time. A trade is an O(1) append to a time-ordered ring of typed arrays; two read heads (24 h and 1 h) walk forward as the clock moves and decrement the counters of what they leave behind, so nothing is allocated per trade and reads are free. A trade exactly 86 400 s (3 600 s) old is still inside, like SQL's `time >= now − 86400`. Only rows sqlite actually inserted are counted (`insertTrade` returns false for a replayed `(sig, mint, idx)`). Boot seeds the counters from `trades` (`time >= now − 86400` in time order: ~120 k rows in ~150 ms on a warm cache). A trade older than the newest one recorded is appended anyway; the window edges are then off by that skew.
- They replace the GROUP BY over 24 h of trades that every new trade invalidated (70–200 ms on the event loop, re-run by the next /api/stats or /api/coin after each of ~3–8 trades/s). `volume24hUsd`, `trades24h`, `Stats.volume24hUsd` and the roots' volume sort read `model.volumes()`, with the shape and meaning of `Db.volume24hAll()`.
- `GET /api/map/heat` (`Heat`, §7) serves them to the map as a sidecar of parallel arrays: every tracked coin with a trade in the last 24 h, whatever SHOW, most trades in the last hour first, then 24 h volume. It is rebuilt at most every 15 s (`HEAT_CACHE_MS`) and kept with its encoded bytes like the forest (`max-age=15`, ETag/304); about 60 KB gzipped for 1.5 k active mints, built in a few ms. It is a sidecar rather than part of `mapRef`/`since=` because the numbers decay with the clock without any row changing, so a delta keyed on `updated_at` could never carry them. The client polls it every 60 s while visible and advances its rows from the SSE `trade` stream in between.
- Caveat: the counters include trades the 2 000-rows-per-mint SQL trim later deletes, so a mint with more than 2 000 trades in 24 h reads higher than a SQL recount until the next restart re-seeds (2 010 against 2 000 for the busiest mint when measured).
- `/api/health.activity` = `{ mints, events, seededMs }`.
- The derived pass (`computed()`: prices, locked value, descendants) still runs once per model version, and every live trade moves the version. Its per-coin inputs are now memoized by coin object (an indexed coin object is never mutated) and the descendant counts by tree structure, which takes it from ~22–31 ms to ~12–13 ms at 16 k coins (same data, same machine) with identical output. Making it incremental is a later step.

**Map v2 (web, 2026-10-19)**
- Overview: the largest trees carry a title (`$ROOT · <coins>`) at overview zoom; hovering a cluster shows its root, coin count, locked value and largest children; clicking it frames the tree and selects its root.
- Spore launches are drawn as lime-ringed beacons of at least 4 px at any zoom.
- Trades draw ripples sized by log USD (a lime ring growing outward = buy, a pink ring shrinking inward = sell); a buy routed through the parent (same signature, child → parent) draws a comet along the link.
- Link dots move only on links whose child traded in the last 30 min (and on the hovered coin's links).
- Hull glows fade out between k = 0.6 and 1.6.
- Every camera move is a flight on the van Wijk zoom-and-pan path; the cold open snaps straight to fit.
- Highlight filters dim the coins that do not match and never remove them, so the layout stays: `?hl=ours,new1h,new24h,grad,min1k,active,since` (combined with AND); `?size=locked|mcap` picks the bubble area.
- Last-trade filter (owner 2026-11-10: the map is hard to read from afar): the Key's "Last trade" buckets (the engine's heat classes: within 30 min, 3 h, 24 h, older; "older" includes never traded) are toggles that HIDE the coins of a bucket that is off: a hidden coin is not drawn, not pickable, unlabelled, with no link to its parent and no live effects (the page's node list is never filtered). **On the WebGL map a filter change re-lays the map out around what is shown** (owner 2026-11-10: with only the most active pairs of a big family shown, the pairs were tiny at the end of very long links): the map is rebuilt from the shown coins, their ancestors (dim anchors) and the selection's lineage, so every family is laid out compactly around what is shown and its fit zooms in on it; a family with nothing shown is left out. Chip sizes, shares, the family size label and the ghosts stay those of the whole family, and the families keep the whole map's relative order (ranks and the planets are counted among the families the build holds, so a family can move up when a bigger one is left out), and a family keeps its shape across filtered builds (the layout is seeded by the full map's order). A toggle answers at once on the map on screen (a bucket turned off fades in place; one turned on waits for the new layout, which also keeps class-3 ghosts and specks off a compact tree) and rebuilds once the toggles settled and the map is still (about half a second; a switch back to everything rebuilds the full map, as slow as the first load). Between builds a coin that ages out fades where it is, and a coin that comes in (a trade, a heat poll, a side-panel hover, a new pair's parent) is placed next to its parent without a rebuild and without the new-pair fanfare (a real new pair keeps its spark, ring and label); an explicit pick of a coin the build left out (search, a rail, `?focus`) is shown at once next to its parent and rebuilt right away with it, framed on it (a pick in a capped family the build left out too, and a Dominance row of a family the build left out, which selects its top). Buckets that hold no coin at all (nothing selected) build only the family tops, hidden, so what comes into them later is added live. The map re-compacts when idle (the drift rule: enough coins hidden, added or wanted, each counted once, or any coin wanted from a family the build left out once the build is 30 min old; never while the viewer interacts or a coin card is open, so the coin being read about never moves). The classic map keeps hiding in place (its layout never moves: it is the fallback renderer, and its d3-force layout and cache would need a cold relayout per toggle). The ancestors of a shown coin (up to its family top, listed assets included) stay as dim anchors (TOK.dim, clickable), so a coin never floats without its lineage; a family whose members are all hidden is gone whole (top, chip, title, hull). The selected coin and its ancestor chain are always shown, and the side panel says when the selection's own bucket is off. Default: everything that traded in 24 h, "older" hidden; `?last=30m,3h,24h,old` (canonical order; no param = the default, `?last=all` = the filter off, at least one bucket stays on); `K` toggles default ↔ all. Each bucket shows its coin count and the Key says "showing N of M coins"; the highlight chips count only the coins they light up (shown or selected; a dim anchor is not counted). A coin born in the last 30 min files under "within 30 min"; while that bucket is on, a trade or a birth shows its coin at once on both renderers (on the WebGL map, a coin whose whole family the filtered build left out comes with the next re-compaction instead: about 30 min after the build at the latest, once the map is idle). Until the heat sidecar answers (or on a server without it) nothing is hidden; a warm reopen in the same tab starts from the previous heat (< 2 min old), so the page and the WebGL engine always apply the same filter. Cost: a filter change on the WebGL map is one rebuild of the filtered set (fewer coins than a full build), O(n) per heat poll that moves coins across it, O(depth x local placement) when a coin comes in, nothing per frame (`web/src/lib/map/visibility.ts` buildSet; the WebGL engine's `compact` build, `reveal` and `setLastFilter`; the classic map's hide bit).
- Rails: New, Hot (trades in the last hour, from heat), Growing and Spore, plus a "since your last visit" count.
- Side panel: mcap, locked value, children and descendants come from the all-scope map node; price, volume, curve and socials from `/api/coin/:mint?children=0&trades=0`; the price sparkline from `/api/candles/:mint?scope=all`. Breadcrumb, Frame tree, sortable children list, Share and Copy CA. Search covers every node on the map and resolves pasted mints and pump.fun URLs, with a pump.fun fallback; arrow keys walk the tree; phones get measured insets and a peek/full bottom sheet.
- The client runs a full re-sync (no `since=`) when its last full load is older than 15 min. This bounds the USD drift of warm caches, because `since=` carries only the coins whose own row changed.
- Logo thumbnails are downsampled on the client (square, 64–256 px, LRU by pixel budget).
- A server without the heat sidecar or `scope=all` (404) degrades: the Hot rail, the "Traded 1h" filter and the sparkline are hidden.

**Map v3 — a live simulation you can drag (owner 2026-10-20: "the map as it was when we first opened the site, how it dragged, was better"; the rigid family drag, its liquid flow and the earlier no-motion build are withdrawn)**
- Layout: d3-force in the worker (`web/src/components/map/layout.worker.ts`) with the first launch's forces: links to the parent (distance r + r + 20 for depth ≤ 1, + 12 deeper, strength 0.7), a short-range charge (−max(30, 3.5 r), reach 140, θ 1.1), collision (r + 6, strength 0.9) and a pull toward the family's centre (0.25 for a family top / depth-0 root, 0.06 for everything else); family tops also keep every member outside their disc. It runs for a cold open without cached positions, an explicit relayout (the size-mode or focus change) and every drag, and sleeps (posts nothing) once alpha falls under 0.01. A live `pair`, a `mapdelta`, a hover or a zoom never re-heats anything. While it runs the page interpolates between the last two worker frames, redraws every frame and re-measures the hulls, anchors and titles from the worker positions, so they travel with the bubbles; once it rests the positions go to the cache.
- A live pair is appended in place (links, cluster, draw order: `store.addLinks / addToClusters / insertOrder`) and placed by one deterministic rule (`lib/map/place.ts`: rings around the parent at r_parent + r_child + gap, outward from the family's top, the first spot clear of the family's other bubbles); its spot goes to the cache ~2 s later. Up to 64 newcomers per data change take this path; more at once (a wider roots limit, a cache missing many coins) settle among the rest, which stays pinned. `mapdelta` tweens radii in place and re-sorts only the changed nodes (one memmove each; a full sort past 400).
- Drag (as at the first launch): pressing a bubble ≥ 3 px and moving past 4 px grabs that bubble; at overview a tree's title (or, for a mouse, its hull) grabs the tree's root, so a family can still be dragged from far out. The grabbed bubble follows the pointer exactly (the page sets its position and posts `{t: "drag", i, x, y, phase: "start" | "move" | "end"}`); the worker reheats on start (alphaTarget 0.25, alpha ≥ 0.3) and keeps ticking while the pointer is down, the bubble is pinned at the pointer on every move, so its children trail behind it on their links, the neighbours flow out of the way and the map breathes; on release alphaTarget goes back to 0, the bubble is unpinned and the layout cools to rest in ~1.3 s. A drag never moves a family's centre: a dropped root glides back toward home (part of the way, as at the first launch: its own children trail and hold it). Below 4 px it is a click.
- Speed: one tick of the whole 17 k-node forest costs ~60 ms (charge ~33 ms + collision ~24 ms), far too slow to follow a pointer, so a drag on a resting layout reheats a local simulation: the same forces on copies of the grabbed bubble's family and every family whose disc comes within 420 world units + that family's radius of it, with the families in a 260-unit ring beyond pinned as obstacles, one tick per display frame (~60 Hz, d3's own rate) and the alpha decay applied per frame of wall time (0.04), so a large region whose tick takes longer still rests in ~1.3 s. As the bubble is carried further out, the families near its new spot join (velocities kept). A drag while a cold settle or a relayout is running joins that full simulation instead.
- Pan and zoom are a pure camera transform. The render loop draws only when something changed (`draw.ts invalidate()`) or animates: flights, the settle interpolation, grow-in and pulse rings and leftover sprite builds follow at the display rate; trade fx, radius tweens, link dots, beacon breathing and the selection ring alone are redrawn every ~33 ms (at overview zoom some ripple is nearly always alive with the live stream); a static map draws nothing.
- Logos are fetched as blobs and decoded + downsampled into ImageBitmaps off the main thread (the <img> + canvas path stays as the fallback), so a zoom into a cluster no longer pays a 50–60 ms synchronous decode.
- Budget, restated: the frame budget is measured as animation-frame intervals and long tasks (`web/test/map-perf.mts`: no long task and no frame over 50 ms during a gesture, a flight, a trade burst or a drag; a static map under 35 draws/s; nothing moves on a settled map, after a synthetic pair or after a drag's settle), with draw() ms as the secondary number. Under headless software raster the canvas commit, not the script, bounds the frame (p50 ~20 ms at 1440×900); on the GPU the map runs at the display rate.

**Dominance (owner 2026-10-20: "the market share of a pair given the sum of the pair value, so you can see which pairs have the biggest dominance outside of the size of the cells")**
- A family (a top: a SOL root or a listed asset such as $PUMP, plus every coin under it on the map) has a value in each size mode: the weight its top bubble is drawn by (`lib/map/sizing.ts` familyWeights: Σ valueOf over the family, the leaf slice of market cap included in "locked"). Its **dominance** is that value over the sum for every family on the map, so the number and the bubble always agree and the shares of a mode add up to 100 %. A coin alone on the map is a family of one. A family with nothing priced (value 0: ~100 tokenized-stock tops have no USD price) reads "—", not "0 %". Format: one decimal below 10 %, whole numbers from there, "<0.1%" for a sliver (`sharePct`).
- Web (`lib/map/dominance.ts`): the map page computes both modes' tables from the whole node set (all roots, whatever the roots limit draws) in one family pass, ~3 ms at 17 k coins, at most once a second while the stream patches; never per frame.
- Surfaces: (1) the cluster title gets the share in the current size mode after its text ("$PUMP · 1,352 · 41%"), drawn only where that strip is free once every title has its place, so a tag never costs a title (or a forced label) its place: the set of titles is exactly the one without tags (node labels, placed after, keep clear of the tags), and a step of zoom shows the tags a crowded overview drops; phones tag only the families of 1 % and more; the hovered (or selected) tree's title always shows its tag, and that strip is kept together with its title, before any other title is placed, so no title lands under it. (2) The hovered tree's tooltip: "dominance 41% locked · 29% mcap" with a thin bar; the side panel of a selected coin: its family, size and rank ("$PUMP family · 1,352 coins · #1 of 2,004") and "Dominance: 41% of all locked value · 29% of market cap" with a bar of the share in the current mode. (3) A Dominance rail tab next to New/Hot/Growing/Spore: the 20 largest families for the size mode, each with a bar and its %; a row flies to the whole family and selects its top (the cluster click's flight; a family outside the drawn roots widens to everything first). (4) The coin page of a family top (depth 0): one line under the stats, "Dominance: 10% of all locked value · <0.1% of market cap · on the map →", from `GET /api/map/dominance` (`server/lib/dominance.mjs`, the same rule over the cached all-scope forest, 30 s per mode; the web test checks that both give the same numbers for the same tree). A root that hangs under a listed asset is a member of that family, not a top, and shows no line.
- Measured 2026-10-20 (full dataset, 17 k coins, 2 004 families): shares add up to 1 (page and server), the 10 largest families by share are the 10 largest top bubbles in the same order, page vs server within 0.01 percentage points on the top 20 when both are fresh (up to ~0.2 points while the server's 30 s table lags the live page), and map-perf / map-interact unchanged (titles at fit 40 with 10 of the 10 largest at 1440, 12 with 6 at 390; idle, gesture, burst and flow frame times as before).

**Owner commitment (2026-10-19):** the platform's 50 % share of creator fees is used to buy the Spore coin ($SPORE, to be launched by the owner) and lock it; the site says so on Home, Fees, How, Launch and the footer. X account: https://x.com/Sporemap (footer link).

### 11.7 Claim page

`/claim` (nav item "Claim"): connect a wallet → every indexed coin whose fee-sharing config names it, with the pending fees, the wallet's share and part, a Claim button per coin (same build → simulate → confirm → wallet flow as the coin-page card) and "Claim all" (sequential, one wallet approval each; a refusal stops the run). Below: the Spore launches with fees waiting, claimable by anyone (the signer pays the network fee, the program pays the shareholders).

- `GET /api/claims/:wallet` → `{ wallet, coins: [CoinRef & Fees & { yourBps, yourAmount, yourUsd }], totals: { usd, byQuote: [{ quoteMint, quoteSymbol, quoteDecimals, amount, usd }] }, updatedAt }`, max 100 coins, sorted by `yourUsd`; 400 on a malformed wallet.
- `GET /api/claims?limit=50` → the Spore launches with `total > 0`, sorted by `totalUsd`, cached 30 s.
- Both read fee accounts in batches (`Treasury.feesMany`, one getMultipleAccounts per 20 coins) through the 15 s per-mint cache `/api/fees` uses.

### 11.2 Launch fee
`LAUNCH_FEE_SOL` env (code default `0.02`; **production runs 0 since 2026-10-19 by owner decision: launching costs only network fees, Spore earns only through the 50% creator-fee share**; the web pins 0.02 as the maximum it will ever sign). `GET /api/eligibility/:mint` returns `launchFee: { to: string; lamports: string; sol: number }`. The web passes it to `buildSpawnTx(..., launchFee)` (lib/pump already adds a SystemProgram transfer to the platform inside the create transaction). The Spawn page shows a cost box before signing: launch fee, estimated network rent (~0.025 SOL: mint + curve + fee-sharing config + vault ATA) and the optional first buy, with the total. A fee of 0 hides the line.

### 11.3 Metadata hosting
pump.fun's `/api/ipfs` is retired (500 as of 2026-10-18). Metadata is self-hosted: `POST /api/upload` validates like before, then writes content-addressed files under `deploy/pages/public/m/` (`<sha256>.<ext>` image, `<sha256>.json` metadata `{name, symbol, description, image, showName:true, createdOn, twitter?, telegram?, website?}`) and publishes the directory to the Cloudflare Pages project `spore` (`tools/publish-meta.mjs` does exactly this; reuse its logic as a module, serialise deploys with a queue, one deploy may batch several uploads). Response stays `{ metadataUri }` with `https://spore-2x6.pages.dev/m/<hash>.json` (env `PAGES_DOMAIN`). The server also serves the same files locally at `/m/<name>` and resolves metadata/image URLs under `PAGES_DOMAIN` from the local directory first (this Mac's network cannot reach `*.pages.dev`; production servers can).

### 11.4 Infrastructure owned by the platform wallet (2026-10-18)
- Address lookup table `5WK4tafybAnHV4grvSipYfLfV8Bd7Rzcwb5eNE1PQRnx`: 56 static pump/pump-amm/pump-fees accounts, created and **frozen** (no authority) by the platform wallet with `web/tools/create-alt.mts`; `web/src/lib/pump/alt.ts` points at it. With it: spawn 954 B, fee split 720 B, 3-hop buy 905 B, 2-hop sell 762 B.
- Treasury: `web/tools/treasury.mts` (`list` / `claim --send` / `sell <mint> --send`) scans the pump-fees program for sharing configs that pay the platform (shareholder at byte 114, or 80 when merged), sums the curve bucket + creator vault + AMM vault, and distributes with `sweep_creator_fee` → (`sweep_creator_fee` on the pool + `transfer_creator_fees_to_pump_v2` when migrated) → `distribute_creator_fees_v2(initialize_ata=true)`. Rehearsed in simulation on three live coins of another launchpad (curve/token quote, curve/SOL quote, migrated pool). A scheduled claim (server keeper) is the natural next step.
- Metadata publisher: `tools/publish-meta.mjs` + Cloudflare Pages project `spore` (`spore-2x6.pages.dev`).

### 11.6 Claim fees (owner 2026-10-19: "a claim-fee action on every coin page, like other launchpads")

**Mechanics (pump.fun).** A coin's creator fee waits in up to four places: the bonding curve's `creatorFee` bucket (unswept trades before migration), the pump-amm pool's `creator_fees` bucket (unswept trades after it), the fee-sharing config's **creator vault** (SOL as lamports on the vault PDA above its rent floor, `rent.minimum_balance(0)` = 650 240 lamports on mainnet today; a token-quoted coin's fees in the vault's ATA for the quote mint) and, once migrated, the **AMM creator vault** (a token account of the quote mint, WSOL for a SOL-quoted pool — never lamports on the PDA). Distribution is **permissionless**: anyone pays the transaction that sweeps the buckets into the vault and runs `distribute_creator_fees_v2`, which pays every shareholder of the sharing config in the coin's quote (SOL or the parent token). Order of instructions (as `web/tools/treasury.mts claim` does it): `sweep_creator_fee` on the curve when its bucket > 0 → when migrated, `sweep_creator_fee` on the pool + `transfer_creator_fees_to_pump_v2` → `distribute_creator_fees_v2(initialize_ata = true)` with the sharing config's shareholders as remaining accounts. Coins without a sharing config (`shares: null`) and holder-reward coins have nothing to claim through this path. The program's own minimum (`get_minimum_distributable_fee`) is decided by the browser's preflight simulation, not by the server.

**Server contract**
- `GET /api/fees/:mint` → `{ mint, quoteMint, quoteSymbol, quoteDecimals, quoteUsd, shares: [{ address, bps }] | null, bucket, vault, amm, total, totalUsd, perShare: [{ address, bps, amount }], migrated, claimable: boolean, reason: string | null, updatedAt }`. `bucket`, `vault`, `amm`, `total` and every `amount` are raw quote units as decimal strings (`quoteMint` null = SOL, 9 decimals); `amm` = AMM vault ATA balance + the pool's unswept bucket; `vault` for SOL is what sits above the rent floor; `perShare[i].amount = floor(total × bps / 10 000)`. `shares` is the on-chain config read live (a config the indexer has not fetched yet is adopted into the model, so the coin becomes provably ours at once); `claimable` is false with one `reason` for a holder-reward coin, a coin without a config, or `total == 0`. The five accounts (curve, vault, AMM vault ATA, canonical pool, sharing config) are read in one `getMultipleAccounts` on the api RPC lane; cached 15 s per mint (concurrent callers share the read, a failed refresh serves the last value); rate limited like every api route; ETag + `max-age=5` like `/api/coin`; 400 for a malformed mint, 404 for a mint pump.fun does not know (an unknown one is looked up live first, like `/api/coin`), 503 when the RPC is unreachable and nothing is cached. The same per-coin reader (`lib/treasury.mjs`: `feeAccounts` + `feeBalances`) feeds `/api/treasury`, so the platform view counts migrated SOL coins' WSOL vaults too.
- A refetch right after a claim lands may still return the cached numbers for up to 15 s: the page polls until `updatedAt` moves (or shows the Solscan link and refreshes on the next tick).

**Web contract**
- `web/src/lib/pump/claim.ts`: `buildClaimTx(conn, payer, mint) → VersionedTransaction` (sweep the curve bucket when > 0, sweep the pool vault when migrated, `distribute_creator_fees_v2`), compiled v0 with the Spore lookup table (`alt.ts`), ≤ 1 232 bytes, for **any** connected wallet as payer; `simulate.ts` preflight before the wallet signs, `send.ts` to send.
- Coin page card **"Creator fees"**: pending total in quote + USD, the split rows with each shareholder's amount (the connected wallet's row marked "you"), a **Claim** button → preflight simulation (shows the network fee) → wallet → toast with the Solscan link → refetch. Disabled states with one reason each: no wallet, nothing to claim (below the program's minimum), no sharing config (then the existing fee-split action is shown instead), holder-reward coin. A small "fees to claim" chip on coin cards and feed rows when `total > 0` is optional.

## 12. Partner API & embeds (owner 2026-10-19)

Spore's map data is offered to other trading terminals (Axiom, GMGN, Photon, BullX, …) as a product: (1) embeddable widgets a terminal drops into a coin page with one iframe, (2) a versioned, documented, read-only API with keys for partners, (3) a public docs page. **Everything is read-only: no endpoint may sign, send or accept a transaction.**

### 12.1 API contract (`/v1`, same server: `https://sporepad.com/v1/...`)

JSON, camelCase; amounts as strings in raw units plus decimals; USD as numbers or null; timestamps unix seconds (`generatedAt`/`since` and `mapdelta.at` are milliseconds, as in §11.5). Every image URL is absolute (`https://sporepad.com/api/img?u=…`, built on `PUBLIC_URL`), since a partner page lives on another origin.

```ts
type CoinRef = { mint: string; name: string | null; symbol: string | null; image: string | null; depth: number };
type MapCoin = CoinRef & { ours: boolean; oursPending: boolean; mcapUsd: number | null; lockedUsd: number | null; children: number; descendants: number; otherChildren: number; migrated: boolean; createdAt: number | null };

GET /v1/coin/:mint/family → { mint, name, symbol, image, depth, quoteMint /* null = SOL */, quoteSymbol,
      root: CoinRef /* itself for a root */, parent: CoinRef | null, ancestors: CoinRef[] /* nearest first */,
      children: { count, top: (CoinRef & { mcapUsd, lockedUsd })[] /* ≤ 20, most locked value first */ },
      descendants, lockedUsd, mcapUsd, change24h: number | null /* percent */, trades1h, launchedOnSpore: boolean,
      links: { spore: "https://sporepad.com/c/<mint>", launchUnder: "https://sporepad.com/launch?parent=<mint>", embed: "https://sporepad.com/embed/tree/<mint>" } }
    Any pump.fun mint (looked up live like /api/coin when not indexed); 400 malformed; 404 for a mint that is not a pump coin; 503 + retryAfter when the live lookup fails.
GET /v1/tree/:mint → { root: CoinRef, nodes: (MapCoin & { parentMint: string | null })[], total }
    The whole tree containing the mint, from its root: root first, then breadth-first, siblings by locked value. A coin the index does not track is appended with its chain.
GET /v1/map?since=<ms> → /api/map?scope=all&limit=all (full: { roots, scope, version, generatedAt, total }; delta: { nodes, removed, generatedAt, total, version }). `since` is rounded down to the second.
GET /v1/heat → /api/map/heat (Heat, §7)
GET /v1/stream?types=pair,trade,heat,stats[&mint=<root or any coin of the tree>] → SSE
GET /v1/openapi.json → OpenAPI 3.1 of every /v1 route, schemas and examples
```

- **Numbers** are the whole-ecosystem ones (the map's `scope=all`), whatever `SHOW` is: `lockedUsd`/`descendants`/`children` count every pump.fun child. `launchedOnSpore` = ours or verified-pending (§11.1). `change24h` = current price against the last trade at or before 24 h ago (or the first trade inside the window when the history starts there), in USD when both prices have one, else in quote units; null without recorded trades. `trades1h` from the activity counters (§11.5).
- **Stream** types: `pair`, `trade`, `heat`, `stats` (default set) plus `mapdelta` and `coin` on request; unknown types → 400. `heat` is derived per trade: `{ mint, at, t1h, n24, v24, last, buys1h }`, the coin's /v1/heat row. `mint=` keeps the events of the tree containing that coin (its root resolved per event, so coins joining later are followed); `mapdelta` is narrowed to the tree's entries; `stats` is never narrowed. Images in `pair`/`mapdelta`/`coin` payloads are absolute. `retry: 3000`, heartbeat comment every 25 s, `Cache-Control: no-store`; a client whose socket stops draining is cut at 256 KB buffered.
- **Read-only**: the router registers GET routes only; any other method is 405 (`Allow: GET, HEAD, OPTIONS`); unknown /v1 paths are 404 JSON pointing at the docs.

### 12.2 Keys and tiers

- Key: `spk_` + 32 base58 characters (rejection-sampled, ~187 bits), sent in `X-API-Key`; `?key=` is accepted on `/v1/stream` only (EventSource cannot set headers; a key in any other URL is a 400, URLs end up in logs and caches).
- Stored hashed: sqlite `api_keys (id, name, contact, hash /* sha256 hex, unique */, tier 'partner', created_at, revoked_at, last_used_at, requests)`. The plaintext is printed once by the CLI and never logged, stored or echoed.
- Tiers: **public** (no key) 60 requests/min per client IP on /v1, 2 concurrent streams per IP; **partner** (valid key) 1 200 requests/min per key, 20 concurrent streams per key; an invalid or revoked key → `401 { error }` (and the attempt is charged to the caller's public IP budget). Every response carries `X-Spore-Tier` and `X-RateLimit-Limit/Remaining/Reset/Policy`; `429 { error, retryAfter, tier }` with `Retry-After`. Env: `V1_RATE_PUBLIC`, `V1_RATE_PARTNER`, `V1_STREAMS_PUBLIC`, `V1_STREAMS_PARTNER`, `V1_STREAMS_MAX` (2 000 total), `PUBLIC_URL`.
- Verification: a sha256 lookup (indexed) per keyed request, hits cached 15 s (a revocation from the CLI takes effect within 15 s; misses are not cached, so a new key works at once). Usage (`requests`, `last_used_at`) is counted in memory and written in one transaction every 30 s and at shutdown, never per request.
- Admin is a CLI only (no HTTP admin endpoint): `node server/scripts/keys.mjs create --name <partner> [--contact <x>] | list | revoke <id> | usage` on `DATA_DIR/spore.sqlite` (`--data` overrides; refuses a missing file). The server's sqlite connection waits up to 2 s for a lock (`busy_timeout`) so a CLI write never fails a server write.

### 12.3 HTTP behaviour

- CORS on /v1/*: `Access-Control-Allow-Origin: *`, methods `GET, OPTIONS`, headers `X-API-Key, Content-Type`, no credentials, `Access-Control-Expose-Headers` lists the rate headers, `X-Spore-Tier` and `ETag`; a preflight is answered 204 before auth and rate limits. /api/* keeps its allowlist.
- Caching: family/tree/map/heat send `Cache-Control: public, max-age=5, s-maxage=10` + weak ETag (304 on If-None-Match), so a CDN absorbs polling; openapi.json `public, max-age=300, s-maxage=3600`; errors and the stream `no-store`. A CDN-cached response may carry an earlier caller's rate headers; the limits are enforced at the origin.
- Costs: family is cached 5 s per mint, a tree 10 s per root (or per model version), the map/heat reuse the §11.5 caches; the /v1 map bytes are the /api bytes with `"image":"/api/img?` rewritten once per build.

### 12.4 Embeds

`/embed/tree/:mint` and `/embed/map[?focus=<mint>]` are pages of the web app rendered without the site shell (no nav, footer, official strip or background canvas), fitting any iframe size (min 320×240), `?theme=dark|light` (default dark), `?hideHeader=1`. They show the family tree / ecosystem map (BubbleMap and the map data layer), a compact header "Family tree · <$TICKER>" with a "Launch under on Spore ↗" button and a small "Powered by Spore" link; both open https://sporepad.com in a new tab and never navigate the parent. The server serves index.html for `/embed` and `/embed/*` with `frame-ancestors *` and **no** `X-Frame-Options`; every other path keeps `frame-ancestors 'none'` + `X-Frame-Options: DENY`.

### 12.5 Docs

Web page `/docs/api` (footer link "API", linked from /how): what the data is, quick start (curl, JS fetch, SSE) with real mints such as $SPORE `HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY`, every endpoint with params and an example response, tiers and limits, how to get a key (X @Sporemap, team@sporepad.com), the embed section (live preview iframe, snippet generator with theme toggle), attribution terms ("Data by Spore" + link required; free tier; partner keys on request) and a link to `/v1/openapi.json`.

## 13. Root agents (owner 2026-10-19) — phase 0: dry run

Every root coin can get its own agent: it learns what the coin is about, proposes new coins under it on that theme and, in a later phase, funds further launches with the creator fees its coins earn. **Phase 0 (this contract) is a dry run only:** agents produce real proposals and build and **simulate** the exact launch transactions, but nothing is ever signed or sent and no agent holds a private key. The code makes sending impossible, not just unused: `lib/agents/` has no keypair type, no signing call and no send path (a test scans it), every chain call goes through a read-only client that refuses anything but `getAccountInfo`, `getMultipleAccounts`, `getBalance`, `getMinimumBalanceForRentExemption` and `simulateTransaction`, and the agent's wallet and the coin's mint are placeholder program-derived addresses (off the ed25519 curve, so no private key can exist for them). Later phases (agent wallets, signing, spending fees) are specified separately and are not part of this contract.

Code: `server/lib/agents/` (`registry.mjs` storage + API views, `profile.mjs`, `llm.mjs`, `scorer.mjs`, `designer.mjs`, `blocklist.mjs`, `logo.mjs`, `simulate.mjs`, `runner.mjs`), `server/scripts/agents.mjs` (admin CLI), tests `server/test/agents-*.test.mjs`.

**Storage** (sqlite, the server's file; new tables only, created by `lib/db.mjs` like `api_keys`):
- `agents (root_mint PK, status 'dry'|'paused', profile_json, created_at, updated_at, last_run_at, next_run_at, runs, proposals, last_score, last_reason)`
- `agent_proposals (id PK /* 16 hex */, root_mint, created_at, name, symbol, description, image_file, score, reason, sim_json, status 'proposed'|'rejected', rejected_reason, source 'model'|'fallback', runners_json, metadata_uri)`; times are unix seconds. A proposal is `rejected` when its simulation failed (or could not run), with the reason.

**Profile ("purpose")**, built once per agent (rebuilt with the CLI) from the root's name, ticker, description, socials and its children's names: `{ summary ≤ 280, themes: 3-8 short keywords, tone, avoid[], palette: 2-3 hex, source: "model"|"fallback", builtAt }`. The fallback extracts keywords (description phrases and name ×3, ticker ×2, description words weighted by position, words that at least two children share), never a stop word, nationality, person, brand or blocked word, and picks a tone family (organic / technical / gritty / playful) and its palette (hue-shifted per root) from the root's own words first. A model answer is validated field by field; it counts as `model` only when its summary and themes are valid.

**Language model**: a pluggable provider configured only by env: `LLM_URL` (a `/chat/completions` endpoint in the common JSON chat format), `LLM_KEY_FILE` (the key is read from this file, never from the environment, and never logged or echoed), `LLM_MODEL`. Unset or failing (three failures in a row pause it for 10 min), every step uses its deterministic fallback, so the whole pipeline works without a key; every profile and proposal records `source`.

**Momentum scorer** (no model), per root: trades in the last hour (35 points), buy share of those (10, from 30 % to 70 % buys, needs ≥ 5 trades), 24 h USD volume (25), 24 h trades (10), existing children (15), time since its last proposal (5: none inside the cooldown, full after a day or when it never proposed); counts on a log scale against a busy reference (200 trades/h, $250 K, 2 000 trades, 300 children). Inputs from `lib/activity.mjs`. Only depth-0, non-mayhem coins can be launched under (otherwise score 0, never proposes). Gates, in order: score ≥ `AGENT_MIN_SCORE` (40), one proposal per root per `AGENT_COOLDOWN_MIN` (60), at most `AGENT_MAX_PER_HOUR` (12) proposals across all agents in the last hour. The score comes with a reason, e.g. `momentum 71/100: 106 children, 28 trades/1h (32% buys), 841 trades and $52.8K volume in 24 h, never proposed`.

**Designer**: 6 candidates per run (the model's first six valid ideas, topped up by the generator: theme + noun of the tone family, portmanteaus, rhymes on the root ticker that land on a common word, `Lil X` / `Xkin` / `Xling`), then filters: name 1-32 plain text, ticker 2-10 `A-Z0-9`, description 1-280, no links or markup; no real person or brand (`blocklist.mjs`; a single-word term matches a whole word, a multi-word term its squashed form, a ticker a 4+ letter term at either end), no slur or vulgar word (stored only as truncated sha256 digests, matched per word and, for long entries, per substring, after folding case, accents and leetspeak); not a ticker of one of the root's children, of the 2 000 biggest coins by market cap or of the agent's own last 50 proposals, not a child's exact name, not a near-duplicate of the root's ticker (equal, the root ± two characters, or one edit away for a ticker of ≤ 4 letters, two otherwise). When no candidate survives, up to two more rounds of six fallback ideas. Rubric: theme fit 45 %, brevity 25 %, uniqueness against the known tickers 30 %. The winner is the proposal; the other survivors are `runnersUp`; refused ones are kept with their reason in the record (not in the API).

**Logo**: 512×512 PNG drawn from the profile palette with a seeded motif (spores, rings, rays, hexagon or blob) and the ticker's letters as strokes from a built-in A-Z/0-9 font (tickers over five characters wrap onto two rows), rasterised by `@resvg/resvg-wasm` (no native module, no system fonts). Stored as `DATA_DIR/agents/<id>.png`, served at `/api/agents/img/<id>.png` (only files a stored proposal names; `public, max-age=31536000, immutable`).

**Simulated launch**: the exact transaction the web's `buildSpawnTx` builds for a child of the root: compute budget, the launch fee (`LAUNCH_FEE_SOL`, when > 0), `create_v2` quoted in the root (pump-quote accounts from the SDK's `resolveQuoteMint`), the sharing config vault's quote token account, `create_fee_sharing_config` and `update_fee_shares_v2` with Spore's split (`SPLIT_BPS`) where the agent's placeholder wallet is the creator, compiled v0 over Spore's lookup table; the metadata URI is the content address our metadata host would give this exact JSON and logo (computed, never published). Under a migrated root it does not fit one transaction, so, like the web, it is two: create (≈ 884-891 B) then sweep + vault account + config + split (≈ 871 B). The first is simulated (`sigVerify: false`, `replaceRecentBlockhash`) in a variant where the public probe wallet `dBs75Gf7RXQMAsMLuTLYdH2fHV1ac9zgCEh6zC7TxXs` pays the fee and lends the placeholder 0.1 SOL in a prepended transfer; the second needs the first landed, so its rent (sharing config 1 024 B + vault account) is computed. `sim_json = { ok, bytes /* the real first transaction */, unitsConsumed, err, estCostSol /* rent + launch fee + network fees of both */, txs, feeTxBytes, agent, mint, payer, simulatedAt, costBasis }`. Measured 2026-10-19 under the six seed roots: ok, 884-891 B, 145-205 k CU, ≈ 0.0148 SOL each (launch fee 0).

**Runner**: in-process, started when `AGENTS=dry`; every `AGENT_TICK_SEC` (300) it announces proposals other processes wrote, then evaluates each due agent in turn (`next_run_at`; paused agents never), strictly one run at a time; the indexer never waits on it, and its reads and simulations use the api RPC lane. `AGENTS=off` (the default) starts nothing; the read API still serves what is stored. `/api/health.agents` reports its counters.

**Admin CLI** (no HTTP admin endpoint): `node server/scripts/agents.mjs enable <rootMint> | pause <rootMint> | rebuild-profile <rootMint> | run-once <rootMint> [--gated] | list | seed`, on `DATA_DIR/spore.sqlite` (`--data` overrides; refuses a missing file), same environment as the server. `enable` refuses a coin that is not an indexed depth-0, non-mayhem root and builds the profile; `run-once` is the same dry run as the loop and skips the gates unless `--gated` (the reason says what the gates would have done); the running server announces a CLI proposal on its event stream within one tick. `seed` enables the owner's six roots: $SPORE `HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY`, $GTA `BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump`, $NTRNDM `NTRNDMqQSiwEC2jJs3wJiZS6bpGYQJtMNQJgiX3WyV6`, $simulator `8hnMfF4XL717GVwzDmvqjJvULozKW6w7BhHFABjvHje4`, $DOPE `33jENUQnjoitkMFpvNJcSHyLAHFWJuHwT6E3E8CNpump`, $VEIL `HgTGdc29D5bDMrDvsCLnorxz899VyDj7ZN7FPa6vpump`.

**API** (read-only, public; JSON; `max-age=10` + ETag on /api, the /v1 cache headers on /v1):
```ts
type AgentProfile = { summary: string; themes: string[]; tone: string; avoid: string[]; palette: string[]; source: "model" | "fallback"; builtAt: number };
type Proposal = { id: string; createdAt: number; name: string; symbol: string; description: string;
  image: string | null;  /* /api: "/api/agents/img/<id>.png" (same origin); /v1: "https://sporepad.com/api/agents/img/<id>.png" (PUBLIC_URL) */
  score: number /* the root's momentum when proposed */; reason: string;
  sim: { ok: boolean; bytes: number | null; unitsConsumed: number | null; estCostSol: number | null; err: string | null };
  source: "model" | "fallback"; runnersUp: { name: string; symbol: string }[];
  status: "proposed" | "rejected"; rejectedReason: string | null };
type Agent = { root: CoinRef; status: "dry" | "paused"; profile: AgentProfile | null;
  stats: { runs: number; proposals: number; lastRunAt: number | null; nextRunAt: number | null /* null while paused */; score: number /* live */; scoreReason: string };
  latest: Proposal | null };

GET /api/agents            → { mode: "off" | "dry", agents: Agent[] }   running agents first, then by live score
GET /api/agents/:root      → { agent: Agent, proposals: Proposal[] }   newest first, ≤ 50; 400 malformed, 404 "no agent for this coin"
GET /api/agents/img/:id.png → the logo (image/png, immutable, CORP cross-origin); 404 for anything a proposal does not name
SSE /api/events            → event: agent, data: { root, proposal: Proposal }
GET /v1/agents, /v1/agents/:root → the same bodies with absolute image URLs (root images and logos); documented in /v1/openapi.json
/v1/stream?types=agent     → the same event with absolute images (opt-in type; not in the default set)
```

**Configuration**: `AGENTS` (`off` | `dry`, default `off`), `AGENT_TICK_SEC` (300), `AGENT_MIN_SCORE` (40), `AGENT_COOLDOWN_MIN` (60), `AGENT_MAX_PER_HOUR` (12), `AGENT_PROBE` (the funded public wallet used as fee payer in simulations), `LLM_URL`, `LLM_KEY_FILE`, `LLM_MODEL`. Setting `LLM_KEY` itself is refused at boot (put the key in a file).

### 13.1 Live agents (owner decisions, 2026-10-19)

The dry run (§13) proposes and simulates. A live agent does the same and then launches, with these rules:

- **Own wallet.** Every agent has one real Solana keypair, created by `scripts/agent-vault.mjs new <root>` and kept
  encrypted at rest (`DATA_DIR/agents/wallets/<root>.json`, AES-256-GCM under the 32-byte key in
  `AGENT_VAULT_KEY_FILE`, mode 600; `lib/agents-live/vault.mjs`). The vault key and the wallets directory are backed up
  separately. The platform wallet is never an agent's payer; a keyless placeholder is never shown as an address.
- **Starting budget.** An agent runs only while its wallet is worth at least `AGENT_START_USD` (default $5, SOL + USDC
  at the indexer's SOL price; `budget.mjs canStart`). Every launch must leave `reserveSol` (0.005) behind and cover the
  simulated cost plus a margin (`canLaunch`). After the seed, money comes only from the creator fees its coins earn.
- **Models.** Only Claude or GPT (`models.mjs`: Sonnet 5.5 default, Opus 5.5, GPT-5.5, GPT-5.4 mini). Calls go through
  NanoGPT's accountless x402 rail paid per request in USDC from the agent's wallet (`pay.mjs`): quote → one partially
  signed TransferChecked of exactly the quoted USDC, fee paid by NanoGPT's facilitator → replay with `X-PAYMENT`. Each
  model has a per-call cap (≤ $0.08); the pocket must hold the cap before a quote is asked. No API key anywhere.
- **USDC pocket.** Fees arrive in SOL; when the pocket is under `aiFloorUsd` ($0.25) the agent swaps SOL → USDC through
  Jupiter to `aiTargetUsd` ($1) (`swap.mjs`: ≤ 1 % impact, agent-paid single-signer unsigned transaction calling the
  Jupiter program, simulated balance deltas checked, ledger before send). One top-up is $0.20–$5.
- **What the model does.** Name, ticker and logo, nothing else. The logo is an SVG the model draws, reduced to a strict
  vector subset (no scripts, links, images, external references; `ailogo.mjs`) and rasterised to 512×512 with resvg;
  a rejected SVG falls back to the template logo. The description is a fixed template naming the root.
- **Root split (the site's one fee rule).** A ROOT coin's creator fee (pump: 0.95 % of volume on the AMM, 0.30 % on the
  curve) is split creator 0.25 % / Spore 0.50 % / the root's agent wallet 0.20 % = **2632 / 5263 / 2105 bps**
  (`pricing.mjs ROOT_SPLIT_BPS`, pinned in `web/src/lib/policy.ts ROOT_SPLIT`). The agent wallet must therefore exist
  before the launch: `POST /api/agents/prepare {creator, model}` makes it (`vault.prepare`, file `pending-<id>`), the
  launch form puts its address in the split, and `POST /api/spawned {mint, sig, agent:{id, model}}` binds it to the
  mint (`vault.bind`) and enables the agent with the model the creator picked. Children keep creator 50 / Spore 50
  (an agent-launched child's creator is the agent wallet, so the agent also earns from its own coins). The launch
  also sends the agent wallet **0.01 SOL** from the creator inside the same signature (`AGENT_SEED_LAMPORTS`): an agent
  is born with nothing and needs that gas to claim its first root fees; from then on it lives on what it earns.
- **Model choice.** The creator picks the agent's model at launch (`AGENT_MODELS`, Claude or GPT only); it is stored
  on the agent (`agents.model`) and used for every paid call.
- **Cadence.** Live agents do not wait for momentum: every 5 minutes, for as long as the wallet can pay a launch
  (`canLaunch`), the agent launches one child under its root — a sensible name and ticker, a meme on that coin,
  nothing else. The dry run's momentum score stays visible on the agent page but gates nothing in live mode.
- **Launch.** `launch.mjs`: the dry run's `buildLaunch` with the agent's wallet as creator/payer and a fresh mint keypair,
  metadata published on our host first, simulated with a real blockhash, budget-gated, ledger-recorded, then signed
  (agent + mint) and sent; split set in the same transaction (or a second one when too large).
- **Fees.** `claim.mjs` reads the coin's buckets (curve, vault, pool) and claims permissionlessly when the agent's own
  share is ≥ 0.002 SOL (token-quoted coins: a share worth ≥ $0.05 at the indexer's price); one transaction pays every
  shareholder. The agent claims its ROOT first (its SOL income), then its children, one claim per pass, before any
  sleep gate.
- **Payout (owner 2026-10-19: automatic).** `payout.mjs`: every pass, after claims, an agent sends whatever exceeds its
  working balance (`AGENT_KEEP_SOL`, default 0.1 SOL, plus the reserve) and all idle USDC on the keyed rail to
  `AGENT_PAYOUT_ADDRESS` (the owner's Solana wallet) in one simulated, ledgered transaction. Unset = agents keep
  everything. Spore's own platform share is a separate wallet and a separate decision (Bitcoin via Relay, pending).
- **No outside input.** Agents read only the indexer and the chain. There is no chat, no holder orders, no API that
  tells an agent what to launch. Humans can pause an agent (`AGENTS=off` stops all).
- **Ledger.** `DATA_DIR/agents/ledger.jsonl` gets one line before and after every payment, swap, claim and launch
  (public identifiers only). Every pending line without a landed line is reconciled from the chain by signature.
- **Sending.** `tx.mjs` is the only module that sends: preflight on, confirm by signature until `lastValidBlockHeight`,
  result is landed / failed / expired, never silence.
- **Phases.** `AGENTS=dry` (now): propose + simulate. `AGENTS=live`: everything above, each agent enabled one at a time
  by the owner funding its wallet. Fund-moving modules (pay, swap, claim, launch) get a second review before `live`.

### 13.2 Agents on the site (owner 2026-10-19: "integrate the agents completely, down to the coin page")

The beta "Agents" page goes; agents become part of the site. Every ROOT launched on Spore has an agent
(§13.1), and the site shows what that agent does with the money it earns: its wallet, every coin it
launched, every fee claim, every payout to the owner and every model call, each on-chain action with
its transaction. The data comes from three places the server already has: the registry (`agents`,
`agent_launches`, `agent_proposals`), the ledger (`DATA_DIR/agents/ledger.jsonl`) and the wallet's
balances. Nothing new is written for the site; the API only reads.

**Who is public.** An agent is served when its root is a Spore launch (`model.isOurCoin`) or when the
owner runs it (status `dry`/`live`); a paused agent of a foreign root is never served anywhere (the
five 2026-10-19 seeds: $GTA, $NTRNDM, $simulator, $DOPE, $VEIL). `isPublicAgent` in `registry.mjs` is
the one rule; `/api/agents/:root` answers 404 for a hidden agent and `/api/agents/coin/:mint` answers
`role: null`. Running agents come first, then by momentum.

**Ledger reader** (`lib/agents-live/ledger.mjs`, `AgentLedger`): tails the ledger incrementally by byte
offset (a `stat` at most once a second per process, then only the new bytes; a partial trailing line
waits for its newline; a shrunken file is read again from the start), keeps the parsed lines per root
in memory (≤ 50 000 per root), counts and skips malformed lines, and folds the lines of one action into
one item: a launch is `pending → sent → step_landed → landed` across its one or two transactions (a
step-2 failure leaves it `step_landed`, "fee split owed", until a `split` item lands); claims, payouts
and swaps group by their signature; a keyed model call is one line; an x402 payment groups by its
`paymentId`. Statuses are folded to `pending | sent | step_landed | landed | failed | expired |
uncertain` for on-chain actions and `done | failed | refused` for model calls. A signature is shown
only when it is base58 (older x402 lines carry base64: `signature: null`, no link). `/api/health
.agents.ledger` reports `{ bytes, lines, bad, roots }`.

**Wallets and balances.** The address is `agents.wallet`, else the vault's wallet for the root (the
$SPORE agent was bound before the column existed; `registry.walletAddress`, cached per root). Balances:
under `AGENTS=live` the orchestrator's last budget read for the root; otherwise `budget.mjs readBudget`
on the api RPC lane, cached 60 s per address (`createAgentBalances` in `api.mjs`); a request waits at
most 1.5 s for a read and serves nulls until the numbers arrive; a failed read keeps the last value
and is not retried before the ttl. `wallet` is null while the agent has no wallet; never a placeholder.

**Status.** The registry row stays `dry` while it runs; the site shows `live` for a running agent when
the server runs live agents (`AGENTS=live`), `dry` in the dry run, `paused` when paused.

**API** (read-only; `max-age=10` + ETag on `/api`, the /v1 cache headers on `/v1`; `/v1` bodies carry
absolute image URLs: root, launched coins, logos):
```ts
type AgentWallet = { address: string; sol: number | null; usdc: number | null; usd: number | null; updatedAt: number | null };
type AgentTotals = { launches: number; launchSol: number; claimsSol: number; claimsUsd: number /* every claim at today's prices */;
  aiUsd: number; aiCalls: number; payoutsSol: number; payoutsUsdc: number; lastActivityAt: number | null };
type LaunchedCoin = { mint: string; name: string | null; symbol: string | null; image: string | null; createdAt: number;
  signature: string | null; why: string | null; logoSource: "image" | "model" | "template" | null };
type ActivityItem = { at: number; kind: "launch" | "claim" | "payout" | "ai" | "swap" | "split";
  status: "pending" | "sent" | "step_landed" | "landed" | "failed" | "expired" | "uncertain" | "done" | "refused";
  title: string /* "Launched $RUMORMILL", "Claimed 0.0549 SOL from $SPREAD", "Claimed 24,000 $SPORE from $CPUFF",
                   "Paid 0.12 SOL + 1.20 USDC to the owner", "Thought with Claude Sonnet 5.5 ($0.013)", "Drew a logo ($0.008)",
                   "Swapped 0.02 SOL for ≈ 1.00 USDC", "Finished the fee split of $X", "Launched $X (fee split owed)" */;
  amountSol: number | null; amountUsdc: number | null; usd: number | null; mint: string | null; symbol: string | null;
  signature: string | null /* base58 only */; explorer: string | null /* https://solscan.io/tx/<signature> */ };
type AgentView = Agent /* §13: root, status "dry" | "live" | "paused", profile, stats, latest */ & {
  model: string; modelLabel: string /* e.g. "anthropic/claude-sonnet-5.5", "Claude Sonnet 5.5" */;
  wallet: AgentWallet | null; totals: AgentTotals; launched: LaunchedCoin[] /* newest first, ≤ 12 */; activity: ActivityItem[] /* newest first, ≤ 8 */ };
type AgentSummary = { address: string | null; status: AgentView["status"]; wallet: AgentWallet | null; totals: AgentTotals; model: string; modelLabel: string };

GET /api/agents            → { mode: "off" | "dry" | "live", agents: AgentView[] }   public agents, running first, then by momentum
GET /api/agents/:root      → { agent: AgentView, proposals: Proposal[] /* ≤ 50 */, activity: ActivityItem[] /* newest first, ≤ 200 */, launched: LaunchedCoin[] /* all */ }
                             400 malformed, 404 "no agent for this coin" (also for a hidden one)
GET /api/agents/coin/:mint → { role: "root" | "child" | null, root: CoinRef | null, agent: AgentSummary | null,
                               launch: { signature, at, why, logoSource, proposalId } | null }   "root": the mint has a public agent;
                             "child": a public agent launched it (`agent_launches`); null otherwise — 200, never 404; 400 malformed
GET /v1/agents, /v1/agents/:root, /v1/agents/coin/:mint → the same bodies with absolute images (documented in /v1/openapi.json)
SSE /api/events            → event: agent (unchanged: { root, proposal })
```
Human titles use the coin tickers from the index (`model.nameOf`), else the ledger's own symbol, else a
short mint; token-quoted claims name the quote (`Claimed 24,000 $SPORE from $CPUFF`) and are valued at
the quote's current USD price; SOL at the indexer's SOL price. `totals.launches` is the larger of the
registry's count (it also knows coins adopted from the index) and the ledger's landed launches.

### 13.3 Owner briefs (owner 2026-10-20: "the $HUMAN agent launches the world's famous people")

A brief is a standing instruction the owner gives one root's agent. Stored in
`DATA_DIR/agents/briefs.json` (`{ "<rootMint>": { text, mode: "people" | "free", setAt } }`, mode 600,
atomic writes), set only with `server/scripts/agent-brief.mjs set <root> "<text>" | --file <path|-> [--mode people]
| get <root> | clear <root> | list` (`DATA_DIR` / `--data`); text ≤ 1 200 characters of plain text, no
links or markup. The runner re-reads the file whenever it changes (stat per run), so a brief applies on
the agent's next run without a restart. Code: `lib/agents/brief.mjs`, `lib/agents/people.mjs`.

- **Prompt**: the brief goes first, as the governing instruction ("THE OWNER'S BRIEF — follow it exactly;
  it overrides the themes"); the system line says so too.
- **Filters** for a briefed root: the biggest-coins ticker filter and the near-the-root's-ticker filter
  do not apply (the owner allows any ticker); a child's ticker or name, a duplicate in the batch and the
  agent's own recent proposals are still refused. Rubric: uniqueness neutral, fit = the rank the model
  (or the fallback list) gave the idea.
- **Mode `people`**: each coin is one famous real person — name = full name ("Elon Musk"), ticker = the
  name they go by (`ELON`), description = one punchy line on why this human matters, the hype line about
  the person. The prompt lists every person already under the root (`takenPeople`, ≤ 400) and forbids
  slurs, sexual content, claims about private lives, implying endorsement, private individuals and
  minors. Real names pass the people filter; brands stay out of the name and ticker; people known for
  atrocities, terrorism or serial/sexual crimes never pass (`PEOPLE_NEVER`); a person already launched or
  proposed under the root is refused by ticker, name and person key (first + last name, initials and
  suffixes dropped). Fallback: ~350 famous people in fame order with a seeded jitter, minus the ones
  taken. Logo: the image model is asked for "a bold meme-style caricature portrait of <name>, head and
  shoulders, flat vivid colours, no text, no logo"; a refusal falls back to the SVG/template path. The
  metadata description ends with the purpose line and "Unofficial fan tribute, not affiliated with or
  endorsed by <name>."
- **API**: `Agent.brief` = `{ mode, setAt }` or null (the text stays on the server).
