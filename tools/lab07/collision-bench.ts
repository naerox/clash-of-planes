// Naive O(n²) vs spatial hash on the same crowded world: microseconds per full collision pass.
//   node tools/lab07/collision-bench.ts
import { performance } from "node:perf_hooks";
import {
  ARENA,
  HASH_MIN_ENTITIES,
  Vector2,
  World,
  findCollisionsHashed,
  findCollisionsNaive,
  seq,
} from "@dogfight/shared";

function world(ships: number) {
  const w = new World({ seed: 7, arena: { asteroids: 12, asteroidSpeed: [40, 80] } }).populate();
  for (let i = 0; i < ships; i++) w.addShip(`s${i}`).fire(w, seq(i + 1));
  let s = 12345;
  const rnd = (n: number): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return (s / 0x7fffffff) * n;
  };
  for (const e of w) e.pos = new Vector2(rnd(ARENA.width), rnd(ARENA.height));
  return [...w].filter((e) => e.alive);
}

const time = (run: () => number, rounds: number): number => {
  for (let i = 0; i < Math.ceil(rounds / 5); i++) run(); // warm-up for the JIT
  const t0 = performance.now();
  for (let i = 0; i < rounds; i++) run();
  return ((performance.now() - t0) / rounds) * 1000;
};

console.log(`threshold in the game: ${HASH_MIN_ENTITIES} entities`);
console.log("entities |  naive µs | hashed µs | speed-up");
for (const ships of [4, 10, 20, 40, 80, 160, 320]) {
  const es = world(ships);
  const rounds = es.length > 200 ? 200 : 2000;
  const naive = time(() => [...findCollisionsNaive(es)].length, rounds);
  const hashed = time(() => [...findCollisionsHashed(es)].length, rounds);
  console.log(
    `${String(es.length).padStart(8)} | ${naive.toFixed(1).padStart(9)} | ${hashed.toFixed(1).padStart(9)} | ${(naive / hashed).toFixed(1)}×`,
  );
}
