// The networked game, minus the browser: everything that happens between "a frame arrived" /
// "the player pressed a key" and "here is what to draw". No DOM, no WebSocket, no clock of its
// own (all injected) — so it runs in Node, where tests and headless bots drive it.
//
//   step(controls)   every fixed 30 Hz step: number the input, predict it, send it
//   handleBinary / handleMessage   a snapshot or pong came in: buffer it, reconcile, emit events
//   render(now, alpha)             the scene: own ship predicted, everything else interpolated

import { CodecError, getCodec } from "@dogfight/shared";
import { SnapshotBuffer, interpolateRemote } from "./snapshotBuffer.js";
import { Predictor, SNAP_DISTANCE } from "./predictor.js";
import { NetStats } from "./netstats.js";

export const DEFAULT_OPTIONS = Object.freeze({
  predict: true, // false = the "dumb client" of M1: the ship moves only when a snapshot says so
  reconcile: true, // false = prediction without correction (it drifts away from the server)
  smoothMs: 100, // the visual correction melts away in about this long
  interpMs: 100, // remote entities are drawn this far in the past
  chaos: 0, // EXPERIMENT: noise injected into predicted steps (determinism break)
});

export class GameSession {
  /**
   * @param {object} opts
   * @param {object} opts.joined   the server's `joined` message
   * @param {(data: string|Uint8Array) => boolean} opts.sendNow  transmit now or not at all
   * @param {() => number} [opts.now]
   * @param {EventTarget & {emit: Function}} [opts.bus]  receives "fired" / "hit" / "exploded"
   */
  constructor({
    joined,
    sendNow,
    now = () => performance.now(),
    bus = null,
    options = {},
    random,
  }) {
    this.sendNow = sendNow;
    this.now = now;
    this.bus = bus;
    this.random = random;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.codec = getCodec(joined.codec);
    this.stats = new NetStats({ now });
    this.seq = 0; // survives a reconnect: the server only ever accepts seq above what it has seen
    this.names = new Map();
    this.#bind(joined);
  }

  #bind(joined) {
    this.shipId = joined.shipId;
    this.playerId = joined.you;
    this.serverTick = joined.tick ?? 0;
    this.buffer = new SnapshotBuffer();
    this.predictor = null; // created from the first snapshot that carries our ship
    this.latestYou = null;
    this.ack = 0;
    this.lastFrameSize = 0;
    this.setPlayers(joined.players ?? []);
  }

  /** We were (re)admitted to the room: a NEW ship. Everything predicted about the old one is void. */
  rejoin(joined) {
    this.#bind(joined);
  }

  setPlayers(players) {
    this.names = new Map(players.map((p) => [p.shipId, p.name]));
  }

  setOptions(patch) {
    const before = this.options;
    this.options = { ...before, ...patch };
    if (patch.predict !== undefined && patch.predict !== before.predict) this.predictor = null; // re-sync from the next snapshot
    if (patch.chaos !== undefined && this.predictor) this.predictor.chaos = patch.chaos;
  }

  // ── sending ────────────────────────────────────────────────────────────────────────

  /** One fixed simulation step: build the input, predict it, send it. */
  step(controls) {
    const input = {
      type: "input",
      seq: ++this.seq,
      tick: this.serverTick,
      thrust: Boolean(controls.thrust),
      turn: controls.turn,
      fire: Boolean(controls.fire),
    };
    if (this.options.predict && this.predictor) {
      const shot = this.predictor.step(input);
      if (shot)
        this.bus?.emit("fired", {
          type: "fired",
          shooterId: this.shipId,
          x: shot.pos.x,
          y: shot.pos.y,
        });
      this.stats.pending = this.predictor.pending.length;
    }
    this.#send(input);
    return input;
  }

  ping() {
    this.#send({ type: "ping", t: Math.floor(this.now()) >>> 0 });
  }

  #send(message) {
    const data = this.codec.encode(message);
    if (this.sendNow(data)) this.stats.onSend(data.length);
  }

  // ── receiving ──────────────────────────────────────────────────────────────────────

  /** The Connection reports every frame's size first (so a snapshot can be attributed its bytes). */
  noteFrame(size) {
    this.lastFrameSize = size;
    this.stats.onFrame(size);
  }

  handleBinary(arrayBuffer) {
    let message;
    try {
      message = this.codec.decode(new Uint8Array(arrayBuffer));
    } catch (err) {
      if (!(err instanceof CodecError)) throw err;
      this.stats.badFrames++;
      return;
    }
    this.#dispatch(message);
  }

  /** JSON mode: the Connection has already parsed the text frame. */
  handleMessage(message) {
    if (message.type !== "snapshot" && message.type !== "pong") return;
    const { v, ...rest } = message;
    void v;
    this.#dispatch(rest);
  }

  #dispatch(message) {
    if (message.type === "snapshot") this.#onSnapshot(message);
    else if (message.type === "pong") this.stats.onPong(Math.max(0, this.now() - message.t));
  }

  #onSnapshot(snap) {
    if (!this.buffer.push(snap, this.now())) return; // older than one we already have
    this.serverTick = snap.tick;
    this.stats.onSnapshot(snap, this.lastFrameSize);
    this.ack = snap.ack;

    if (snap.you) {
      this.latestYou = snap.you;
      const { predict, reconcile } = this.options;
      if (!this.predictor && predict) {
        this.predictor = new Predictor({
          state: snap.you,
          chaos: this.options.chaos,
          random: this.random,
        });
      } else if (this.predictor && predict) {
        if (reconcile) {
          const error = this.predictor.reconcile(snap.you, snap.ack, snap.bullets);
          // a respawn is the server MOVING our ship, not our prediction being wrong: count it
          // apart, or one death would drown every other number on the netgraph
          if (error > SNAP_DISTANCE) this.stats.onTeleport();
          else this.stats.onCorrection(error);
        } else {
          // prediction left to itself: only forget what the server has acknowledged
          this.predictor.pending = this.predictor.pending.filter((i) => i.seq > snap.ack);
        }
        this.stats.pending = this.predictor.pending.length;
      }
    }

    if (this.bus) {
      for (const event of snap.events) {
        // our own shots were announced when we fired them; the server's echo would double the sound
        if (event.type === "fired" && this.options.predict && event.shooterId === this.shipId)
          continue;
        this.bus.emit(event.type, event);
      }
    }
  }

  // ── drawing ────────────────────────────────────────────────────────────────────────

  /**
   * @param {number} nowMs   client clock (same one as `now`)
   * @param {number} alpha   0..1 progress between the last two fixed steps (the loop's accumulator)
   * @param {number} frameMs time since the previous render, for the correction smoothing
   */
  render(nowMs, alpha, frameMs = 16.7) {
    const { predict, smoothMs, interpMs } = this.options;
    const sample = this.buffer.sample(this.buffer.renderTick(nowMs, interpMs));
    this.stats.onRender(sample ? sample.starved : true);
    const remote = sample
      ? interpolateRemote(sample)
      : { ships: [], bullets: [], asteroids: [], pickups: [] };

    const ships = remote.ships.map((s) => ({
      ...s,
      isMe: false,
      name: this.names.get(s.id) ?? "?",
    }));
    let me = null;
    let bullets = remote.bullets;

    if (predict && this.predictor) {
      const p = this.predictor;
      p.decay(frameMs, smoothMs);
      const v = p.visual(alpha);
      const ship = p.ship;
      me = {
        id: this.shipId,
        x: v.x,
        y: v.y,
        angle: v.angle,
        thrusting: ship.thrusting,
        dead: ship.isDead,
        hp: ship.hp,
        score: ship.score,
        respawn: ship.respawnTimer,
        rapid: ship.rapidTimer > 0,
        isMe: true,
        name: this.names.get(this.shipId) ?? "me",
      };
      // our own bullets come from prediction (instantly, and without the interpolation delay)
      bullets = remote.bullets.filter((b) => b.owner !== this.shipId);
      for (const b of p.bullets) {
        const prev = b.prevPos ?? b.pos;
        bullets.push({
          id: b.id,
          owner: this.shipId,
          x: prev.x + (b.pos.x - prev.x) * alpha,
          y: prev.y + (b.pos.y - prev.y) * alpha,
          seq: b.seq,
        });
      }
    } else if (this.latestYou) {
      // the "dumb client": our ship is wherever the newest snapshot put it
      const y = this.latestYou;
      me = {
        id: this.shipId,
        x: y.x,
        y: y.y,
        angle: y.angle,
        thrusting: y.thrusting,
        dead: y.respawn > 0,
        hp: y.hp,
        score: y.score,
        respawn: y.respawn,
        rapid: y.rapid > 0,
        isMe: true,
        name: this.names.get(this.shipId) ?? "me",
      };
    }
    if (me && !me.dead) ships.push(me);

    return {
      ships,
      me,
      bullets,
      asteroids: remote.asteroids,
      pickups: remote.pickups,
      starved: sample?.starved ?? true,
    };
  }

  /** Everything worth looking at while debugging or measuring (exposed as `window.__net`). */
  debug() {
    const sample = this.buffer.latest;
    return {
      options: { ...this.options },
      codec: this.codec.name,
      stats: this.stats.report(),
      seq: this.seq,
      ack: this.ack,
      serverTick: this.serverTick,
      pending: this.predictor?.pending.length ?? 0,
      predicted: this.predictor?.ship.toState() ?? null,
      server: this.latestYou,
      clockOffsetMs: this.buffer.offsetMs,
      bufferedSnapshots: this.buffer.size,
      latestTick: sample?.tick ?? 0,
    };
  }
}
