// Branded numbers. At runtime an entity id, a tick and an input sequence number are all just
// numbers; to the compiler they are three different types, so `world.get(tick)` or
// `ack = entityId` stop compiling. The brand exists only in the type system (the `unique symbol`
// below is never created), so it costs nothing at runtime.

declare const brandTag: unique symbol;

export type Brand<T, Name extends string> = T & { readonly [brandTag]: Name };

export type EntityId = Brand<number, "EntityId">; // 1..65535, assigned by World.spawn
export type Tick = Brand<number, "Tick">; // a simulation step counter
export type Seq = Brand<number, "Seq">; // the client's input counter; 0 means "none yet"
export type ShotSeq = Brand<number, "ShotSeq">; // the low 16 bits of a Seq, as bullets carry it

/**
 * The only place in the code base where a plain number is turned into a branded one: every
 * other brand constructor goes through here, so the whole protocol needs a single `as`.
 */
function brand<T extends Brand<number, string>>(n: number): T {
  return n as T; // a brand has no runtime form: this changes the type and nothing else
}

export const entityId = (n: number): EntityId => brand<EntityId>(n);
export const tick = (n: number): Tick => brand<Tick>(n);
export const seq = (n: number): Seq => brand<Seq>(n);
/** Keeps the low 16 bits: that is all a bullet carries on the wire. */
export const shotSeq = (n: number): ShotSeq => brand<ShotSeq>(n & 0xffff);

export const NO_SEQ = seq(0);
export const TICK_ZERO = tick(0);
