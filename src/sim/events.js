/**
 * The game's event bus: a plain EventTarget, so the simulation can announce what happened
 * ("fired", "hit", "exploded") without importing whoever listens — audio.js and the HUD
 * subscribe from outside. `dispatchEvent` is synchronous: listeners run inside the sim
 * step, before `emit` returns, so they must stay cheap (start a sound, bump a counter).
 * EventTarget and CustomEvent exist in Node too, so the sim stays testable without a DOM.
 */
export class EventBus extends EventTarget {
  emit(type, detail) {
    return this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

export const GAME_EVENTS = Object.freeze({
  FIRED: "fired", // { shooterId, pos, angle }
  HIT: "hit", // { target: "ship" | "asteroid", targetId, pos, damage }
  EXPLODED: "exploded", // { kind: "ship" | "asteroid", id, pos, radius }
});
