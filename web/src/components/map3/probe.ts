// The /map renderer probe (map3 spec 6.2): WebGL2 with float colour buffers (the bloom chain renders to
// half-float targets) or the classic Canvas 2D map. One throwaway context per page, released at once so
// it never counts against the browser's live-context limit. Memoised; false outside a browser.
let memo: boolean | null = null;

export function webgl2Available(): boolean {
  if (memo !== null) return memo;
  if (typeof document === "undefined") return false;
  let ok = false;
  try {
    const canvas = document.createElement("canvas");
    const gl = canvas.getContext("webgl2", { failIfMajorPerformanceCaveat: false });
    if (gl) {
      ok = gl.getExtension("EXT_color_buffer_float") != null;
      gl.getExtension("WEBGL_lose_context")?.loseContext();
    }
  } catch {
    ok = false;
  }
  memo = ok;
  return ok;
}
