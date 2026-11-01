// The networked game, minus the browser: everything that happens between "a frame arrived" /
// "the player pressed a key" and "here is what to draw". No DOM, no WebSocket, no clock of its
// own (all injected) — so it runs in Node, where tests and headless bots drive it.
//
//   step(controls)   every fixed 30 Hz step: number the input, predict it, send it
//   handleBinary / handleMessage   a snapshot or pong came in: buffer it, reconcile, emit events
//   render(now, alpha)             the scene: own ship predicted, everything else interpolated

import {
  CodecError,
  NO_SEQ,
  TICK_ZERO,
  getCodec,
  seq as toSeq,
  shotSeq,
  type AnyCodec,
  type EntityId,
  type InputMessage,
  type JoinedMessage,
  type PingMessage,
  type PongMessage,
  type RosterEntry,
  type ServerMessage,
  type Seq,
  type ShipState,
  type SnapshotMessage,
  type Tick,
} from "@dogfight/shared";
import { emitSimEvent, type GameBus } from "../events.ts";
import type { PlayerControls } from "../input.ts";
import { SnapshotBuffer, interpolateRemote, type RemoteScene } from "./snapshotBuffer.ts";
import { Predictor, SNAP_DISTANCE } from "./predictor.ts";
import { NetStats } from "./netstats.ts";
import type { DrawBullet, DrawShip, Scene } from "./scene.ts";

export interface SessionOptions {
  predict: boolean; // false = the "dumb client" of M1: the ship moves only when a snapshot says so
  reconcile: boolean; // false = prediction without correction (it drifts away from the server)
  smoothMs: number; // the visual correction melts away in about this long
  interpMs: number; // remote entities are drawn this far in the past
  chaos: number; // EXPERIMENT: noise injected into predicted steps (determinism break)
}

export const DEFAULT_OPTIONS: Readonly<SessionOptions> = Object.freeze({
  predict: true,
  reconcile: true,
  smoothMs: 100,
  interpMs: 100,
  chaos: 0,
});

const EMPTY_REMOTE: RemoteScene = { ships: [], bullets: [], asteroids: [], pickups: [] };

export interface SessionConfig {
  /** The server's `joined` message. */
  joined: JoinedMessage;
  /** Transmit now or not at all. */
  sendNow: (data: string | Uint8Array) => boolean;
  now?: () => number;
  /** Receives "fired" / "hit" / "exploded". */
  bus?: GameBus | null;
  options?: Partial<SessionOptions>;
  random?: () => number;
}

export class GameSession {
  readonly sendNow: (data: string | Uint8Array) => boolean;
  readonly now: () => number;
  readonly bus: GameBus | null;
  readonly random: (() => number) | undefined;
  options: SessionOptions;
  readonly codec: AnyCodec;
  readonly stats: NetStats;
  seq = 0; // survives a reconnect: the server only ever accepts seq above what it has seen
  names = new Map<EntityId, string>();
  shipId: EntityId | null = null;
  playerId = "";
  serverTick: Tick = TICK_ZERO;
  buffer = new SnapshotBuffer();
  predictor: Predictor | null = null; // created from the first snapshot that carries our ship
  latestYou: ShipState | null = null;
  ack: Seq = NO_SEQ;
  lastFrameSize = 0;

  constructor({
    joined,
    sendNow,
    now = () => performance.now(),
    bus = null,
    options = {},
    random,
  }: SessionConfig) {
    this.sendNow = sendNow;
    this.now = now;
    this.bus = bus;
    this.random = random;
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.codec = getCodec(joined.codec);
    this.stats = new NetStats({ now });
    this.#bind(joined);
  }

  #bind(joined: JoinedMessage): void {
    this.shipId = joined.shipId;
    this.playerId = joined.you;
    this.serverTick = joined.tick;
    this.buffer = new SnapshotBuffer();
    this.predictor = null;
    this.latestYou = null;
    this.ack = NO_SEQ;
    this.lastFrameSize = 0;
    this.setPlayers(joined.players);
  }

  /** We were (re)admitted to the room: a NEW ship. Everything predicted about the old one is void. */
  rejoin(joined: JoinedMessage): void {
    this.#bind(joined);
  }

  setPlayers(players: readonly RosterEntry[]): void {
    this.names = new Map();
    for (const p of players) if (p.shipId !== null) this.names.set(p.shipId, p.name);
  }

  setOptions(patch: Partial<SessionOptions>): void {
    const before = this.options;
    this.options = { ...before, ...patch };
    if (patch.predict !== undefined && patch.predict !== before.predict) this.predictor = null; // re-sync from the next snapshot
    if (patch.chaos !== undefined && this.predictor) this.predictor.chaos = patch.chaos;
  }

  // ── sending ────────────────────────────────────────────────────────────────────────

  /** One fixed simulation step: build the input, predict it, send it. */
  step(controls: PlayerControls): InputMessage {
    const input: InputMessage = {
      type: "input",
      seq: toSeq(++this.seq),
      tick: this.serverTick,
      thrust: controls.thrust,
      turn: controls.turn,
      fire: controls.fire,
    };
    if (this.options.predict && this.predictor) {
      const shot = this.predictor.step(input);
      if (shot && this.shipId !== null)
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

  ping(): void {
    this.#send({ type: "ping", t: Math.floor(this.now()) >>> 0 });
  }

  #send(message: InputMessage | PingMessage): void {
    const data = this.codec.encode(message);
    if (this.sendNow(data)) this.stats.onSend(data.length);
  }

  // ── receiving ──────────────────────────────────────────────────────────────────────

  /** The Connection reports every frame's size first (so a snapshot can be attributed its bytes). */
  noteFrame(size: number): void {
    this.lastFrameSize = size;
    this.stats.onFrame(size);
  }

  handleBinary(arrayBuffer: ArrayBuffer): void {
    const codec = this.codec;
    if (!codec.binary) {
      this.stats.badFrames++; // a binary frame on a JSON connection: not ours to decode
      return;
    }
    let message;
    try {
      message = codec.decode(new Uint8Array(arrayBuffer));
    } catch (err: unknown) {
      if (!(err instanceof CodecError)) throw err;
      this.stats.badFrames++;
      return;
    }
    if (message.type === "snapshot" || message.type === "pong") this.#dispatch(message);
  }

  /** JSON mode: the Connection has already parsed (and checked) the text frame. */
  handleMessage(message: ServerMessage): void {
    if (message.type === "snapshot" || message.type === "pong") this.#dispatch(message);
  }

  #dispatch(message: SnapshotMessage | PongMessage): void {
    switch (message.type) {
      case "snapshot":
        return this.#onSnapshot(message);
      case "pong":
        return this.stats.onPong(Math.max(0, this.now() - message.t));
      default: {
        const unreachable: never = message;
        return unreachable;
      }
    }
  }

  #onSnapshot(snap: SnapshotMessage): void {
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
        emitSimEvent(this.bus, event);
      }
    }
  }

  // ── drawing ────────────────────────────────────────────────────────────────────────

  /**
   * `nowMs`: client clock (same one as `now`); `alpha`: 0..1 progress between the last two fixed
   * steps (the loop's accumulator); `frameMs`: time since the previous render, for the
   * correction smoothing.
   */
  render(nowMs: number, alpha: number, frameMs = 16.7): Scene {
    const { predict, smoothMs, interpMs } = this.options;
    const sample = this.buffer.sample(this.buffer.renderTick(nowMs, interpMs));
    this.stats.onRender(sample ? sample.starved : true);
    const remote = sample ? interpolateRemote(sample) : EMPTY_REMOTE;

    const ships: DrawShip[] = remote.ships.map((s) => ({
      ...s,
      isMe: false,
      name: this.names.get(s.id) ?? "?",
    }));
    let me: DrawShip | null = null;
    let bullets: DrawBullet[] = [...remote.bullets];
    const shipId = this.shipId;

    if (shipId !== null && predict && this.predictor) {
      const p = this.predictor;
      p.decay(frameMs, smoothMs);
      const v = p.visual(alpha);
      const ship = p.ship;
      me = {
        id: shipId,
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
        name: this.names.get(shipId) ?? "me",
      };
      // our own bullets come from prediction (instantly, and without the interpolation delay)
      bullets = remote.bullets.filter((b) => b.owner !== shipId);
      for (const b of p.bullets) {
        const prev = b.bullet.prevPos;
        const pos = b.bullet.pos;
        bullets.push({
          id: b.id,
          owner: shipId,
          x: prev.x + (pos.x - prev.x) * alpha,
          y: prev.y + (pos.y - prev.y) * alpha,
          seq: shotSeq(b.bullet.seq),
        });
      }
    } else if (shipId !== null && this.latestYou) {
      // the "dumb client": our ship is wherever the newest snapshot put it
      const y = this.latestYou;
      me = {
        id: shipId,
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
        name: this.names.get(shipId) ?? "me",
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
