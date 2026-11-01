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
import { drawNetgraph } from "./render/netgraph.js";
import { ParticleSystem } from "./render/particles.js";
import {
  busyWait,
  getBugDemo,
  getExperiment,
  intervalSchedule,
  runBugDemo,
} from "./experiments.js";

import { STEP, World } from "@dogfight/shared";
import { EventBus } from "./events.js";
import { GameSession } from "./game/session.js";

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
import { mountNetPanel } from "./ui/netpanel.js";

const MANIFEST_URL = "/assets/manifest.json";
const ASSET_BASE = new URL("/assets/", window.location.href);
const NET = { timeoutMs: 3000, attempts: 3 }; // per request: 3 attempts, 3 s each

const query = new URLSearchParams(window.location.search);
const view = setupCanvas(document.querySelector("#game"));
const overlay = document.querySelector("#overlay");
const chatRoot = document.querySelector("#chat");
const netPanelRoot = document.querySelector("#netpanel");
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

/** `?lag=100&jitter=30&drop=0.02` — handed to the server, which delays/loses OUR traffic on purpose. */
function netQuery() {
  const out = new URLSearchParams();
  for (const key of ["lag", "jitter", "drop"]) if (query.has(key)) out.set(key, query.get(key));
  return out.toString();
}

/** Netcode options from the URL, so a demo can be reproduced by sharing a link. */
function netOptions() {
  const flag = (key, fallback) => (query.has(key) ? query.get(key) !== "0" : fallback);
  const num = (key, fallback) => (query.has(key) ? Number(query.get(key)) : fallback);
  return {
    predict: flag("predict", true),
    reconcile: flag("reconcile", true),
    smoothMs: num("smooth", 100),
    interpMs: num("interp", 100),
    chaos: num("chaos", 0),
  };
}

/**
 * Opens the WebSocket, sends `join`, and resolves once the server answers `joined`. The
 * server's own refusal ("room is full", "name is already taken") becomes the error message,
 * so the player lands back in the lobby knowing why. Resolves with the live Connection:
 * from here on it reconnects (and re-joins) by itself.
 */
async function joinRoom({ name, room }) {
  const connection = new Connection({
    url: wsUrl("/ws", location, netQuery()),
    handshake: () => msg.join(room.id, name, query.get("codec") === "json" ? "json" : "binary"),
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

function netLabel(connection, session) {
  if (connection.state === "closed") return "відключено (перезавантажте сторінку)";
  if (connection.state !== "open") return "перепідключення…";
  const r = session.stats.report();
  return `ok · RTT ${r.rttMs.toFixed(0)} мс · ${session.codec.name}`;
}

/**
 * The game is no longer simulated here. We send our CONTROLS (30 times a second), predict our own
 * ship with the shared code, and draw what the server's snapshots say about everything else.
 */
function startGame({ name, room, audio, connection, joined }) {
  const exp = getExperiment();
  const input = createInput(window);
  const hud = createHudFeed(bus);
  const particles = new ParticleSystem();
  let showNetgraph = true;

  const session = new GameSession({
    joined,
    sendNow: (data) => connection.sendNow(data),
    bus,
    options: netOptions(),
  });
  connection.addEventListener("frame", (e) => session.noteFrame(e.detail.size));
  connection.addEventListener("binary", (e) => session.handleBinary(e.detail));
  connection.addEventListener("snapshot", (e) => session.handleMessage(e.detail)); // JSON codec
  connection.addEventListener("pong", (e) => session.handleMessage(e.detail));
  connection.addEventListener("roster", (e) => session.setPlayers(e.detail.players));
  connection.addEventListener("joined", (e) => session.rejoin(e.detail)); // after a reconnect
  const pinger = setInterval(() => session.ping(), 500);
  connection.addEventListener("closed", () => clearInterval(pinger));

  bus.addEventListener("exploded", (e) =>
    particles.burst(e.detail.x, e.detail.y, e.detail.kind === "ship" ? 26 : 10),
  );

  mountNetPanel(session, connection, netPanelRoot, {
    initial: {
      latency: Number(query.get("lag")) || 0,
      jitter: Number(query.get("jitter")) || 0,
      drop: Number(query.get("drop")) || 0,
    },
  });
  window.addEventListener("keydown", (e) => {
    if (e.code !== "F3") return;
    e.preventDefault();
    showNetgraph = !showNetgraph;
  });
  // a handle for measuring and debugging from the console / headless tests
  window.__net = { session, debug: () => session.debug(), connection, lastScene: null };

  // Lab 2's `this` demo runs once, on start, if the URL asks for it — see experiments.js.
  const bugMode = getBugDemo();
  if (bugMode) {
    const demoWorld = new World({ seed: 1 });
    runBugDemo(bugMode, demoWorld.addShip("demo"), demoWorld);
  }

  function simulate() {
    session.step(readControls(input)); // one fixed 30 Hz step: number it, predict it, send it
    input.endStep();
  }

  let frameNo = 0;
  let lastRender = performance.now();
  function render(alpha) {
    frameNo++;
    if (exp.block && frameNo % 60 === 0) busyWait(100); // Lab 1 experiment 1, unchanged

    const now = performance.now();
    const frameMs = Math.min(100, now - lastRender);
    lastRender = now;
    const scene = session.render(now, alpha, frameMs);
    window.__net.lastScene = scene;
    particles.update(frameMs / 1000);

    drawBackground(view);
    drawAsteroids(view, scene.asteroids);
    drawPickups(view, scene.pickups);
    drawBullets(view, scene.bullets);
    drawParticles(view, particles.list);
    for (const ship of scene.ships) drawShip(view, ship);
    drawHud(view, loop.stats, [
      `mode      ${exp.name}${bugMode ? `  bug:${bugMode}` : ""}${exp.variable ? " (змінний крок не має сенсу онлайн)" : ""}`,
      `pilot     ${name} · ${room.name}`,
      `network   ${netLabel(connection, session)}`,
      `audio     ${audio.state}`,
      `events    fired ${hud.counts.fired} · hit ${hud.counts.hits} · boom ${hud.counts.explosions}`,
    ]);
    drawShipStatus(view, scene.me);
    drawEventFeed(view, hud.recent());
    if (showNetgraph) drawNetgraph(view, session);
  }

  // The loop is Lab 1's: a fixed step with an accumulator and render interpolation. What is new
  // is the step: 1/30 s — the same dt the server uses — and what `simulate` does with it.
  // (`?exp=variable` is a Lab 1 experiment about variable steps; online it would send inputs at
  // the frame rate, so it falls back to the fixed loop.)
  const hooks = { simulate, render };
  const loop = createLoop({
    step: STEP,
    ...hooks,
    schedule: exp.interval ? intervalSchedule(16) : rafSchedule,
  });
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

const params = query;
if (params.has("puzzles")) {
  import("./lab3/puzzles.js").then((m) => m.showPuzzles(overlay));
} else if (params.has("determinism")) {
  import("./lab5/determinism.js").then((m) => m.showDeterminism(overlay));
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
