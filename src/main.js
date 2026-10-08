import "./style.css";
import { createLoop, rafSchedule } from "./loop.js";
import { createInput, readControls } from "./input.js";
import { setupCanvas } from "./render/canvas.js";
import {
  drawAsteroids,
  drawBackground,
  drawBullets,
  drawHud,
  drawParticles,
  drawPickups,
  drawShip,
  drawShipStatus,
} from "./render/draw.js";
import {
  busyWait,
  createVariableLoop,
  getBugDemo,
  getExperiment,
  intervalSchedule,
  runBugDemo,
} from "./experiments.js";

import { World } from "./sim/world.js";
import { Ship } from "./sim/ship.js";
import { Asteroid, ASTEROID_PARAMS } from "./sim/asteroid.js";
import { Vector2 } from "./sim/vector.js";
import { ARENA } from "./sim/arena.js";
import { attachHoming } from "./sim/homing.js";

const exp = getExperiment();
const view = setupCanvas(document.querySelector("#game"));
const input = createInput(window);

const world = new World();
const ship = world.spawn(new Ship(new Vector2(ARENA.width / 2, ARENA.height / 2)));

// A small starter field: a few drifting asteroids, one of which hunts the ship (M4:
// homing attached to an asteroid via composition, not a subclass).
function spawnAsteroidField() {
  for (let i = 0; i < 4; i++) {
    const pos = world.randomSafeSpot(220);
    const vel = Vector2.fromAngle(Math.random() * Math.PI * 2, 40 + Math.random() * 60);
    world.spawn(new Asteroid(pos, vel, ASTEROID_PARAMS.maxRadius));
  }
  const hunter = world.spawn(
    new Asteroid(world.randomSafeSpot(300), Vector2.zero, ASTEROID_PARAMS.minRadius),
  );
  attachHoming(hunter, ship);
}
spawnAsteroidField();
world.spawnPickupAt(world.randomSafeSpot(260));

// Lab 2's `this` demo runs once, on load, if the URL asks for it — see experiments.js.
const bugMode = getBugDemo();
if (bugMode) runBugDemo(bugMode, ship, world);

function simulate(dt) {
  if (input.justPressed("KeyR")) {
    ship.respawnAt(world.randomSafeSpot());
  }

  const controls = readControls(input);
  world.step(dt, controls);
  if (controls.fire) ship.fire(world); // called as `ship.fire(...)` — implicit binding, correct `this`

  // Keep a light asteroid field alive so M4's homing rock and pickups stay demonstrable.
  if ([...world.ofKind("asteroid")].length < 3 && Math.random() < 0.01) {
    world.spawn(
      new Asteroid(
        world.randomSafeSpot(220),
        Vector2.fromAngle(Math.random() * Math.PI * 2, 40 + Math.random() * 60),
        ASTEROID_PARAMS.maxRadius,
      ),
    );
  }

  input.endStep();
}

let frameNo = 0;
function render(alpha) {
  frameNo++;
  if (exp.block && frameNo % 60 === 0) busyWait(100); // Lab 1 experiment 1, unchanged

  drawBackground(view);
  drawAsteroids(view, world, alpha);
  drawPickups(view, world, alpha);
  drawBullets(view, world, alpha);
  drawParticles(view, world, alpha);
  drawShip(view, ship, alpha);
  drawHud(view, loop.stats, [`mode      ${exp.name}${bugMode ? `  bug:${bugMode}` : ""}`]);
  drawShipStatus(view, ship);
}

const hooks = { simulate, render };
const loop = exp.variable
  ? createVariableLoop(hooks)
  : createLoop({ ...hooks, schedule: exp.interval ? intervalSchedule(16) : rafSchedule });

loop.start();
