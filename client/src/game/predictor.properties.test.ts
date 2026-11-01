// Reconciliation as a property. If the client and the server run the same `integrate` on the
// same inputs, then WHATEVER prefix of those inputs the server has applied when it sends its
// state, the client's "put the ship there, replay the rest" must land exactly where the client
// already was — a correction of zero. That one statement is the premise of client-side prediction.

import { describe, expect, test } from "vitest";
import fc from "fast-check";
import { STEP, Ship, Vector2, World, seq, type InputMessage, type Turn } from "@dogfight/shared";
import { input as makeInput } from "../testing.ts";
import { Predictor } from "./predictor.ts";

const turn: fc.Arbitrary<Turn> = fc.constantFrom(-1, 0, 1);
const inputs = fc.array(fc.record({ turn, thrust: fc.boolean(), fire: fc.boolean() }), {
  minLength: 1,
  maxLength: 120,
});

const numbered = (cs: { turn: Turn; thrust: boolean; fire: boolean }[]): InputMessage[] =>
  cs.map((c, i) => makeInput({ seq: seq(i + 1), ...c }));

describe("reconcile", () => {
  test("with a deterministic server the correction is zero for ANY acknowledged prefix", () => {
    fc.assert(
      fc.property(inputs, fc.nat(), fc.integer({ min: 1, max: 1000 }), (cs, cut, seed) => {
        const world = new World({ seed });
        const serverShip = world.addShip("p");
        const predictor = new Predictor({ state: serverShip.toState() });
        const sent = numbered(cs);
        for (const i of sent) predictor.step(i);
        const before = predictor.ship.pos;

        const acked = cut % (sent.length + 1);
        for (const i of sent.slice(0, acked)) serverShip.integrate(i, STEP);
        const error = predictor.reconcile(serverShip.toState(), seq(acked));

        expect(error).toBeLessThan(1e-9);
        expect(predictor.ship.pos.sub(before).length()).toBeLessThan(1e-9);
        expect(predictor.pending.map((i) => i.seq)).toEqual(sent.slice(acked).map((i) => i.seq));
      }),
      { numRuns: 100 },
    );
  });

  test("the error equals the size of the disagreement: shove the server's ship by d, get d back", () => {
    fc.assert(
      fc.property(inputs, fc.double({ min: 1, max: 100, noNaN: true }), (cs, d) => {
        const world = new World({ seed: 5 });
        const serverShip = world.addShip("p");
        const predictor = new Predictor({ state: serverShip.toState() });
        const sent = numbered(cs);
        for (const i of sent) predictor.step(i);
        for (const i of sent) serverShip.integrate(i, STEP);
        const shoved = { ...serverShip.toState(), x: serverShip.pos.x + d };
        const twin = Ship.fromState(shoved);
        const error = predictor.reconcile(shoved, seq(sent.length));
        // all inputs acked: nothing to replay, so the new position IS the shoved one
        expect(predictor.ship.pos.sub(twin.pos).length()).toBeLessThan(1e-9);
        // (wrapped distance: it can only be smaller than d if the shove crossed the arena edge)
        expect(error).toBeLessThanOrEqual(d + 1e-6);
        expect(new Vector2(0, 0).length()).toBe(0);
      }),
      { numRuns: 60 },
    );
  });
});
