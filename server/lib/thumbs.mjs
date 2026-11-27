// Logo thumbnails read from the image cache (lib/meta.mjs ImageCache) for code that embeds or sends a coin's picture
// rather than serving it: the social card's bubbles (lib/card.mjs) and the narrative tagger (lib/narrtags.mjs). Both
// read a PNG thumbnail that is already on disk and, when it is missing, start making it the way /api/img does.
const PNG_MAGIC = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
/** Whether `b` is a Buffer holding a PNG (its signature and room for the IHDR chunk). */
export const isPng = (b) => Buffer.isBuffer(b) && b.length > 24 && b.subarray(0, 8).equals(PNG_MAGIC);
/** The `w` px PNG thumbnail of `url` on disk (ImageCache.thumbBytes), or null: not made, not a PNG, no cache. Never fetches or renders. */
export const readThumb = (images, url, w) => { try { const b = images?.thumbBytes?.(url, w); return isPng(b) ? b : null; } catch { return null; } };
/**
 * Starts making the `w` px PNG of `url` in the image cache, the way /api/img makes it (`get` +
 * `thumb`: the cache's own negative memory of a dead upstream still holds, but not `warm`'s
 * hours-long skip list, which a rate-limited bulk pass fills with perfectly fetchable logos); a cache
 * without those two gets a warm ask. Returns the job (never rejects; its result is not the PNG: the
 * caller re-reads the thumbnail from disk), null when the cache can make nothing.
 */
export function makeLogo(images, url, w) {
  const make = typeof images?.get === "function" && typeof images.thumb === "function"
    ? async () => { const hit = await images.get(url); return hit ? images.thumb(url, hit, w) : null; }
    : typeof images?.warm === "function" ? () => images.warm([url], w, 1) : null;
  return make ? Promise.resolve().then(make).catch(() => null) : null;
}
