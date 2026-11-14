// Base58 (Bitcoin alphabet) for byte strings: a Solana secret key is shown and imported in this form, the one Phantom,
// Solflare and Backpack export and import. Small inputs only (a 64-byte key), so the quadratic loop is fine.
const ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const INDEX = new Map([...ALPHABET].map((c, i) => [c, i]));

export function encodeBase58(bytes: Uint8Array): string {
  const digits: number[] = [];
  for (const byte of bytes) {
    let carry = byte;
    for (let i = 0; i < digits.length; i++) { carry += digits[i] << 8; digits[i] = carry % 58; carry = (carry / 58) | 0; }
    while (carry > 0) { digits.push(carry % 58); carry = (carry / 58) | 0; }
  }
  let out = "";
  for (const b of bytes) { if (b !== 0) break; out += "1"; }
  for (let i = digits.length - 1; i >= 0; i--) out += ALPHABET[digits[i]];
  return out;
}

/// Throws on any character outside the alphabet.
export function decodeBase58(text: string): Uint8Array {
  const bytes: number[] = [];
  for (const ch of text) {
    const v = INDEX.get(ch);
    if (v === undefined) throw new Error("not base58");
    let carry = v;
    for (let i = 0; i < bytes.length; i++) { carry += bytes[i] * 58; bytes[i] = carry & 0xff; carry >>= 8; }
    while (carry > 0) { bytes.push(carry & 0xff); carry >>= 8; }
  }
  for (const ch of text) { if (ch !== "1") break; bytes.push(0); }
  return Uint8Array.from(bytes.reverse());
}
