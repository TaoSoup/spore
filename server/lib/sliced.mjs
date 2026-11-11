// Cooperative slicing for long passes over the model (the whole-forest map, DESIGN §11.5; the background computed()
// pass). The work is a generator that yields every few dozen items; `runSliced` hands it to one scheduler shared by
// every job: each event-loop turn (one setImmediate) runs steps of the live jobs round-robin until SLICE_MS is spent,
// so requests and the live stream are served between turns however many jobs are in flight (one /api/map build held
// the loop for 3.1 s on the local index, Nov 11 2026; with a setImmediate per job, K jobs held it K slices per turn).
// `drain` runs a generator to its end at once, for callers that need the answer now (the synchronous API, tests).
import { performance } from "node:perf_hooks";

/** Longest stretch one turn of the scheduler may hold the event loop (checked after every step of a job). */
export const SLICE_MS = 8;

/** The scheduler's counters: turns run, the last and longest turn (ms), jobs in flight now and at most. */
export const slicedStats = { turns: 0, lastTurnMs: 0, maxTurnMs: 0, jobs: 0, maxJobs: 0 };

const live = []; // jobs in flight, in arrival order: { gen, resolve, reject, cpuMs, slices, maxSliceMs, turnMs, turn }
let next = 0; // round-robin position in `live`
let scheduled = false;
let turnNo = 0;

/** Runs `gen` to its end in one go and returns its value. */
export function drain(gen) {
  let r;
  do { r = gen.next(); } while (!r.done);
  return r.value;
}

/**
 * Runs `gen` on the shared scheduler. Resolves with `{ value, cpuMs, slices, maxSliceMs }`: the generator's return
 * value, the time spent in it, how many turns it took part in and its longest share of one turn; rejects with what
 * the generator threw.
 */
export function runSliced(gen) {
  return new Promise((resolve, reject) => {
    live.push({ gen, resolve, reject, cpuMs: 0, slices: 0, maxSliceMs: 0, turnMs: 0, turn: -1 });
    slicedStats.jobs = live.length;
    if (live.length > slicedStats.maxJobs) slicedStats.maxJobs = live.length;
    schedule();
  });
}

function schedule() {
  if (scheduled) return;
  scheduled = true;
  setImmediate(turn);
}

/** One turn: one step of each live job in turn, round and round, until SLICE_MS is spent or no job is left. */
function turn() {
  scheduled = false;
  const t0 = performance.now(), until = t0 + SLICE_MS, id = ++turnNo, ran = [];
  while (live.length) {
    if (next >= live.length) next = 0;
    const job = live[next];
    if (job.turn !== id) { job.turn = id; job.turnMs = 0; ran.push(job); }
    const ts = performance.now();
    let r = null, error = null;
    try { r = job.gen.next(); } catch (e) { error = e ?? new Error("sliced job failed"); }
    const dt = performance.now() - ts;
    job.turnMs += dt; job.cpuMs += dt;
    if (error || r.done) {
      live.splice(next, 1); // `next` now points at the job after it
      const slices = job.slices + 1, maxSliceMs = Math.max(job.maxSliceMs, job.turnMs);
      if (error) job.reject(error); else job.resolve({ value: r.value, cpuMs: job.cpuMs, slices, maxSliceMs });
    } else next++;
    if (performance.now() >= until) break;
  }
  for (const job of ran) { job.slices++; if (job.turnMs > job.maxSliceMs) job.maxSliceMs = job.turnMs; }
  const ms = performance.now() - t0;
  slicedStats.turns++; slicedStats.lastTurnMs = ms; if (ms > slicedStats.maxTurnMs) slicedStats.maxTurnMs = ms;
  slicedStats.jobs = live.length;
  if (live.length) schedule();
}
