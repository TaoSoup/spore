// Spore's on-chain library: everything the pages need to spawn, buy and sell. Browser-safe; the
// same code runs under node for the mainnet simulation tests in web/test.
export { splitShares, DEFAULT_SPLIT_BPS, type Share } from "./shares";
export { hopsFor, isSolRooted, withSolPool, type Chain, type ChainLink, type Side, type SolPoolAsset } from "./route";
export { quoteSwap, buildSwapTx, explainSimulationError, explainCustomError, failedProgram, isSlippageFailure, swapUnits, swapFeeLamports, priorityMicroLamports, routeVenues, ataRentLamports, compileV0, txBytes, MAX_TX_BYTES, CU_PRICE_MICRO, CU_PRICE_MAX_MICRO, QUOTE_CU_LIMIT, JUPITER_PROGRAM, type Quote } from "./trade";
export { buildSpawnTx, buildFeeSplitTx, type SpawnForm, type SpawnBuild, type LaunchFee } from "./spawn";
export { LOOKUP_TABLE, lookupTables } from "./alt";
export { sendAndConfirm, confirm, signatureState, ExpiredError, UnconfirmedError, OnChainError } from "./send";
export { preflight, SimulationError, type Preflight } from "./simulate";
export { estimateFirstBuy, type FirstBuyEstimate } from "./estimate";
export { readClaimState, claimInstructions, buildClaimTx, parseClaimLogs, perShare, ClaimError, type ClaimState, type ClaimPayout } from "./claim";
