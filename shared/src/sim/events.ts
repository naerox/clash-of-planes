import type { EntityId } from "../brand.ts";

// What happened during a tick. A discriminated union on `type`: every `switch (e.type)` in the
// code base ends in a `default` branch that assigns the value to `never`, so a fourth event
// type makes the compiler list every place that has to learn about it.

export type HitTarget = "ship" | "asteroid";

export interface FiredEvent {
  readonly type: "fired";
  readonly shooterId: EntityId;
  readonly x: number;
  readonly y: number;
}

export interface HitEvent {
  readonly type: "hit";
  readonly target: HitTarget;
  readonly targetId: EntityId;
  readonly x: number;
  readonly y: number;
  readonly damage: number;
}

export interface ExplodedEvent {
  readonly type: "exploded";
  readonly kind: HitTarget;
  readonly id: EntityId;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

export type SimEvent = FiredEvent | HitEvent | ExplodedEvent;
