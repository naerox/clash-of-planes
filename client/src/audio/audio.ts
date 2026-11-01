// Web Audio. Listens to the game bus; the simulation never imports this file.

import type { GameBus } from "../events.ts";

export type SoundName = "fire" | "hit" | "explode";

export interface AudioOptions {
  bus: GameBus;
  /** Decoded during loading; a sound that failed to load is `null` (silence). */
  buffers: Partial<Record<SoundName, AudioBuffer | null>>;
  target?: Pick<Window, "addEventListener">;
  volume?: number;
}

export type AudioState = "locked" | "muted" | AudioContextState;

/**
 * `buffers`: { fire, hit, explode } → AudioBuffer | null (decoded during loading).
 * The AudioContext is created lazily inside the first pointerdown/keydown handler:
 * browsers keep a context created without a user gesture "suspended" (autoplay policy).
 */
export function createAudio({ bus, buffers, target = window, volume = 0.5 }: AudioOptions) {
  const ac = new AbortController();
  const { signal } = ac;
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  let muted = false;

  function unlock(): void {
    if (!ctx) {
      ctx = new AudioContext();
      master = ctx.createGain();
      master.gain.value = volume;
      master.connect(ctx.destination);
    }
    if (ctx.state === "suspended") void ctx.resume();
  }

  for (const type of ["pointerdown", "keydown"] as const) {
    target.addEventListener(type, unlock, { signal, capture: true });
  }
  target.addEventListener(
    "keydown",
    (e) => {
      if (
        e.code !== "KeyM" ||
        e.repeat ||
        (e.target instanceof Element && e.target.tagName === "INPUT")
      )
        return;
      muted = !muted;
      if (master) master.gain.value = muted ? 0 : volume;
    },
    { signal },
  );

  function play(name: SoundName, { gain = 1, detune = 0 } = {}): void {
    const buffer = buffers[name];
    if (!buffer || !ctx || !master || ctx.state !== "running") return;
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.detune.value = detune;
    const g = ctx.createGain();
    g.gain.value = gain;
    src.connect(g).connect(master);
    src.start();
  }

  const jitter = (cents: number): number => (Math.random() - 0.5) * cents;
  bus.on("fired", () => play("fire", { gain: 0.6, detune: jitter(150) }), { signal });
  bus.on("hit", () => play("hit", { gain: 0.8, detune: jitter(200) }), { signal });
  bus.on(
    "exploded",
    (e) => play("explode", { gain: e.kind === "ship" ? 1 : 0.7, detune: jitter(300) }),
    { signal },
  );

  return {
    unlock,
    get state(): AudioState {
      if (!ctx) return "locked";
      return muted ? "muted" : ctx.state;
    },
    dispose(): void {
      ac.abort();
      void ctx?.close();
    },
  };
}
