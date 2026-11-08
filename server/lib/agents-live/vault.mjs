// Agent wallets (DESIGN §13.1): every root agent owns ONE real Solana keypair, created here and kept
// encrypted at rest. The owner's rule from 2026-10-19: an agent never spends from the platform wallet
// and never from a keyless placeholder; every address the agents show in public must have a key that
// is stored and backed up.
//
// At rest: DATA_DIR/agents/wallets/<root>.json = { v, root, address, createdAt, iv, tag, ct } where
// ct is the 64-byte secret key under AES-256-GCM with the vault key and the root mint as the
// associated data (a file copied under another root's name does not decrypt). The vault key is a
// 32-byte secret in AGENT_VAULT_KEY_FILE (mode 600, made by `scripts/agent-vault.mjs init`). A backup
// of the wallets directory is useless without that file and the file is useless without the
// directory, so the owner keeps the two apart.
//
// In memory: a signer is `{ address, signTransaction(tx) }` that decrypts on each call and never
// exposes the secret key; nothing here logs, returns or throws the secret. Loading a signer is only
// possible from live code paths (the dry-run agents never import this module).
import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, readdirSync, statSync, chmodSync, unlinkSync, openSync, writeSync, fsyncSync, closeSync, linkSync } from "node:fs";
import { join, dirname } from "node:path";
import { Keypair, PublicKey } from "@solana/web3.js";

export class VaultError extends Error { constructor(message) { super(message); this.name = "VaultError"; } }

const FILE_V = 1;
const KEY_BYTES = 32, IV_BYTES = 12;
const ROOT_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Reads the vault key file: 64 hex chars or 44 base64 chars for 32 bytes. Refuses a world-readable file. */
export function readVaultKey(file) {
  if (!file) throw new VaultError("AGENT_VAULT_KEY_FILE is not set");
  let text;
  try { text = readFileSync(file, "utf8").trim(); } catch (e) { throw new VaultError(`vault key file unreadable (${e.code ?? "error"})`); }
  if (process.platform !== "win32") {
    const mode = statSync(file).mode & 0o777;
    if (mode & 0o077) throw new VaultError(`vault key file must be mode 600 (is ${mode.toString(8)})`);
  }
  const key = /^[0-9a-f]{64}$/i.test(text) ? Buffer.from(text, "hex") : Buffer.from(text, "base64");
  if (key.length !== KEY_BYTES) throw new VaultError("vault key must be 32 bytes");
  return key;
}

/** Makes a fresh vault key file (mode 600). Never overwrites an existing one. */
export function initVaultKey(file) {
  if (existsSync(file)) throw new VaultError("vault key file already exists; refusing to overwrite");
  writeFileSync(file, randomBytes(KEY_BYTES).toString("hex") + "\n", { mode: 0o600, flag: "wx" });
  chmodSync(file, 0o600);
  return file;
}

/**
 * Writes `rec` to `file` without ever replacing an existing file (a wallet may hold funds): the
 * record goes to a temp file that is fsynced, then hard-linked to its final name — EEXIST when the
 * name is taken — and the directory is fsynced so the address handed out survives a crash.
 */
function publishNoReplace(file, rec) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(tmp, "wx", 0o600);
  try { writeSync(fd, JSON.stringify(rec) + "\n"); fsyncSync(fd); } finally { closeSync(fd); }
  try { linkSync(tmp, file); }
  catch (e) { try { unlinkSync(tmp); } catch { /* best effort */ } throw e.code === "EEXIST" ? new VaultError(`wallet file ${file.split("/").pop()} already exists`) : e; }
  unlinkSync(tmp);
  chmodSync(file, 0o600);
  try { const d = openSync(dirname(file), "r"); try { fsyncSync(d); } finally { closeSync(d); } } catch { /* directory fsync unsupported here */ }
}

export function encryptSecret(vaultKey, root, secret) {
  const iv = randomBytes(IV_BYTES);
  const c = createCipheriv("aes-256-gcm", vaultKey, iv);
  c.setAAD(Buffer.from(root, "utf8"));
  const ct = Buffer.concat([c.update(secret), c.final()]);
  return { iv: iv.toString("base64"), tag: c.getAuthTag().toString("base64"), ct: ct.toString("base64") };
}

export function decryptSecret(vaultKey, root, { iv, tag, ct }) {
  const d = createDecipheriv("aes-256-gcm", vaultKey, Buffer.from(iv, "base64"));
  d.setAAD(Buffer.from(root, "utf8"));
  d.setAuthTag(Buffer.from(tag, "base64"));
  try { return Buffer.concat([d.update(Buffer.from(ct, "base64")), d.final()]); }
  catch { throw new VaultError("wallet file does not decrypt with this vault key"); }
}

export class AgentVault {
  #key; #dir;
  /** `dir` = DATA_DIR/agents/wallets; `vaultKey` = the 32-byte buffer from readVaultKey. */
  constructor({ dir, vaultKey }) {
    if (!dir) throw new VaultError("vault dir missing");
    if (!Buffer.isBuffer(vaultKey) || vaultKey.length !== KEY_BYTES) throw new VaultError("vault key must be 32 bytes");
    this.#dir = dir; this.#key = vaultKey;
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  get dir() { return this.#dir; }
  #file(root) {
    if (!ROOT_RE.test(String(root))) throw new VaultError("root is not a base58 mint");
    return join(this.#dir, `${root}.json`);
  }
  has(root) { return existsSync(this.#file(root)); }

  /** Creates the agent's wallet. Refuses when one exists: a wallet may hold funds and is never replaced. */
  create(root) {
    const file = this.#file(root);
    if (existsSync(file)) throw new VaultError(`agent ${root} already has a wallet`);
    const kp = Keypair.generate();
    const rec = { v: FILE_V, root, address: kp.publicKey.toBase58(), createdAt: Math.floor(Date.now() / 1000), ...encryptSecret(this.#key, root, Buffer.from(kp.secretKey)) };
    publishNoReplace(file, rec);
    // Prove the file round-trips before anyone funds the address (a corrupt write must fail here, not later).
    const back = this.address(root);
    if (back !== rec.address) throw new VaultError("wallet file did not round-trip");
    return { root, address: rec.address, createdAt: rec.createdAt };
  }

  #read(root) {
    const file = this.#file(root);
    let rec;
    try { rec = JSON.parse(readFileSync(file, "utf8")); } catch (e) { throw new VaultError(e.code === "ENOENT" ? `agent ${root} has no wallet` : "wallet file unreadable"); }
    if (rec?.v !== FILE_V || rec.root !== root || !rec.iv || !rec.tag || !rec.ct || !rec.address) throw new VaultError("wallet file is malformed");
    return rec;
  }
  /** The wallet that launched the root (recorded at prepare time), or null for a seeded agent. */
  creatorOf(root) { try { return this.#read(root).creator ?? null; } catch { return null; } }
  /** Public address only; verified against the decrypted key so a tampered address field is caught. */
  address(root) {
    const rec = this.#read(root);
    const secret = decryptSecret(this.#key, root, rec);
    const kp = Keypair.fromSecretKey(new Uint8Array(secret));
    const a = kp.publicKey.toBase58();
    if (a.length !== rec.address.length || !timingSafeEqual(Buffer.from(a), Buffer.from(rec.address))) throw new VaultError("wallet address does not match its key");
    return a;
  }
  /** A signer that keeps the secret inside the closure: `{ address, publicKey, signTransaction(tx) }`. */
  signer(root) {
    const address = this.address(root);
    const read = () => Keypair.fromSecretKey(new Uint8Array(decryptSecret(this.#key, root, this.#read(root))));
    return {
      address, publicKey: new PublicKey(address),
      signTransaction(tx) { tx.sign([read()]); return tx; },
      toJSON() { return { address }; }, toString() { return address; },
    };
  }
  list() {
    return readdirSync(this.#dir).filter((f) => f.endsWith(".json") && !f.startsWith("pending-")).map((f) => {
      try { const rec = JSON.parse(readFileSync(join(this.#dir, f), "utf8")); return { root: rec.root, address: rec.address, createdAt: rec.createdAt }; }
      catch { return null; }
    }).filter(Boolean);
  }

  // ── Wallets prepared before a root exists (DESIGN §13.1) ────────────────────────────────────
  // A root's agent address must be inside the launch transaction's fee split, so the wallet is made
  // first under a random id (`pending-<id>.json`, encrypted with the id as the associated data) and
  // bound to the mint once the launch landed (`bind`: re-encrypted under the root, renamed). A
  // pending wallet that is never bound is swept after `maxAgeS` — it never held funds.
  #pendingFile(id) {
    if (!/^[0-9a-f]{32}$/.test(String(id))) throw new VaultError("pending id is not 32 hex characters");
    return join(this.#dir, `pending-${id}.json`);
  }
  prepare({ creator = null, model = null } = {}) {
    const id = randomBytes(16).toString("hex");
    const file = this.#pendingFile(id);
    const kp = Keypair.generate();
    const rec = { v: FILE_V, pending: id, creator, model, address: kp.publicKey.toBase58(), createdAt: Math.floor(Date.now() / 1000), ...encryptSecret(this.#key, `pending:${id}`, Buffer.from(kp.secretKey)) };
    publishNoReplace(file, rec);
    // The address goes into an on-chain split: prove the file decrypts before handing it out.
    if (Keypair.fromSecretKey(new Uint8Array(decryptSecret(this.#key, `pending:${id}`, this.pending(id)))).publicKey.toBase58() !== rec.address) throw new VaultError("pending wallet did not round-trip");
    return { id, address: rec.address, creator, model, createdAt: rec.createdAt };
  }
  // A pending wallet's address may already sit inside an on-chain fee split (the browser's report
  // can be lost), so a pending file is NEVER deleted: after an hour it is moved to `unbound/`, from
  // where the chain reconciler (reconcile.mjs) still binds it once a coin names its address.
  #unboundFile(id) { return join(this.#dir, "unbound", `pending-${id}.json`); }
  pending(id) {
    const file = this.#pendingFile(id), alt = this.#unboundFile(id);
    let rec;
    try { rec = JSON.parse(readFileSync(existsSync(file) ? file : alt, "utf8")); } catch (e) { throw new VaultError(e.code === "ENOENT" ? `no pending wallet ${id}` : "pending wallet file unreadable"); }
    if (rec?.v !== FILE_V || rec.pending !== id || !rec.address) throw new VaultError("pending wallet file is malformed");
    return rec;
  }
  /** Every unbound wallet (pending and moved aside): `{ id, address, creator, model, createdAt }`. */
  pendingList() {
    const out = [];
    for (const d of [this.#dir, join(this.#dir, "unbound")]) {
      if (!existsSync(d)) continue;
      for (const f of readdirSync(d)) {
        if (!f.startsWith("pending-") || !f.endsWith(".json")) continue;
        try { const r = JSON.parse(readFileSync(join(d, f), "utf8")); if (r?.pending && r.address) out.push({ id: r.pending, address: r.address, creator: r.creator ?? null, model: r.model ?? null, createdAt: r.createdAt ?? 0 }); } catch { /* skip */ }
      }
    }
    return out;
  }
  /** Binds a prepared wallet to its root mint. Refuses when the root already has a wallet. */
  bind(id, root) {
    const target = this.#file(root);
    if (existsSync(target)) throw new VaultError(`agent ${root} already has a wallet`);
    const rec = this.pending(id);
    const secret = decryptSecret(this.#key, `pending:${id}`, rec);
    const kp = Keypair.fromSecretKey(new Uint8Array(secret));
    if (kp.publicKey.toBase58() !== rec.address) throw new VaultError("pending wallet address does not match its key");
    const bound = { v: FILE_V, root, address: rec.address, createdAt: rec.createdAt, boundAt: Math.floor(Date.now() / 1000), creator: rec.creator ?? null, model: rec.model ?? null, ...encryptSecret(this.#key, root, Buffer.from(kp.secretKey)) };
    publishNoReplace(target, bound); // EEXIST if a wallet appeared for this root meanwhile: never replaced
    if (this.address(root) !== rec.address) throw new VaultError("bound wallet did not round-trip");
    for (const f of [this.#pendingFile(id), this.#unboundFile(id)]) if (existsSync(f)) unlinkSync(f);
    return { root, address: rec.address, model: rec.model ?? null, creator: rec.creator ?? null };
  }
  /** Moves pending wallets older than `maxAgeS` (default 1 h) aside to `unbound/` (never deleted). Returns how many. */
  sweepPending({ maxAgeS = 3600, now = Math.floor(Date.now() / 1000) } = {}) {
    let n = 0;
    const dest = join(this.#dir, "unbound");
    for (const f of readdirSync(this.#dir)) {
      if (!f.startsWith("pending-") || !f.endsWith(".json")) continue;
      try {
        const rec = JSON.parse(readFileSync(join(this.#dir, f), "utf8"));
        if (now - (rec.createdAt ?? 0) > maxAgeS) { mkdirSync(dest, { recursive: true, mode: 0o700 }); renameSync(join(this.#dir, f), join(dest, f)); n++; }
      } catch { /* leave it */ }
    }
    return n;
  }
}
