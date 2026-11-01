// Small typed builders shared by the tests: they exist so that no test needs an `as` cast or
// a fake object to get a branded number or a message of the right shape.

import { seq, tick } from "../src/brand.ts";
import type { InputCommand, Turn } from "../src/input.ts";
import type { InputMessage } from "../src/protocol.ts";

/** 0, 1, 2 → -1, 0, 1: a `number` that is provably a `Turn`. */
export function turnFrom(n: number): Turn {
  return n === 0 ? -1 : n === 1 ? 0 : 1;
}

export function inputMsg(over: Partial<Omit<InputMessage, "type">> = {}): InputMessage {
  return {
    type: "input",
    seq: seq(1),
    tick: tick(0),
    thrust: false,
    turn: 0,
    fire: false,
    ...over,
  };
}

export function inputCmd(over: Partial<InputCommand> = {}): InputCommand {
  const { type: _type, ...rest } = inputMsg(over);
  void _type;
  return rest;
}
