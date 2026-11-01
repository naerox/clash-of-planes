import type { Asteroid } from "./asteroid.ts";
import type { Bullet } from "./bullet.ts";
import type { EntityKind } from "./entity.ts";
import type { Pickup } from "./pickup.ts";
import type { Ship } from "./ship.ts";

/** Everything the World can hold. `kind` is the discriminant: `switch (e.kind)` narrows `e`. */
export type AnyEntity = Ship | Bullet | Asteroid | Pickup;

export type EntityOfKind<K extends EntityKind> = Extract<AnyEntity, { readonly kind: K }>;

/** A type predicate instead of an `as`: after `isKind(e, "ship")` the compiler knows `e` is a Ship. */
export function isKind<K extends EntityKind>(e: AnyEntity, kind: K): e is EntityOfKind<K> {
  return e.kind === kind;
}
