// Web Audio. Listens to the game bus; the simulation never imports this file.

import { GAME_EVENTS } from "../sim/events.js";

/**
 * `buffers`: { fire, hit, explode } → AudioBuffer | null (decoded during loading).
 * The AudioContext is created lazily inside the first pointerdown/keydown handler:
 * browsers keep a context created without a user gesture "suspended" (autoplay policy).
 */
export function createAudio({ bus, buffers, target = window, volume = 0.5 }) {
  const ac = new AbortController();
  const { signal } = ac;
  let ctx = null;
  let master = null;
  let muted = false;

  function unlock() {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") ctx.resume();
  }

  for (const type of ["pointerdown", "keydown"]) {
    target.addEventListener(type, unlock, { signal, capture: true });
  }
  target.addEventListener(
    "keydown",
    (e) => {
      if (e.code !== "KeyM" || e.repeat || e.target?.tagName === "INPUT") return;
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : volume;
    },
    { signal },
  );

  function play(name, { gain = 1, detune = 0 } = {}) {
    const buffer = buffers[name];
    if (!buffer || !ctx || ctx.state !== "running") return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.detune.value = detune;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(master);
    src.start();
  }

  const jitter = (cents) => (Math.random() - 0.5) * cents;
  bus.addEventListener(GAME_EVENTS.FIRED, () => play("fire", { gain: 0.6, detune: jitter(150) }), {
    signal,
  });
  bus.addEventListener(GAME_EVENTS.HIT, () => play("hit", { gain: 0.8, detune: jitter(200) }), {
    signal,
  });
  bus.addEventListener(
    GAME_EVENTS.EXPLODED,
    (e) => play("explode", { gain: e.detail.kind === "ship" ? 1 : 0.7, detune: jitter(300) }),
    { signal },
  );

  return {
    unlock,
    get state() {
      if (!ctx) return "locked";
      return muted ? "muted" : ctx.state;
    },
    dispose() {
      ac.abort();
      ctx?.close();
    },
  };
}
