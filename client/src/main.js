import "./style.css";
import { createLoop, rafSchedule } from "./loop.js";
import { createInput, readControls } from "./input.js";
import { setupCanvas } from "./render/canvas.js";
import {
  drawAsteroids,
  drawBackground,
  drawBullets,
  drawEventFeed,
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
import { EventBus } from "./sim/events.js";

import { once } from "./async.js";
import { loadAll, loadManifest } from "./assets/loadAll.js";
import { abortAfterMs, applyFaults, lobbyUrl, readFaults } from "./assets/faults.js";
import { createSpriteSheet } from "./render/sprites.js";
import { createAudio } from "./audio/audio.js";
import { createHudFeed } from "./ui/hudFeed.js";
import { createLoadingScreen } from "./ui/loadingScreen.js";
import { Lobby } from "./lobby/lobby.js";
import { mountLobbyView } from "./lobby/lobbyView.js";
import { Connection, wsUrl } from "./net/connection.js";
import { SERVER_ERRORS, describeClose, msg } from "./net/protocol.js";
import { mountChat } from "./ui/chat.js";

const MANIFEST_URL = "/assets/manifest.json";
const ASSET_BASE = new URL("/assets/", window.location.href);
const NET = { timeoutMs: 3000, attempts: 3 }; // per request: 3 attempts, 3 s each

const view = setupCanvas(document.querySelector("#game"));
const overlay = document.querySelector("#overlay");
const chatRoot = document.querySelector("#chat");
const bus = new EventBus();
const faults = readFaults();

// ---------------------------------------------------------------- 1. loading

let boots = 0;

/** One boot attempt: manifest, then every asset concurrently. Esc aborts all of it. */
async function loadGame(screen) {
  const firstBoot = boots++ === 0;
  const bootId = `${Date.now().toString(36)}-${boots}`;
  const ac = new AbortController();
  const onKey = (e) => {
    if (e.code === "Escape") ac.abort(new DOMException("Скасовано гравцем (Esc)", "AbortError"));
  };
  window.addEventListener("keydown", onKey);
  const autoAbortMs = abortAfterMs(faults, { firstBoot });
  const timer =
    autoAbortMs &&
    setTimeout(
      () =>
        ac.abort(new DOMException(`Скасовано через ${autoAbortMs} мс (?fail=abort)`, "AbortError")),
      autoAbortMs,
    );

  try {
    const manifest = await loadManifest(MANIFEST_URL, { signal: ac.signal, ...NET });
    const t0 = performance.now();
    const result = await loadAll(applyFaults(manifest, faults, { firstBoot, bootId }), {
      signal: ac.signal,
      baseUrl: ASSET_BASE,
      onProgress: screen.update,
      ...NET,
    });
    console.info(`[assets] loadAll: ${(performance.now() - t0).toFixed(0)} ms`, result.failures);
    return { ...result, bootId };
  } finally {
    clearTimeout(timer);
    window.removeEventListener("keydown", onKey);
  }
}

/** Retries until the assets are in. A failed required asset or an abort shows Retry. */
async function loadUntilReady() {
  const screen = createLoadingScreen(view, overlay);
  for (;;) {
    screen.show();
    try {
      const loaded = await loadGame(screen);
      screen.hide();
      return loaded;
    } catch (err) {
      console.error("[assets]", err);
      await screen.fail(err);
    }
  }
}

// ---------------------------------------------------------------- 2. lobby

function runLobbyBackdrop() {
  let id = requestAnimationFrame(function tick() {
    drawBackground(view);
    id = requestAnimationFrame(tick);
  });
  return () => cancelAnimationFrame(id);
}

async function chooseRoom(config, { failures, bootId }, extraNotes = []) {
  const notes = [
    ...extraNotes,
    ...failures.map((f) => `Не завантажено ${f.url.split("?")[0]}: ${f.error}`),
  ];
  if (failures.some((f) => f.id === "sheet" || f.id === "atlas")) {
    notes.push("Граємо з векторною графікою замість спрайтів.");
  }
  if (failures.some((f) => f.id.startsWith("sfx."))) notes.push("Частина звуків вимкнена.");

  const lobby = new Lobby({
    url: lobbyUrl(config.lobby.url, faults, { bootId }),
    intervalMs: config.lobby.pollMs,
    timeoutMs: config.lobby.timeoutMs,
  });
  const stopBackdrop = runLobbyBackdrop();
  const unmount = mountLobbyView(lobby, overlay, { notes, presets: config.presets });
  const joined = once(lobby, "join"); // subscribe before anything can fire it
  lobby.start();
  try {
    return await joined;
  } finally {
    lobby.stop(); // no-op after join() — join already aborted the poll
    unmount();
    stopBackdrop();
  }
}

// ---------------------------------------------------------------- 2b. the real socket

/**
 * Opens the WebSocket, sends `join`, and resolves once the server answers `joined`. The
 * server's own refusal ("room is full", "name is already taken") becomes the error message,
 * so the player lands back in the lobby knowing why. Resolves with the live Connection:
 * from here on it reconnects (and re-joins) by itself.
 */
async function joinRoom({ name, room }) {
  const connection = new Connection({
    url: wsUrl(),
    handshake: () => msg.join(room.id, name),
  });
  let serverSaid = "";
  connection.addEventListener("error", (e) => {
    serverSaid = SERVER_ERRORS[e.detail.code] ?? e.detail.message;
  });

  const ac = new AbortController();
  const timeout = setTimeout(
    () => ac.abort(new Error("Сервер не відповів на вхід у кімнату")),
    8000,
  );
  try {
    connection.connect();
    const joinedMsg = await Promise.race([
      once(connection, "joined", { signal: ac.signal }),
      once(connection, "closed", { signal: ac.signal }).then(({ code }) => {
        throw new Error(serverSaid || `З'єднання закрито: ${describeClose(code)}`);
      }),
    ]);
    return { connection, joined: joinedMsg };
  } catch (err) {
    connection.close();
    throw err;
  } finally {
    clearTimeout(timeout);
    ac.abort(); // drops whichever of the two listeners lost the race
  }
}

/** Lobby → socket, as a loop: a refused join returns the player to the lobby with the reason. */
async function enterRoom(config, loaded) {
  let notes = [];
  for (;;) {
    const choice = await chooseRoom(config, loaded, notes);
    try {
      return { ...choice, ...(await joinRoom(choice)) };
    } catch (err) {
      console.warn("[join]", err);
      notes = [`Не вдалося увійти: ${err.message}`];
    }
  }
}

// ---------------------------------------------------------------- 3. game

/** A spot clear of other asteroids AND of the ship — busier rooms (8 rocks) otherwise
 * spawn one right on top of the player. */
function spotAwayFromShip(world, ship, avoid, minDist = 300) {
  for (let i = 0; i < 20; i++) {
    const pos = world.randomSafeSpot(avoid);
    if (pos.sub(ship.pos).length() > minDist) return pos;
  }
  return new Vector2(avoid, avoid);
}

function spawnAsteroidField(world, ship, arena) {
  const [vMin, vMax] = arena.asteroidSpeed;
  const randomVel = () =>
    Vector2.fromAngle(Math.random() * Math.PI * 2, vMin + Math.random() * (vMax - vMin));
  const spawnRock = () =>
    world.spawn(
      new Asteroid(spotAwayFromShip(world, ship, 120), randomVel(), ASTEROID_PARAMS.maxRadius),
    );
  for (let i = 0; i < arena.asteroids; i++) spawnRock();
  // M4 of Lab 2: homing attached by composition. The room decides how many hunters.
  for (let i = 0; i < arena.hunters; i++) {
    const pos = spotAwayFromShip(world, ship, 120, 450);
    attachHoming(world.spawn(new Asteroid(pos, Vector2.zero, ASTEROID_PARAMS.minRadius)), ship);
  }
  return spawnRock;
}

function netLabel(connection, players) {
  if (connection.state === "closed") return "відключено (перезавантажте сторінку)";
  if (connection.state !== "open") return "перепідключення…";
  return `ok · гравців у кімнаті: ${players}`;
}

function startGame({ name, room, config, audio, connection, joined }) {
  const exp = getExperiment();
  const input = createInput(window);
  const hud = createHudFeed(bus);
  const arena = { ...config.defaultArena, ...room.arena };

  // Lab 4 sends no game state yet (that is Lab 5): the world is still local, and the socket
  // carries only the room roster and chat. The HUD shows how many people are in the room.
  let playersInRoom = joined.players.length;
  connection.addEventListener("roster", (e) => (playersInRoom = e.detail.players.length));

  const world = new World({ events: bus });
  const ship = world.spawn(new Ship(new Vector2(ARENA.width / 2, ARENA.height / 2)));
  const spawnRock = spawnAsteroidField(world, ship, arena);
  world.spawnPickupAt(world.randomSafeSpot(260));

  // Lab 2's `this` demo runs once, on start, if the URL asks for it — see experiments.js.
  const bugMode = getBugDemo();
  if (bugMode) runBugDemo(bugMode, ship, world);

  const minField = Math.min(3, arena.asteroids);

  function simulate(dt) {
    if (input.justPressed("KeyR")) {
      ship.respawnAt(world.randomSafeSpot());
    }

    const controls = readControls(input);
    world.step(dt, controls);
    if (controls.fire) ship.fire(world); // implicit binding, correct `this` (Lab 2)

    if ([...world.ofKind("asteroid")].length < minField && Math.random() < 0.01) spawnRock();

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
    drawHud(view, loop.stats, [
      `mode      ${exp.name}${bugMode ? `  bug:${bugMode}` : ""}`,
      `pilot     ${name} · ${room.name}`,
      `network   ${netLabel(connection, playersInRoom)}`,
      `audio     ${audio.state}`,
      `events    fired ${hud.counts.fired} · hit ${hud.counts.hits} · boom ${hud.counts.explosions}`,
    ]);
    drawShipStatus(view, ship);
    drawEventFeed(view, hud.recent());
  }

  const hooks = { simulate, render };
  const loop = exp.variable
    ? createVariableLoop(hooks)
    : createLoop({ ...hooks, schedule: exp.interval ? intervalSchedule(16) : rafSchedule });

  loop.start();
}

// ---------------------------------------------------------------- boot

async function main() {
  const loaded = await loadUntilReady(); // the game cannot start before this resolves
  const { assets } = loaded;
  const config = assets.get("config");

  view.sprites = createSpriteSheet(assets.get("sheet"), assets.get("atlas"));
  const audio = createAudio({
    bus,
    volume: config.audio?.volume,
    buffers: {
      fire: assets.get("sfx.fire"),
      hit: assets.get("sfx.hit"),
      explode: assets.get("sfx.explode"),
    },
  });

  const session = await enterRoom(config, loaded);
  mountChat(session.connection, chatRoot, { joined: session.joined });
  startGame({ ...session, config, audio });
}

const params = new URLSearchParams(window.location.search);
if (params.has("puzzles")) {
  import("./lab3/puzzles.js").then((m) => m.showPuzzles(overlay));
} else if (params.has("bench")) {
  const latency = params.has("latency") ? faults.latency : 150;
  import("./lab3/bench.js").then((m) => m.showBench(overlay, { latency }));
} else {
  main().catch((err) => {
    // Every expected failure is handled above; this is the last line for real bugs.
    console.error(err);
    overlay.hidden = false;
    overlay.textContent = `Неочікувана помилка: ${err.message}`;
  });
}
