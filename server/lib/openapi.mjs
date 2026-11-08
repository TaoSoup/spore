// OpenAPI 3.1 description of the partner API (DESIGN §12), written by hand so it says exactly what
// lib/v1.mjs serves; test/v1.test.mjs checks that every route is listed and every $ref resolves.
// Examples are trimmed real responses ($SPORE and its tree, captured 2026-10-19; the agents ones from a
// local instance with the $SPORE agent and a seeded ledger the same day; status/mode as on the live server).

const SPORE = "HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY";
const nullable = (schema) => ({ ...schema, type: [schema.type, "null"] });
const ref = (name) => ({ $ref: `#/components/schemas/${name}` });
const arr = (items) => ({ type: "array", items });
const str = (description, extra = {}) => ({ type: "string", description, ...extra });
const int = (description, extra = {}) => ({ type: "integer", description, ...extra });
const num = (description) => ({ type: "number", description });
const bool = (description) => ({ type: "boolean", description });
const obj = (properties, description) => ({ type: "object", ...(description ? { description } : {}), required: Object.keys(properties), properties });
const json = (schema, example) => ({ "application/json": { schema, ...(example !== undefined ? { example } : {}) } });

const RATE_HEADERS = {
  "X-RateLimit-Limit": { $ref: "#/components/headers/X-RateLimit-Limit" },
  "X-RateLimit-Remaining": { $ref: "#/components/headers/X-RateLimit-Remaining" },
  "X-RateLimit-Reset": { $ref: "#/components/headers/X-RateLimit-Reset" },
  "X-Spore-Tier": { $ref: "#/components/headers/X-Spore-Tier" },
};
const CACHED_HEADERS = { ...RATE_HEADERS, ETag: { $ref: "#/components/headers/ETag" }, "Cache-Control": { $ref: "#/components/headers/Cache-Control" } };
const errors = (...codes) => Object.fromEntries(codes.map((c) => [String(c), { $ref: `#/components/responses/${{ 304: "NotModified", 400: "BadRequest", 401: "Unauthorized", 404: "NotFound", 429: "TooManyRequests", 503: "Unavailable" }[c]}` }]));

// ---------------------------------------------------------------- examples (trimmed real data)
const EX_FAMILY = {"mint":"HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY","name":"Spore","symbol":"SPORE","image":"https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2Fdfafb1ba6262c6d6f01a31dcce4dd3b46ddabc19daf008110006ef30defeb474.png","depth":0,"quoteMint":null,"quoteSymbol":"SOL","root":{"mint":"HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY","name":"Spore","symbol":"SPORE","image":"https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2Fdfafb1ba6262c6d6f01a31dcce4dd3b46ddabc19daf008110006ef30defeb474.png","depth":0},"parent":null,"ancestors":[],"children":{"count":6,"top":[{"mint":"g5UfZL466SmoeJ7adavqTSENvkWFJMrFqPSDdpgFhGi","name":"Hyphae","symbol":"HYPHAE","image":null,"depth":1,"mcapUsd":4574.37,"lockedUsd":0.11},{"mint":"9wov7fiErh5mxEuK8uR7sd2Q9HBh3mb14kh9mopbYXgP","name":"SPOREINU","symbol":"SPOREINU","image":null,"depth":1,"mcapUsd":4650.24,"lockedUsd":0}]},"descendants":8,"lockedUsd":1558.42,"mcapUsd":79983.38,"change24h":323.05,"trades1h":15,"launchedOnSpore":false,"links":{"spore":"https://sporepad.com/c/HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY","launchUnder":"https://sporepad.com/launch?parent=HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY","embed":"https://sporepad.com/embed/tree/HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY"}};
const EX_TREE = {"root":{"mint":"HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY","name":"Spore","symbol":"SPORE","image":"https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2Fdfafb1ba6262c6d6f01a31dcce4dd3b46ddabc19daf008110006ef30defeb474.png","depth":0},"nodes":[{"mint":"HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY","name":"Spore","symbol":"SPORE","image":"https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2Fdfafb1ba6262c6d6f01a31dcce4dd3b46ddabc19daf008110006ef30defeb474.png","depth":0,"ours":false,"oursPending":false,"mcapUsd":79983.38,"lockedUsd":1558.42,"children":6,"descendants":8,"otherChildren":0,"migrated":true,"createdAt":null,"parentMint":null},{"mint":"g5UfZL466SmoeJ7adavqTSENvkWFJMrFqPSDdpgFhGi","name":"Hyphae","symbol":"HYPHAE","image":null,"depth":1,"ours":true,"oursPending":false,"mcapUsd":4574.37,"lockedUsd":0.11,"children":1,"descendants":1,"otherChildren":0,"migrated":false,"createdAt":1792375893,"parentMint":"HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY"}],"total":9};
const EX_MAP = {"roots":[{"coin":{"mint":"HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY","name":"Spore","symbol":"SPORE","image":"https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2Fdfafb1ba6262c6d6f01a31dcce4dd3b46ddabc19daf008110006ef30defeb474.png","depth":0,"ours":false,"oursPending":false,"mcapUsd":79983.38,"lockedUsd":1558.42,"children":6,"descendants":8,"otherChildren":0,"migrated":true,"createdAt":null},"children":[{"coin":{"mint":"g5UfZL466SmoeJ7adavqTSENvkWFJMrFqPSDdpgFhGi","name":"Hyphae","symbol":"HYPHAE","image":null,"depth":1,"ours":true,"oursPending":false,"mcapUsd":4574.37,"lockedUsd":0.11,"children":1,"descendants":1,"otherChildren":0,"migrated":false,"createdAt":1792375893},"children":[]}]}],"scope":"all","version":2519,"generatedAt":1792409685899,"total":16256};
const EX_DELTA = {"nodes":[{"mint":"BsbsB3WLq7vbY5En3MBCAsTrcwaCxNKY2Mp5pGuLpump","name":"GTA memes","symbol":"GTA","image":"https://sporepad.com/api/img?u=https%3A%2F%2Fipfs.io%2Fipfs%2Fbafkreihskz4lasserwwxvnm2x5cujfps76ifn75pcynczxiwns74ty677u","depth":0,"ours":false,"oursPending":false,"mcapUsd":1267486.24,"lockedUsd":47452.91,"children":104,"descendants":105,"otherChildren":0,"migrated":true,"createdAt":null,"parentMint":null}],"removed":[],"generatedAt":1792409686164,"total":16256,"version":2523};
const EX_HEAT = {"at":1792409686,"since":1792323286,"mint":["9tti2o8c7eBABVBfQ9xMAuHrppyKSycKvaewz3R6qJV1","4df1q5JNKYK7XjxHKsnwdenpjBgxAgfCXed7YFNHpump"],"t1h":[2030,1213],"n24":[2030,1213],"v24":[77474.05,54986.48],"last":[1792409655,1792409685],"buys1h":[1103,754]};

const EX_AGENTS = {"mode":"live","agents":[{"root":{"mint":"HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY","name":"Spore","symbol":"SPORE","image":"https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2Fdfafb1ba6262c6d6f01a31dcce4dd3b46ddabc19daf008110006ef30defeb474.png","depth":0},"status":"live","profile":{"summary":"$SPORE (Spore): A Pump.fun launchpad for connected coin trees. Its children riff on spore, launchpad, connected.","themes":["spore","launchpad","connected","trees","root","connect"],"tone":"organic, curious, grow-together","avoid":["real people's names","brand names and trademarks","slurs or hateful language","price promises or financial advice","clones of $SPORE"],"palette":["#e1ff5c","#2f8f34","#0b1a0e"],"source":"fallback","builtAt":1792452457},"stats":{"runs":1,"proposals":1,"lastRunAt":1792452457,"nextRunAt":1792452757,"score":39,"scoreReason":"momentum 39/100: 10 children, no trades in the last hour, 2000 trades and $85.4K volume in 24 h, last proposal 2 min ago"},"latest":{"id":"f106eba20605f294","createdAt":1792452457,"name":"Launchpad Puff","symbol":"LPUFF","description":"Launchpad Puff carries the root spirit of $SPORE into a new branch of the tree.","image":"https://sporepad.com/api/agents/img/f106eba20605f294.png","score":44,"reason":"momentum 44/100: 10 children, no trades in the last hour, 2000 trades and $85.4K volume in 24 h, never proposed; picked $LPUFF (theme fit 1, brevity 0.94, uniqueness 1) over 5 runners-up","sim":{"ok":true,"bytes":889,"unitsConsumed":160686,"estCostSol":0.01479732,"err":null},"source":"fallback","why":null,"logoSource":null,"runnersUp":[{"name":"Lil Trees","symbol":"LILTREES"},{"name":"Snore Connect","symbol":"SCONNECT"},{"name":"Connected Bloom","symbol":"CBLOOM"},{"name":"Wild Bloom","symbol":"WILDBLOOM"},{"name":"Roopha","symbol":"ROOPHA"}],"status":"proposed","rejectedReason":null},"model":"anthropic/claude-sonnet-5.5","modelLabel":"Claude Sonnet 5.5","wallet":{"address":"FoUH2Pc9VAVpDLhTRNdrJCFHgnrs554SbRgiJCZepmV4","sol":0,"usdc":0,"usd":0,"updatedAt":1792452552},"totals":{"launches":5,"launchSol":0.075,"claimsSol":0.112505,"claimsUsd":13.8779,"aiUsd":0.1028,"aiCalls":11,"payoutsSol":0.12,"payoutsUsdc":1.2,"lastActivityAt":1792448344},"launched":[{"mint":"6SroafzVJgbqwbhT93x2gsqTfWqXfz5ig7QZ1YMmBJom","name":"Treesling","symbol":"TREESLING","image":"https://sporepad.com/api/agents/img/104b05418bb1a424.png","createdAt":1792448115,"signature":"2Hrqp57Q99jGaV8nYg4qLwu5cbXCmoks6ukd9vNbw9sbRrQYHoEnpomnvuFyZt12GNfxrT59KgxhQpvwbD1hY2jZ","why":"A sapling with ambitions; launched on a tick, not a whim.","logoSource":"model"},{"mint":"691kMq8MFLPcmcPkmzehfss1vhRwUmCYuXVxohuTNU4m","name":"Rootkin","symbol":"ROOTKIN","image":"https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2F810d3708192b866e1934866df8cf195dd3d151370710c397cc04b074caaef13f.png","createdAt":1792447395,"signature":"wVpMu7Dcvnvx8KpjzzNny4EvRdbJo6mY73vaA9GSrMnUzjkVPxKA8HsiyaoN5Nv4tc4MNKd3DopxoTprqmcysgy","why":"Every spore has kin; this is the one that stayed near the root.","logoSource":"image"}],"sleeping":null,"reason":null,"owedUsd":null,"brief":null,"activity":[{"at":1792448341,"kind":"claim","status":"landed","title":"Claimed 24,000 $SPORE from $TREESLING","amountSol":null,"amountUsdc":null,"usd":0.4105,"mint":"6SroafzVJgbqwbhT93x2gsqTfWqXfz5ig7QZ1YMmBJom","symbol":"TREESLING","signature":"u9QVt9Ft3ydwgtrpKLUMJcr6wnjF8giQKUS2t8oDqervjwGCvNBVaGymDHCSvC2rWfqJtrKM5UAAKce7PPemEvo","explorer":"https://solscan.io/tx/u9QVt9Ft3ydwgtrpKLUMJcr6wnjF8giQKUS2t8oDqervjwGCvNBVaGymDHCSvC2rWfqJtrKM5UAAKce7PPemEvo"},{"at":1792448281,"kind":"claim","status":"landed","title":"Claimed 0.0229 SOL from $SPORE","amountSol":0.022921,"amountUsdc":null,"usd":2.4092,"mint":"HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY","symbol":"SPORE","signature":"3wwWTtUv32NNFy1K4gdEtANZ6usRf6fSb6HYn1x6Tiuq817XvMyCCZW7Fm2DGmiNnNj8BRXnq4M1mxdivQsmuWkk","explorer":"https://solscan.io/tx/3wwWTtUv32NNFy1K4gdEtANZ6usRf6fSb6HYn1x6Tiuq817XvMyCCZW7Fm2DGmiNnNj8BRXnq4M1mxdivQsmuWkk"},{"at":1792448110,"kind":"launch","status":"landed","title":"Launched $TREESLING","amountSol":0.0152,"amountUsdc":null,"usd":1.5977,"mint":"6SroafzVJgbqwbhT93x2gsqTfWqXfz5ig7QZ1YMmBJom","symbol":"TREESLING","signature":"2Hrqp57Q99jGaV8nYg4qLwu5cbXCmoks6ukd9vNbw9sbRrQYHoEnpomnvuFyZt12GNfxrT59KgxhQpvwbD1hY2jZ","explorer":"https://solscan.io/tx/2Hrqp57Q99jGaV8nYg4qLwu5cbXCmoks6ukd9vNbw9sbRrQYHoEnpomnvuFyZt12GNfxrT59KgxhQpvwbD1hY2jZ"},{"at":1792448105,"kind":"ai","status":"done","title":"Drew a logo ($0.008)","amountSol":null,"amountUsdc":null,"usd":0.008,"mint":null,"symbol":null,"signature":null,"explorer":null}]}]};
const EX_AGENT = {"agent":{"root":{"mint":"HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY","name":"Spore","symbol":"SPORE","image":"https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2Fdfafb1ba6262c6d6f01a31dcce4dd3b46ddabc19daf008110006ef30defeb474.png","depth":0},"status":"live","profile":{"summary":"$SPORE (Spore): A Pump.fun launchpad for connected coin trees. Its children riff on spore, launchpad, connected.","themes":["spore","launchpad","connected","trees","root","connect"],"tone":"organic, curious, grow-together","avoid":["real people's names","brand names and trademarks","slurs or hateful language","price promises or financial advice","clones of $SPORE"],"palette":["#e1ff5c","#2f8f34","#0b1a0e"],"source":"fallback","builtAt":1792452457},"stats":{"runs":1,"proposals":1,"lastRunAt":1792452457,"nextRunAt":1792452757,"score":39,"scoreReason":"momentum 39/100: 10 children, no trades in the last hour, 2000 trades and $85.4K volume in 24 h, last proposal 2 min ago"},"latest":{"id":"f106eba20605f294","createdAt":1792452457,"name":"Launchpad Puff","symbol":"LPUFF","description":"Launchpad Puff carries the root spirit of $SPORE into a new branch of the tree.","image":"https://sporepad.com/api/agents/img/f106eba20605f294.png","score":44,"reason":"momentum 44/100: 10 children, no trades in the last hour, 2000 trades and $85.4K volume in 24 h, never proposed; picked $LPUFF (theme fit 1, brevity 0.94, uniqueness 1) over 5 runners-up","sim":{"ok":true,"bytes":889,"unitsConsumed":160686,"estCostSol":0.01479732,"err":null},"source":"fallback","why":null,"logoSource":null,"runnersUp":[{"name":"Lil Trees","symbol":"LILTREES"},{"name":"Snore Connect","symbol":"SCONNECT"},{"name":"Connected Bloom","symbol":"CBLOOM"},{"name":"Wild Bloom","symbol":"WILDBLOOM"},{"name":"Roopha","symbol":"ROOPHA"}],"status":"proposed","rejectedReason":null},"model":"anthropic/claude-sonnet-5.5","modelLabel":"Claude Sonnet 5.5","wallet":{"address":"FoUH2Pc9VAVpDLhTRNdrJCFHgnrs554SbRgiJCZepmV4","sol":0,"usdc":0,"usd":0,"updatedAt":1792452552},"totals":{"launches":5,"launchSol":0.075,"claimsSol":0.112505,"claimsUsd":13.8779,"aiUsd":0.1028,"aiCalls":11,"payoutsSol":0.12,"payoutsUsdc":1.2,"lastActivityAt":1792448344},"launched":[{"mint":"6SroafzVJgbqwbhT93x2gsqTfWqXfz5ig7QZ1YMmBJom","name":"Treesling","symbol":"TREESLING","image":"https://sporepad.com/api/agents/img/104b05418bb1a424.png","createdAt":1792448115,"signature":"2Hrqp57Q99jGaV8nYg4qLwu5cbXCmoks6ukd9vNbw9sbRrQYHoEnpomnvuFyZt12GNfxrT59KgxhQpvwbD1hY2jZ","why":"A sapling with ambitions; launched on a tick, not a whim.","logoSource":"model"},{"mint":"691kMq8MFLPcmcPkmzehfss1vhRwUmCYuXVxohuTNU4m","name":"Rootkin","symbol":"ROOTKIN","image":"https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2F810d3708192b866e1934866df8cf195dd3d151370710c397cc04b074caaef13f.png","createdAt":1792447395,"signature":"wVpMu7Dcvnvx8KpjzzNny4EvRdbJo6mY73vaA9GSrMnUzjkVPxKA8HsiyaoN5Nv4tc4MNKd3DopxoTprqmcysgy","why":"Every spore has kin; this is the one that stayed near the root.","logoSource":"image"}],"sleeping":null,"reason":null,"owedUsd":null,"brief":null,"activity":[{"at":1792448341,"kind":"claim","status":"landed","title":"Claimed 24,000 $SPORE from $TREESLING","amountSol":null,"amountUsdc":null,"usd":0.4105,"mint":"6SroafzVJgbqwbhT93x2gsqTfWqXfz5ig7QZ1YMmBJom","symbol":"TREESLING","signature":"u9QVt9Ft3ydwgtrpKLUMJcr6wnjF8giQKUS2t8oDqervjwGCvNBVaGymDHCSvC2rWfqJtrKM5UAAKce7PPemEvo","explorer":"https://solscan.io/tx/u9QVt9Ft3ydwgtrpKLUMJcr6wnjF8giQKUS2t8oDqervjwGCvNBVaGymDHCSvC2rWfqJtrKM5UAAKce7PPemEvo"},{"at":1792448281,"kind":"claim","status":"landed","title":"Claimed 0.0229 SOL from $SPORE","amountSol":0.022921,"amountUsdc":null,"usd":2.4092,"mint":"HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY","symbol":"SPORE","signature":"3wwWTtUv32NNFy1K4gdEtANZ6usRf6fSb6HYn1x6Tiuq817XvMyCCZW7Fm2DGmiNnNj8BRXnq4M1mxdivQsmuWkk","explorer":"https://solscan.io/tx/3wwWTtUv32NNFy1K4gdEtANZ6usRf6fSb6HYn1x6Tiuq817XvMyCCZW7Fm2DGmiNnNj8BRXnq4M1mxdivQsmuWkk"},{"at":1792448110,"kind":"launch","status":"landed","title":"Launched $TREESLING","amountSol":0.0152,"amountUsdc":null,"usd":1.5977,"mint":"6SroafzVJgbqwbhT93x2gsqTfWqXfz5ig7QZ1YMmBJom","symbol":"TREESLING","signature":"2Hrqp57Q99jGaV8nYg4qLwu5cbXCmoks6ukd9vNbw9sbRrQYHoEnpomnvuFyZt12GNfxrT59KgxhQpvwbD1hY2jZ","explorer":"https://solscan.io/tx/2Hrqp57Q99jGaV8nYg4qLwu5cbXCmoks6ukd9vNbw9sbRrQYHoEnpomnvuFyZt12GNfxrT59KgxhQpvwbD1hY2jZ"},{"at":1792448105,"kind":"ai","status":"done","title":"Drew a logo ($0.008)","amountSol":null,"amountUsdc":null,"usd":0.008,"mint":null,"symbol":null,"signature":null,"explorer":null}]},"proposals":[{"id":"f106eba20605f294","createdAt":1792452457,"name":"Launchpad Puff","symbol":"LPUFF","description":"Launchpad Puff carries the root spirit of $SPORE into a new branch of the tree.","image":"https://sporepad.com/api/agents/img/f106eba20605f294.png","score":44,"reason":"momentum 44/100: 10 children, no trades in the last hour, 2000 trades and $85.4K volume in 24 h, never proposed; picked $LPUFF (theme fit 1, brevity 0.94, uniqueness 1) over 5 runners-up","sim":{"ok":true,"bytes":889,"unitsConsumed":160686,"estCostSol":0.01479732,"err":null},"source":"fallback","why":null,"logoSource":null,"runnersUp":[{"name":"Lil Trees","symbol":"LILTREES"},{"name":"Snore Connect","symbol":"SCONNECT"},{"name":"Connected Bloom","symbol":"CBLOOM"},{"name":"Wild Bloom","symbol":"WILDBLOOM"},{"name":"Roopha","symbol":"ROOPHA"}],"status":"proposed","rejectedReason":null}],"activity":[{"at":1792448341,"kind":"claim","status":"landed","title":"Claimed 24,000 $SPORE from $TREESLING","amountSol":null,"amountUsdc":null,"usd":0.4105,"mint":"6SroafzVJgbqwbhT93x2gsqTfWqXfz5ig7QZ1YMmBJom","symbol":"TREESLING","signature":"u9QVt9Ft3ydwgtrpKLUMJcr6wnjF8giQKUS2t8oDqervjwGCvNBVaGymDHCSvC2rWfqJtrKM5UAAKce7PPemEvo","explorer":"https://solscan.io/tx/u9QVt9Ft3ydwgtrpKLUMJcr6wnjF8giQKUS2t8oDqervjwGCvNBVaGymDHCSvC2rWfqJtrKM5UAAKce7PPemEvo"},{"at":1792448281,"kind":"claim","status":"landed","title":"Claimed 0.0229 SOL from $SPORE","amountSol":0.022921,"amountUsdc":null,"usd":2.4092,"mint":"HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY","symbol":"SPORE","signature":"3wwWTtUv32NNFy1K4gdEtANZ6usRf6fSb6HYn1x6Tiuq817XvMyCCZW7Fm2DGmiNnNj8BRXnq4M1mxdivQsmuWkk","explorer":"https://solscan.io/tx/3wwWTtUv32NNFy1K4gdEtANZ6usRf6fSb6HYn1x6Tiuq817XvMyCCZW7Fm2DGmiNnNj8BRXnq4M1mxdivQsmuWkk"},{"at":1792448110,"kind":"launch","status":"landed","title":"Launched $TREESLING","amountSol":0.0152,"amountUsdc":null,"usd":1.5977,"mint":"6SroafzVJgbqwbhT93x2gsqTfWqXfz5ig7QZ1YMmBJom","symbol":"TREESLING","signature":"2Hrqp57Q99jGaV8nYg4qLwu5cbXCmoks6ukd9vNbw9sbRrQYHoEnpomnvuFyZt12GNfxrT59KgxhQpvwbD1hY2jZ","explorer":"https://solscan.io/tx/2Hrqp57Q99jGaV8nYg4qLwu5cbXCmoks6ukd9vNbw9sbRrQYHoEnpomnvuFyZt12GNfxrT59KgxhQpvwbD1hY2jZ"},{"at":1792448105,"kind":"ai","status":"done","title":"Drew a logo ($0.008)","amountSol":null,"amountUsdc":null,"usd":0.008,"mint":null,"symbol":null,"signature":null,"explorer":null},{"at":1792448101,"kind":"ai","status":"done","title":"Thought with Claude Sonnet 5.5 ($0.01)","amountSol":null,"amountUsdc":null,"usd":0.00996,"mint":null,"symbol":null,"signature":null,"explorer":null}],"launched":[{"mint":"6SroafzVJgbqwbhT93x2gsqTfWqXfz5ig7QZ1YMmBJom","name":"Treesling","symbol":"TREESLING","image":"https://sporepad.com/api/agents/img/104b05418bb1a424.png","createdAt":1792448115,"signature":"2Hrqp57Q99jGaV8nYg4qLwu5cbXCmoks6ukd9vNbw9sbRrQYHoEnpomnvuFyZt12GNfxrT59KgxhQpvwbD1hY2jZ","why":"A sapling with ambitions; launched on a tick, not a whim.","logoSource":"model"},{"mint":"691kMq8MFLPcmcPkmzehfss1vhRwUmCYuXVxohuTNU4m","name":"Rootkin","symbol":"ROOTKIN","image":"https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2F810d3708192b866e1934866df8cf195dd3d151370710c397cc04b074caaef13f.png","createdAt":1792447395,"signature":"wVpMu7Dcvnvx8KpjzzNny4EvRdbJo6mY73vaA9GSrMnUzjkVPxKA8HsiyaoN5Nv4tc4MNKd3DopxoTprqmcysgy","why":"Every spore has kin; this is the one that stayed near the root.","logoSource":"image"}]};
const EX_AGENT_COIN = {"role":"child","root":{"mint":"HfzNFxar7oggDCHnK2ekkygDsLNuCGh3dXdRQS3wJTJY","name":"Spore","symbol":"SPORE","image":"https://sporepad.com/api/img?u=https%3A%2F%2Fspore-2x6.pages.dev%2Fm%2Fdfafb1ba6262c6d6f01a31dcce4dd3b46ddabc19daf008110006ef30defeb474.png","depth":0},"agent":{"address":"FoUH2Pc9VAVpDLhTRNdrJCFHgnrs554SbRgiJCZepmV4","status":"live","wallet":{"address":"FoUH2Pc9VAVpDLhTRNdrJCFHgnrs554SbRgiJCZepmV4","sol":0,"usdc":0,"usd":0,"updatedAt":1792452552},"totals":{"launches":5,"launchSol":0.075,"claimsSol":0.112505,"claimsUsd":13.8779,"aiUsd":0.1028,"aiCalls":11,"payoutsSol":0.12,"payoutsUsdc":1.2,"lastActivityAt":1792448344},"model":"anthropic/claude-sonnet-5.5","modelLabel":"Claude Sonnet 5.5"},"launch":{"signature":"2DwjugXhZjV81xdQYDqLekn143MHgXWHH9aRF6xgMDVwbcRxMfdczw9ZYifZWNGndx5FaifHL6r8hodA3TeQ4Gq1","at":1792446735,"why":"What the root wore before the trees showed up.","logoSource":"model","proposalId":"1ef628e924815495"}};

// ---------------------------------------------------------------- schemas
const CoinRef = obj({
  mint: str("Token mint (base58)."), name: nullable(str("On-chain name.")), symbol: nullable(str("On-chain ticker.")),
  image: nullable(str("Absolute URL of the logo through Spore's image proxy.", { format: "uri" })), depth: int("0 = root (quoted in SOL, USDC or another listed mint); n = quoted in a depth n−1 pump coin.", { minimum: 0 }),
}, "A coin, as small as a reference gets.");
const MapCoin = {
  type: "object", description: "CoinRef plus what a map bubble draws.",
  allOf: [ref("CoinRef"), obj({
    ours: bool("Launched on Spore (its fee-sharing config pays the Spore platform its share)."),
    oursPending: bool("Launched on Spore minutes ago; the fee-sharing config is not confirmed yet."),
    mcapUsd: nullable(num("Market cap in USD (price × total supply); null when the chain cannot be priced.")),
    lockedUsd: nullable(num("USD value of this coin's tokens held by its children's curves and pools.")),
    children: int("Direct children (coins quoted in this coin)."), descendants: int("All coins below this one."),
    otherChildren: int("Always 0 on /v1 (every child is included)."), migrated: bool("Graduated to a PumpSwap pool."),
    createdAt: nullable(int("Creation time (unix s), null when unknown.")),
  }), { type: "object", properties: {
    mcapCapUsd: num("Present only when the market cap exceeds LIQ_X (50) times the quote liquidity behind the price: that cap (USD), which the map sizes the coin by instead of mcapUsd."),
    asset: bool("Present (true) on a listed quote asset drawn as a family top (USDC, PUMP, a tokenized stock); its own market cap does not count toward the map size."),
  } }],
};
const MapCoinFlat = { allOf: [ref("MapCoin"), obj({ parentMint: nullable(str("Parent coin's mint; null for a root.")) })] };
const MapNode = obj({ coin: ref("MapCoin"), children: arr(ref("MapNode")) }, "A map node and its subtree.");
const Family = obj({
  mint: str("Token mint."), name: nullable(str("On-chain name.")), symbol: nullable(str("On-chain ticker.")), image: nullable(str("Absolute logo URL.", { format: "uri" })),
  depth: int("Depth in its family tree (0 = root).", { minimum: 0 }),
  quoteMint: nullable(str("Mint the coin is quoted in; null = SOL.")), quoteSymbol: str("SOL, USDC, the parent's ticker or a short mint."),
  root: ref("CoinRef"), parent: { oneOf: [ref("CoinRef"), { type: "null" }] }, ancestors: { ...arr(ref("CoinRef")), description: "Nearest first: parent, grandparent, …, root." },
  children: obj({ count: int("Direct children."), top: { ...arr(ref("FamilyChild")), maxItems: 20, description: "Up to 20 children, most locked value first." } }),
  descendants: int("All coins below this one."), lockedUsd: nullable(num("USD value of this coin's tokens locked by its children.")), mcapUsd: nullable(num("Market cap in USD.")),
  change24h: nullable(num("Price change over 24 h in percent (12.5 = +12.5 %), USD when both prices are known, else in quote units; null without recorded trades.")),
  trades1h: int("Trades in the last hour."), launchedOnSpore: bool("Launched on Spore."),
  links: obj({ spore: str("Coin page on Spore.", { format: "uri" }), launchUnder: str("Launch a child of this coin on Spore.", { format: "uri" }), embed: str("Embeddable family-tree widget.", { format: "uri" }) }),
}, "A coin's family: where it sits in its tree and what grows under it.");
const FamilyChild = { allOf: [ref("CoinRef"), obj({ mcapUsd: nullable(num("Market cap in USD.")), lockedUsd: nullable(num("USD value locked by its own children.")) })] };
const Tree = obj({ root: ref("CoinRef"), nodes: { ...arr(ref("MapCoinFlat")), description: "The root first, then breadth-first, siblings by locked value." }, total: int("Number of nodes.") }, "The whole family tree containing the coin, from its root.");
const MapFull = obj({ roots: arr(ref("MapNode")), scope: { type: "string", enum: ["all"] }, version: int("Index version the map was built at."), generatedAt: int("Build time (unix ms): pass it as `since` next time."), total: int("Nodes in the full map.") }, "Every root with a child and every descendant (the whole pump.fun custom-pair ecosystem).");
const MapDelta = obj({ nodes: arr(ref("MapCoinFlat")), removed: { ...arr({ type: "string" }), description: "Reserved; coins are never removed." }, generatedAt: int("Build time (unix ms)."), total: int("Nodes in the full map (tells a stale cache from a complete one)."), version: int("Index version.") }, "Nodes whose numbers or labels changed after `since`.");
const Heat = obj({
  at: int("Computed at (unix s)."), since: int("at − 86400."),
  mint: arr({ type: "string" }), t1h: arr({ type: "integer" }), n24: arr({ type: "integer" }), v24: { ...arr({ type: "number" }), description: "USD volume over 24 h, rounded to cents." },
  last: { ...arr({ type: "integer" }), description: "Unix s of the last trade." }, buys1h: arr({ type: "integer" }),
}, "Trade activity as parallel arrays (index i describes mint[i]): every coin traded in 24 h, most trades in the last hour first.");
const HeatRow = obj({ mint: str("Token mint."), at: int("Unix s."), t1h: int("Trades in the last hour."), n24: int("Trades in 24 h."), v24: num("USD volume in 24 h."), last: int("Unix s of the last trade."), buys1h: int("Buys in the last hour.") }, "`heat` stream event: one coin's activity row after one of its trades.");
const Trade = obj({
  sig: str("Transaction signature."), mint: str("Coin traded."), slot: int("Slot."), time: int("Unix s."), isBuy: bool("Buy (true) or sell."), user: str("Trader wallet."),
  baseAmount: str("Coin amount, raw units (6 decimals)."), quoteAmount: str("Quote amount, raw units of the coin's quote mint."),
  priceQuote: num("Price in quote per token."), priceUsd: nullable(num("Price in USD.")), valueUsd: nullable(num("Trade value in USD.")),
}, "`trade` stream event.");
const PairEvent = obj({ coin: ref("MapCoinFlat"), parent: ref("MapCoinFlat") }, "`pair` stream event: a new coin was launched under a known parent.");
const MapDeltaEvent = obj({ at: int("Unix ms."), updated: arr(obj({ mint: str("Mint."), mcapUsd: nullable(num("USD.")), lockedUsd: nullable(num("USD.")), children: int("Direct children."), descendants: int("All coins below."), migrated: bool("Graduated."), name: nullable(str("Name.")), symbol: nullable(str("Ticker.")), image: nullable(str("Absolute logo URL.")) })) }, "`mapdelta` stream event: numbers that moved, at most every 3 s.");
const Stats = { type: "object", description: "`stats` stream event: Spore's headline counters (Spore launches only).", properties: { coins: int("Coins."), roots: int("Roots."), byDepth: arr({ type: "integer" }), lockedUsd: num("USD."), volume24hUsd: num("USD."), solUsd: nullable(num("SOL/USD.")), maxDepth: int("Program depth cap."), updatedAt: int("Unix s."), mode: { type: "string" }, ourCoins: int("Spore launches."), otherChildren: int("Other pump.fun children.") } };
const AgentProfile = obj({
  summary: str("What the root and its community are about (at most 280 characters)."), themes: { ...arr({ type: "string" }), minItems: 3, maxItems: 8, description: "Short keywords new coins play on." },
  tone: str("The voice of the community."), avoid: arr({ type: "string" }), palette: { ...arr({ type: "string", pattern: "^#[0-9a-f]{6}$" }), minItems: 2, maxItems: 3, description: "Logo colours." },
  source: { type: "string", enum: ["model", "fallback"], description: "Written by the language model, or by the deterministic fallback." }, builtAt: int("Unix s."),
}, "An agent's understanding of its root coin.");
const Proposal = obj({
  id: str("Proposal id (16 hex)."), createdAt: int("Unix s."), name: str("Proposed coin name (≤ 32)."), symbol: str("Proposed ticker (≤ 10, A-Z0-9)."), description: str("Proposed description (≤ 280)."),
  image: nullable(str("Absolute URL of the generated 512×512 PNG logo.", { format: "uri" })), score: int("Momentum score of the root (0-100) when the proposal was made."), reason: str("Why the agent proposed now and why this idea."),
  sim: obj({ ok: bool("The simulated launch transaction succeeded."), bytes: nullable(int("Size of the launch transaction (first one when the launch takes two).")), unitsConsumed: nullable(int("Compute units the simulation used.")), estCostSol: nullable(num("Estimated SOL the launch would cost (rent, launch fee, network fee).")), err: nullable(str("Why the simulation failed.")) }, "The dry run of the launch: built exactly as it would be sent, simulated, never signed or sent."),
  source: { type: "string", enum: ["model", "fallback"] },
  why: { type: "string", nullable: true, description: "The agent's one-line reason for this coin right now (the hype line); null for template ideas." },
  logoSource: { type: "string", nullable: true, enum: ["image", "model", "template", null], description: "Where the logo came from." },
  runnersUp: arr(obj({ name: str("Name."), symbol: str("Ticker.") })),
  status: { type: "string", enum: ["proposed", "rejected"], description: "`rejected` when the simulation failed." }, rejectedReason: nullable(str("Why it was rejected.")),
}, "A coin an agent would launch under its root (dry run: nothing is launched).");
const AgentWallet = obj({
  address: str("The agent's own Solana wallet (base58); its creator-fee share and its launches' costs flow through it."),
  sol: nullable(num("SOL balance.")), usdc: nullable(num("USDC balance.")), usd: nullable(num("SOL + USDC in USD at the indexer's SOL price.")),
  updatedAt: nullable(int("Unix s of the balance read; balances are null until the first read.")),
}, "An agent's wallet.");
const AgentTotals = obj({
  launches: int("Coins the agent launched under its root."), launchSol: num("SOL its launches cost (rent + network fees)."),
  claimsSol: num("SOL it claimed from creator fees."), claimsUsd: num("USD value of every claim it made (SOL and token-quoted), at today's prices."),
  aiUsd: num("Estimated USD its model calls cost (text and logos)."), aiCalls: int("Model calls so far."),
  payoutsSol: num("SOL it paid to the owner."), payoutsUsdc: num("USDC it paid to the owner."), lastActivityAt: nullable(int("Unix s of its last ledger line.")),
}, "Lifetime totals from the agent's ledger.");
const LaunchedCoin = obj({
  mint: str("Mint."), name: nullable(str("Name.")), symbol: nullable(str("Ticker.")), image: nullable(str("Absolute logo URL.", { format: "uri" })),
  createdAt: int("Unix s of the launch."), signature: nullable(str("The create transaction (base58).")),
  why: nullable(str("The agent's one-line reason for this coin (the hype line).")), logoSource: { type: "string", nullable: true, enum: ["image", "model", "template", null], description: "Where the logo came from." },
}, "A coin an agent launched under its root, newest first.");
const ActivityItem = obj({
  at: int("Unix s the action started."), kind: { type: "string", enum: ["launch", "claim", "payout", "ai", "swap", "split"] },
  status: { type: "string", enum: ["pending", "sent", "step_landed", "landed", "failed", "expired", "uncertain", "done", "refused"], description: "On-chain actions end landed / failed / expired / uncertain (`step_landed`: created, fee split still owed); model calls end done / failed / refused." },
  title: str("Human line with the coin tickers, e.g. \"Launched $RUMORMILL\", \"Claimed 0.0549 SOL from $SPREAD\", \"Paid 0.12 SOL to the owner\", \"Thought with Claude Sonnet 5.5 ($0.013)\", \"Drew a logo ($0.008)\"."),
  amountSol: nullable(num("SOL moved or spent.")), amountUsdc: nullable(num("USDC moved.")), usd: nullable(num("USD value at today's prices.")),
  mint: nullable(str("The coin the action is about.")), symbol: nullable(str("Its ticker.")),
  signature: nullable(str("Transaction signature (base58) when there is one.")), explorer: nullable(str("https://solscan.io/tx/<signature>", { format: "uri" })),
}, "One action of an agent (the ledger lines of that action folded into one).");
const Agent = obj({
  root: ref("CoinRef"), status: { type: "string", enum: ["dry", "live", "paused"], description: "`dry`: proposes and simulates; `live`: launches, claims and pays; `paused`: idle." }, profile: { oneOf: [ref("AgentProfile"), { type: "null" }] },
  stats: obj({ runs: int("Evaluations so far."), proposals: int("Proposals so far."), lastRunAt: nullable(int("Unix s.")), nextRunAt: nullable(int("Unix s.")), score: int("Current momentum of the root (0-100)."), scoreReason: str("What the score is made of.") }),
  latest: { oneOf: [ref("Proposal"), { type: "null" }] },
  model: str("Id of the model the agent thinks with (e.g. `anthropic/claude-sonnet-5.5`)."), modelLabel: str("Its display name (e.g. `Claude Sonnet 5.5`)."),
  sleeping: { type: "boolean", nullable: true, description: "Live mode only: true while the agent waits (not enough in its wallet)." },
  reason: { type: "string", nullable: true, description: "Live mode only: one line on what the agent is doing or waiting for." },
  owedUsd: { type: "number", nullable: true, description: "Live mode only: model cost booked to the agent and not yet paid back to the owner, in USD." },
  brief: { oneOf: [ref("AgentBrief"), { type: "null" }], description: "The owner's standing instruction to this agent, or null (the agent follows its root's themes)." },
  wallet: { oneOf: [ref("AgentWallet"), { type: "null" }], description: "Null until the agent has a wallet." },
  totals: ref("AgentTotals"),
  launched: { ...arr(ref("LaunchedCoin")), maxItems: 12, description: "Newest first (the full list on /v1/agents/{root})." },
  activity: { ...arr(ref("ActivityItem")), maxItems: 8, description: "Newest first (up to 200 on /v1/agents/{root})." },
}, "A root coin's agent.");
const AgentBrief = obj({
  mode: { type: "string", enum: ["people", "free"], description: "`people`: every coin is one famous real person (name = full name, ticker = the name they go by), one person per coin, never twice; `free`: the brief's text steers the ideas." },
  setAt: nullable(int("Unix s the owner set it.")),
}, "An owner's brief (the text stays on the server).");
const AgentSummary = obj({
  address: nullable(str("The agent's wallet.")), status: { type: "string", enum: ["dry", "live", "paused"] }, wallet: { oneOf: [ref("AgentWallet"), { type: "null" }] }, totals: ref("AgentTotals"),
  model: str("Model id."), modelLabel: str("Model display name."),
}, "An agent in short, for a coin page.");
const AgentLaunch = obj({ signature: nullable(str("The create transaction (base58).")), at: int("Unix s."), why: nullable(str("The agent's hype line.")), logoSource: { type: "string", nullable: true, enum: ["image", "model", "template", null] }, proposalId: nullable(str("The proposal the launch came from (16 hex).")) }, "How an agent launched this coin.");
const AgentCoin = obj({
  role: { type: ["string", "null"], enum: ["root", "child", null], description: "`root`: this coin has an agent; `child`: an agent launched it; null: neither (the normal case, never a 404)." },
  root: { oneOf: [ref("CoinRef"), { type: "null" }], description: "The agent's root (the coin itself for `root`)." },
  agent: { oneOf: [ref("AgentSummary"), { type: "null" }] },
  launch: { oneOf: [ref("AgentLaunch"), { type: "null" }], description: "For `child`: the launch." },
}, "What a coin page shows about agents.");
const AgentList = obj({ mode: { type: "string", enum: ["off", "dry", "live"], description: "`off`: no agent runs on this server (stored agents are still served); `dry`: agents propose and simulate, never send; `live`: agents launch, claim and pay from their own wallets." }, agents: arr(ref("Agent")) }, "Every public agent: Spore roots and running agents; running first, then by momentum.");
const AgentDetail = obj({
  agent: ref("Agent"), proposals: { ...arr(ref("Proposal")), maxItems: 50, description: "Newest first." },
  activity: { ...arr(ref("ActivityItem")), maxItems: 200, description: "Newest first." }, launched: { ...arr(ref("LaunchedCoin")), description: "Every coin it launched, newest first." },
}, "One agent, its last 50 proposals, its activity and its launches.");
const AgentEvent = obj({ root: str("Root mint."), proposal: ref("Proposal") }, "`agent` stream event: an agent stored a new proposal.");
const ErrorBody = { type: "object", required: ["error"], properties: { error: str("What went wrong."), retryAfter: int("Seconds to wait before retrying."), tier: { type: "string", enum: ["public", "partner"] } } };

/** The document; `publicUrl` is the server URL and `limits` the tier numbers the server runs with. */
export function openApiDoc({ publicUrl = "https://sporepad.com", limits = {} } = {}) {
  const L = { publicPerMin: 60, partnerPerMin: 1200, publicStreams: 2, partnerStreams: 20, ...limits };
  const keyed = [{}, { ApiKeyHeader: [] }];
  const mintParam = { $ref: "#/components/parameters/Mint" }, ifNoneMatch = { $ref: "#/components/parameters/IfNoneMatch" };
  return {
    openapi: "3.1.0",
    info: {
      title: "Spore API", version: "1.0.0",
      summary: "Read-only family-tree data of pump.fun custom pairs (coins quoted in other pump coins).",
      description: [
        "Spore indexes every pump.fun coin that is quoted in another pump coin (depth ≥ 1) and every ancestor down to its root, and serves the trees, the ecosystem map and live activity.",
        "Everything is read-only: no endpoint signs, sends or accepts a transaction.",
        "",
        "**Conventions.** JSON, camelCase. Raw token amounts are decimal strings in raw units (coins have 6 decimals; SOL 9). USD values are numbers or null. Timestamps are unix seconds unless a field says milliseconds (`generatedAt`, `since`, `mapdelta.at`). Image URLs are absolute.",
        "",
        `**Tiers.** Public (no key): ${L.publicPerMin} requests per minute per IP, ${L.publicStreams} concurrent streams per IP. Partner (\`X-API-Key\`): ${L.partnerPerMin} requests per minute per key, ${L.partnerStreams} concurrent streams per key. An invalid or revoked key answers 401. Every response carries \`X-Spore-Tier\` and \`X-RateLimit-Limit/Remaining/Reset\`; a 429 carries \`Retry-After\`. Responses may be served by a CDN for up to 10 s, so the rate headers of a cached response can belong to an earlier caller.`,
        "",
        "**Keys.** Partner keys are free and issued on request: X [@Sporemap](https://x.com/Sporemap) or team@sporepad.com. A key is `spk_` + 32 base58 characters; send it in `X-API-Key` (`?key=` only on `/v1/stream`, for EventSource). Keep it server-side or in a trusted client.",
        "",
        "**Attribution.** Free to use with visible attribution: \"Data by Spore\" linking to https://sporepad.com wherever the data is shown.",
        "",
        `**Embeds.** \`${publicUrl}/embed/tree/<mint>\` and \`${publicUrl}/embed/map[?focus=<mint>]\` are widgets for an iframe (any size from 320×240; \`?theme=dark|light\`, \`?hideHeader=1\`).`,
        "",
        `**Logos.** Every \`image\` is a proxy URL (\`${publicUrl}/api/img?u=<url>\`); add \`&w=64|128|256\` for a square PNG thumbnail (header \`X-Img-Thumb: <w>\`; the original when none can be made). \`GET ${publicUrl}/api/logo-sheet?w=64&m=<mint>,<mint>,...[&f=webp|png]\` (1-256 mints, order kept) answers one image, 16 cells of 64 px per row, cell i at (i % 16 × 64, ⌊i / 16⌋ × 64), with hex bitmaps \`X-Sheet\` (present cells) and \`X-Sheet-Dead\` (no logo; byte j bit b = cell 8j+b), \`X-Sheet-N\`, \`X-Sheet-Cols\`, \`X-Sheet-Cell\` and \`X-Sheet-Pending\` (cells in neither bitmap are still being made: ask again). Both routes count against the image rate limit, not the API one.`,
        "",
        `**Share cards.** \`GET ${publicUrl}/card/<mint>.png\` (also \`/api/card/<mint>.png\`) is a 1200×630 PNG of one coin for link previews: the coin's family drawn as the live map (up to 72 bubbles with their logos, sized by market cap and coloured by depth, linked parent → child inside the family's hull, the top titled with its coin count and share of the map, the shared coin ringed in lime and labelled; a lone coin is one bubble) beside a slim panel of its facts: ticker and name, lineage from the family top, market cap, locked value, children, age and the first-child mark. Rendered on the server and cached a minute (\`Cache-Control: public, max-age=60, stale-while-revalidate=300\`, \`ETag\` + \`If-None-Match\` → 304, \`X-Card-Ms\` = render time, CORS \`*\`; a card drawn before its logo was cached carries \`max-age=5\` and is redrawn with the logo soon after); 400 for a malformed mint, 404 for a coin that is not on pump.fun (an unseen coin is looked up live once; that lookup counts against the API rate limit as well). When too many uncached cards are being drawn at once the answer is \`302\` to the site's generic \`/og.png\` (\`Cache-Control: no-store\`, \`Retry-After: 2\`): fetch again in a moment for the coin's own card. The coin page \`${publicUrl}/c/<mint>\` and the map \`${publicUrl}/map?focus=<mint>\` serve it as \`og:image\` / \`twitter:image\` (\`summary_large_image\`) with a coin-specific \`og:title\` ("$KID under $PARENT · Spore"; a family top "$ROOT · Spore"; a coin paired with a listed asset "$KID quoted in $PUMP · Spore") and \`og:description\`, so a pasted link unfurls as that coin on X, Telegram and Discord; the image URL carries \`?v=<minute>\` so a re-crawl sees fresh numbers. Counts against the image rate limit.`,
      ].join("\n"),
      contact: { name: "Spore", url: "https://x.com/Sporemap", email: "team@sporepad.com" },
      "x-attribution": "Data by Spore — https://sporepad.com",
    },
    servers: [{ url: publicUrl }],
    externalDocs: { description: "Docs, quick start and embed snippet generator", url: `${publicUrl}/docs/api` },
    tags: [{ name: "coins", description: "One coin and its tree" }, { name: "map", description: "The whole ecosystem" }, { name: "agents", description: "Root coins' agents: wallets, launches, fee claims, payouts and model calls" }, { name: "live", description: "Server-sent events" }, { name: "meta", description: "This document" }],
    security: keyed,
    paths: {
      "/v1/coin/{mint}/family": {
        get: {
          operationId: "getFamily", tags: ["coins"], summary: "A coin's family",
          description: "Where the coin sits in its family tree (root, parent, ancestors), its children (count and the 20 with the most locked value), locked value, market cap, 24 h change and links. Works for any pump.fun mint: a coin the index has not seen is looked up live. 404 for a mint that is not a pump.fun coin.",
          parameters: [mintParam, ifNoneMatch],
          responses: { 200: { description: "The family.", headers: CACHED_HEADERS, content: json(ref("Family"), EX_FAMILY) }, ...errors(304, 400, 401, 404, 429, 503) },
        },
      },
      "/v1/tree/{mint}": {
        get: {
          operationId: "getTree", tags: ["coins"], summary: "The whole tree containing a coin",
          description: "Every coin of the tree that contains `mint`, from its root, flat with `parentMint`: the root first, then breadth-first, siblings by locked value.",
          parameters: [mintParam, ifNoneMatch],
          responses: { 200: { description: "The tree.", headers: CACHED_HEADERS, content: json(ref("Tree"), EX_TREE) }, ...errors(304, 400, 401, 404, 429, 503) },
        },
      },
      "/v1/map": {
        get: {
          operationId: "getMap", tags: ["map"], summary: "The ecosystem map (full or delta)",
          description: "Without `since`: every root with a child and every descendant, nested (≈ 16 k nodes, ~1 MB gzipped; send `Accept-Encoding: gzip, br`). With `since=<generatedAt of your last copy>`: only the nodes that changed after it, flat with `parentMint`. A client keeps the full set, asks `since=` on each refresh and merges; re-sync fully every 15 min or so (`since` carries only coins whose own numbers moved).",
          parameters: [{ name: "since", in: "query", required: false, description: "Unix ms (the `generatedAt` of a previous response). Rounded down to the second.", schema: { type: "integer", minimum: 0 } }, ifNoneMatch],
          responses: {
            200: { description: "The full map, or the delta when `since` is given.", headers: CACHED_HEADERS, content: { "application/json": { schema: { oneOf: [ref("MapFull"), ref("MapDelta")] }, examples: { full: { summary: "Full map", value: EX_MAP }, delta: { summary: "since=<ms>", value: EX_DELTA } } } } },
            ...errors(304, 400, 401, 429),
          },
        },
      },
      "/v1/heat": {
        get: {
          operationId: "getHeat", tags: ["map"], summary: "Trade activity of every coin traded in 24 h",
          description: "Parallel arrays (index i describes `mint[i]`), most trades in the last hour first, then 24 h volume. Rebuilt at most every 15 s.",
          parameters: [ifNoneMatch],
          responses: { 200: { description: "Activity.", headers: CACHED_HEADERS, content: json(ref("Heat"), EX_HEAT) }, ...errors(304, 401, 429) },
        },
      },
      "/v1/agents": {
        get: {
          operationId: "getAgents", tags: ["agents"], summary: "Every root agent",
          description: "Each public root coin with an agent (Spore roots, and agents the owner runs): what the agent understood of it (profile), the root's current momentum, the latest proposal, the agent's wallet and balances, lifetime totals from its ledger, the last 12 coins it launched and its last 8 actions. Every root launched on Spore gets an agent with its own wallet (a share of the root's creator fee pays it); a live agent claims fees, thinks with its model, launches children under its root and pays its surplus to the owner. Every on-chain action carries its signature.",
          parameters: [ifNoneMatch],
          responses: { 200: { description: "The agents.", headers: CACHED_HEADERS, content: json(ref("AgentList"), EX_AGENTS) }, ...errors(304, 401, 429) },
        },
      },
      "/v1/agents/coin/{mint}": {
        get: {
          operationId: "getAgentCoin", tags: ["agents"], summary: "What a coin page shows about agents",
          description: "Whether `mint` is an agent's root (`role: root`, with the agent in short) or a coin an agent launched (`role: child`, with the root, the agent and the launch: signature, time, hype line). A coin with neither answers `role: null` with a 200: not having an agent is the normal case. 400 for a malformed mint.",
          parameters: [mintParam, ifNoneMatch],
          responses: { 200: { description: "The coin's agent context.", headers: CACHED_HEADERS, content: json(ref("AgentCoin"), EX_AGENT_COIN) }, ...errors(304, 400, 401, 429) },
        },
      },
      "/v1/agents/{root}": {
        get: {
          operationId: "getAgent", tags: ["agents"], summary: "One root agent, its proposals and its activity",
          description: "The agent of `root`, its last 50 proposals (newest first), its last 200 actions (newest first: launches, fee claims, payouts, model calls, swaps, fee splits, each with a human title and its transaction signature) and every coin it launched. 404 when the coin has no public agent.",
          parameters: [{ name: "root", in: "path", required: true, description: "The root coin's mint.", schema: { type: "string", pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$" }, example: SPORE }, ifNoneMatch],
          responses: { 200: { description: "The agent.", headers: CACHED_HEADERS, content: json(ref("AgentDetail"), EX_AGENT) }, ...errors(304, 400, 401, 404, 429) },
        },
      },
      "/v1/stream": {
        get: {
          operationId: "stream", tags: ["live"], summary: "Live events (server-sent events)",
          description: [
            "`text/event-stream` of `event: <type>` / `data: <json>` frames; heartbeat comments every 25 s; `retry: 3000`.",
            "Types: `pair` (PairEvent: a new coin launched under a known parent), `trade` (Trade), `heat` (HeatRow after each trade), `stats` (Stats, every 30 s), `mapdelta` (MapDeltaEvent, at most every 3 s), `coin` (a Spore launch changed), `agent` (AgentEvent: a root agent stored a proposal).",
            "`mint=` narrows every event to the tree that contains that coin (its root is resolved per event, so coins that join the tree later are included); `stats` is never narrowed.",
            `Concurrent streams: ${L.publicStreams} per IP (public), ${L.partnerStreams} per key (partner). EventSource cannot set headers, so a partner passes \`?key=\` here (and only here).`,
          ].join("\n\n"),
          security: [{}, { ApiKeyHeader: [] }, { ApiKeyQuery: [] }],
          parameters: [
            { name: "types", in: "query", required: false, description: "Comma-separated event types. Default `pair,trade,heat,stats`.", schema: { type: "string", default: "pair,trade,heat,stats" }, example: "pair,trade" },
            { name: "mint", in: "query", required: false, description: "Only events of the tree that contains this coin (a root or any coin in it).", schema: { type: "string" }, example: SPORE },
          ],
          responses: {
            200: {
              description: "The event stream (never cached).", headers: RATE_HEADERS,
              content: { "text/event-stream": { schema: { type: "string" }, example: `retry: 3000\n: connected tier=public types=trade\n\nevent: trade\ndata: {"sig":"3U3gxtophmk43khw9oHRXJ7M4mE3nfC1r8ZJHZSsaEWE8B5t2Sg4MiMrDQy2kdUbBezbHufFu8jy5Sbyg3PGvRy5","mint":"8U4Qox8desiEDSpVJa6yzccEa6yEmmCDNMeRpLJhpump","slot":458818201,"time":1792409617,"isBuy":false,"user":"EYGzHFFmaYPKBnmJX6eskL9RHzM1xk1LE2X22Bu7EGkF","baseAmount":"148466171541","quoteAmount":"869","priceQuote":5.858408969828443e-11,"priceUsd":null,"valueUsd":null}\n\n: hb 1792409642000\n\n` } },
              "x-events": { pair: ref("PairEvent"), trade: ref("Trade"), heat: ref("HeatRow"), stats: ref("Stats"), mapdelta: ref("MapDeltaEvent"), agent: ref("AgentEvent"), coin: { type: "object", description: "A Spore launch's full coin record (see the web API's Coin)." } },
            },
            ...errors(400, 401, 429, 503),
          },
        },
      },
      "/v1/openapi.json": {
        get: {
          operationId: "openapi", tags: ["meta"], summary: "This document",
          responses: { 200: { description: "OpenAPI 3.1.", headers: RATE_HEADERS, content: { "application/json": { schema: { type: "object" } } } }, ...errors(304, 401, 429) },
        },
      },
    },
    components: {
      securitySchemes: {
        ApiKeyHeader: { type: "apiKey", in: "header", name: "X-API-Key", description: "Partner key (`spk_` + 32 base58 characters). Optional: without it the public tier applies." },
        ApiKeyQuery: { type: "apiKey", in: "query", name: "key", description: "The same key as a query parameter, accepted only on /v1/stream (EventSource cannot set headers)." },
      },
      parameters: {
        Mint: { name: "mint", in: "path", required: true, description: "A pump.fun token mint (base58).", schema: { type: "string", pattern: "^[1-9A-HJ-NP-Za-km-z]{32,44}$" }, example: SPORE },
        IfNoneMatch: { name: "If-None-Match", in: "header", required: false, description: "ETag of a previous response; 304 when unchanged.", schema: { type: "string" } },
      },
      headers: {
        "X-RateLimit-Limit": { description: "Requests allowed per minute on this tier.", schema: { type: "integer" } },
        "X-RateLimit-Remaining": { description: "Requests left in the current minute.", schema: { type: "integer" } },
        "X-RateLimit-Reset": { description: "Unix s when the window resets.", schema: { type: "integer" } },
        "X-Spore-Tier": { description: "`public` or `partner`.", schema: { type: "string", enum: ["public", "partner"] } },
        ETag: { description: "Weak validator for If-None-Match.", schema: { type: "string" } },
        "Cache-Control": { description: "`public, max-age=5, s-maxage=10`.", schema: { type: "string" } },
      },
      responses: {
        NotModified: { description: "Not modified (If-None-Match matched)." },
        BadRequest: { description: "Malformed parameter.", content: json(ref("Error"), { error: "invalid mint" }) },
        Unauthorized: { description: "Invalid or revoked API key.", content: json(ref("Error"), { error: "invalid or revoked API key" }) },
        NotFound: { description: "Not a pump.fun coin.", content: json(ref("Error"), { error: "not a pump.fun coin" }) },
        TooManyRequests: { description: "Rate or stream limit reached.", headers: { "Retry-After": { description: "Seconds.", schema: { type: "integer" } }, ...RATE_HEADERS }, content: json(ref("Error"), { error: `rate limited (public tier: ${L.publicPerMin} requests per minute), try again in 12 s`, retryAfter: 12, tier: "public" }) },
        Unavailable: { description: "The live pump.fun lookup (or the stream budget) is unavailable; retry.", content: json(ref("Error"), { error: "pump.fun lookup unavailable, retry shortly", retryAfter: 5 }) },
      },
      schemas: { CoinRef, FamilyChild, Family, MapCoin, MapCoinFlat, MapNode, Tree, MapFull, MapDelta, Heat, HeatRow, Trade, PairEvent, MapDeltaEvent, Stats, AgentProfile, Proposal, AgentBrief, AgentWallet, AgentTotals, LaunchedCoin, ActivityItem, Agent, AgentSummary, AgentLaunch, AgentCoin, AgentList, AgentDetail, AgentEvent, Error: ErrorBody },
    },
  };
}
