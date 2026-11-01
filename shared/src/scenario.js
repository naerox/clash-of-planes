// A fixed, scripted match used to PROVE determinism: three ships fly and shoot for 1000 steps,
// driven by inputs from a seeded stream, in a world with rocks, hunters and pickups. The final
// state is reduced to a hash (hash.js). The same scenario runs in Node (a test), and in Chrome
// (the `/?determinism` page): if the two hashes are equal, the browser and the server really do
// compute the same game — which is the premise of client-side prediction.

import { STEP } from "./constants.js";
import { hashWorld } from "./hash.js";
import { Rng } from "./sim/rng.js";
import { World } from "./sim/world.js";

/**
 * Recorded once, in Node 22 (V8). If the simulation is changed on purpose this value changes
 * with it — update it, and re-check it in a browser. If it changes by accident, a test fails.
 */
export const EXPECTED_HASH = "70a8975d";

/** @param {object} [opts] @param {(world: World) => void} [opts.before] hook, e.g. to inject noise */
export function runScenario({ seed = 20260101, steps = 1000, before } = {}) {
  const world = new World({
    seed,
    arena: { asteroids: 6, hunters: 2, asteroidSpeed: [40, 100] },
  }).populate();
  const ships = [world.addShip("a"), world.addShip("b"), world.addShip("c")];
  const script = new Rng(777); // the INPUT generator: a different stream from the world's
  before?.(world);
  for (let step = 1; step <= steps; step++) {
    ships.forEach((ship, i) => {
      world.applyInput(
        ship,
        {
          seq: step,
          tick: world.tick,
          thrust: script.chance(0.7),
          turn: script.int(3) - 1,
          fire: script.chance(i === 0 ? 0.5 : 0.2),
        },
        STEP,
      );
    });
    world.step(STEP);
  }
  return world;
}

export const scenarioHash = (opts) => hashWorld(runScenario(opts));
