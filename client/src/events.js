/**
 * The client's event bus: a plain EventTarget on which the game announces what happened
 * ("fired", "hit", "exploded") without importing whoever listens — audio.js, the HUD and the
 * particle effects subscribe from outside.
 *
 * Lab 5: the simulation runs on the server, so these events arrive INSIDE snapshots (plain
 * objects in `snapshot.events`) and the network layer re-emits them here; the local player's
 * own shots are announced at once, by prediction. `dispatchEvent` is synchronous: listeners
 * must stay cheap (start a sound, bump a counter).
 */
export class EventBus extends EventTarget {
  emit(type, detail) {
    return this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

export const GAME_EVENTS = Object.freeze({
  FIRED: "fired", // { type, shooterId, x, y }
  HIT: "hit", // { type, target: "ship" | "asteroid", targetId, x, y, damage }
  EXPLODED: "exploded", // { type, kind: "ship" | "asteroid", id, x, y, radius }
});
