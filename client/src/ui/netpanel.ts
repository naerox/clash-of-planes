// A control panel for the network lab: sliders for the server-side lag simulator (artificial
// round-trip time, jitter, loss — sent as a `netsim` message and applied to THIS connection) and
// for the client's own netcode (prediction, reconciliation, correction smoothing, interpolation
// delay). Toggle with F2.

import type { NetsimSettings } from "@dogfight/shared";
import type { GameSession } from "../game/session.ts";
import type { Connection } from "../net/connection.ts";
import { msg } from "../net/protocol.ts";
import { el } from "./dom.ts";

interface SliderConfig {
  min: number;
  max: number;
  step: number;
  get: () => number;
  set: (value: number) => void;
  format: (value: number) => string;
}

export function mountNetPanel(
  session: GameSession,
  connection: Connection,
  root: HTMLElement,
  { initial = {} }: { initial?: Partial<NetsimSettings> } = {},
): () => void {
  const ac = new AbortController();
  const { signal } = ac;
  const net = { latency: 0, jitter: 0, drop: 0, ...initial };
  let timer: ReturnType<typeof setTimeout> | undefined;

  const pushNetsim = (): void => {
    clearTimeout(timer);
    timer = setTimeout(() => connection.send(msg.netsim(net)), 120); // sliders fire a lot of events
  };

  function slider(label: string, { min, max, step, get, set, format }: SliderConfig) {
    const out = el("output");
    const input = el("input", {
      type: "range",
      min: String(min),
      max: String(max),
      step: String(step),
      value: String(get()),
    });
    const refresh = (): void => {
      out.textContent = format(Number(input.value));
    };
    input.addEventListener(
      "input",
      () => {
        set(Number(input.value));
        refresh();
      },
      { signal },
    );
    refresh();
    return {
      row: el("label", { className: "row" }, el("span", {}, label), input, out),
      input,
      refresh,
    };
  }

  function checkbox(label: string, get: () => boolean, set: (v: boolean) => void) {
    const input = el("input", { type: "checkbox", checked: get() });
    input.addEventListener("change", () => set(input.checked), { signal });
    return el("label", { className: "check" }, input, ` ${label}`);
  }

  const sliders = [
    slider("лаг (RTT)", {
      min: 0,
      max: 400,
      step: 10,
      get: () => net.latency,
      set: (v) => ((net.latency = v), pushNetsim()),
      format: (v) => `${v} мс`,
    }),
    slider("джитер ±", {
      min: 0,
      max: 100,
      step: 5,
      get: () => net.jitter,
      set: (v) => ((net.jitter = v), pushNetsim()),
      format: (v) => `${v} мс`,
    }),
    slider("втрати", {
      min: 0,
      max: 20,
      step: 1,
      get: () => net.drop * 100,
      set: (v) => ((net.drop = v / 100), pushNetsim()),
      format: (v) => `${v}%`,
    }),
    slider("інтерполяція", {
      min: 0,
      max: 300,
      step: 10,
      get: () => session.options.interpMs,
      set: (v) => session.setOptions({ interpMs: v }),
      format: (v) => `${v} мс`,
    }),
    slider("згладжування", {
      min: 0,
      max: 300,
      step: 10,
      get: () => session.options.smoothMs,
      set: (v) => session.setOptions({ smoothMs: v }),
      format: (v) => `${v} мс`,
    }),
    slider("експеримент: шум у integrate", {
      min: 0,
      max: 20,
      step: 1,
      get: () => session.options.chaos * 1000,
      set: (v) => session.setOptions({ chaos: v / 1000 }),
      format: (v) => (v ? `${(v / 10).toFixed(1)}%` : "вимк."),
    }),
  ];

  const panel = el(
    "div",
    { className: "netpanel" },
    el("h3", {}, "Мережа (F2)"),
    ...sliders.map((s) => s.row),
    checkbox(
      "передбачення (prediction)",
      () => session.options.predict,
      (v) => session.setOptions({ predict: v }),
    ),
    checkbox(
      "звірка (reconciliation)",
      () => session.options.reconcile,
      (v) => session.setOptions({ reconcile: v }),
    ),
    el("p", { className: "hint" }, `кодек: ${session.codec.name} (?codec=json — для порівняння)`),
  );
  root.replaceChildren(panel);

  window.addEventListener(
    "keydown",
    (e) => {
      if (e.code !== "F2") return;
      e.preventDefault();
      root.hidden = !root.hidden;
    },
    { signal },
  );

  return function unmount(): void {
    ac.abort();
    clearTimeout(timer);
    root.replaceChildren();
    root.hidden = true;
  };
}
