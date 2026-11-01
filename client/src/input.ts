import type { Controls, Turn } from "@dogfight/shared";

export interface InputState {
  isDown(code: string): boolean;
  justPressed(code: string): boolean;
  endStep(): void;
  dispose(): void;
}

/** What the keyboard says right now: the ship's controls plus the fire button. */
export interface PlayerControls extends Controls {
  readonly fire: boolean;
}

export function createInput(target: Pick<Window, "addEventListener"> = window): InputState {
  const down = new Set<string>();
  const pressed = new Set<string>();
  const ac = new AbortController();
  const opts = { signal: ac.signal };

  const GAME_KEYS = new Set([
    "ArrowUp",
    "ArrowDown",
    "ArrowLeft",
    "ArrowRight",
    "Space",
    "KeyW",
    "KeyA",
    "KeyS",
    "KeyD",
  ]);

  // Typing in the chat box (or the lobby form) must not steer the ship, and Space must still
  // type a space — so key *presses* from text fields are not ours. Key *releases* always are:
  // a key held down while focus moved into a field must not stay "down" forever.
  const isTyping = (e: KeyboardEvent): boolean =>
    e.target instanceof Element && ["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName);

  target.addEventListener(
    "keydown",
    (e) => {
      if (isTyping(e)) return;
      if (GAME_KEYS.has(e.code)) e.preventDefault();
      if (e.repeat) return;
      down.add(e.code);
      pressed.add(e.code);
    },
    opts,
  );
  target.addEventListener("keyup", (e) => down.delete(e.code), opts);
  target.addEventListener("blur", () => down.clear(), opts);

  return {
    isDown: (code) => down.has(code),
    justPressed: (code) => pressed.has(code),
    endStep: () => pressed.clear(),
    dispose: () => ac.abort(),
  };
}

export function readControls(input: Pick<InputState, "isDown">): PlayerControls {
  const left = input.isDown("ArrowLeft") || input.isDown("KeyA");
  const right = input.isDown("ArrowRight") || input.isDown("KeyD");
  const thrust = input.isDown("ArrowUp") || input.isDown("KeyW");
  const fire = input.isDown("Space");
  const turn: Turn = right === left ? 0 : right ? 1 : -1;
  return { turn, thrust, fire };
}
