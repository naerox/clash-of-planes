export function createInput(target = window) {
  const down = new Set();
  const pressed = new Set();
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

  target.addEventListener(
    "keydown",
    (e) => {
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

export function readControls(input) {
  const left = input.isDown("ArrowLeft") || input.isDown("KeyA");
  const right = input.isDown("ArrowRight") || input.isDown("KeyD");
  const thrust = input.isDown("ArrowUp") || input.isDown("KeyW");
  const fire = input.isDown("Space");
  return { turn: (right ? 1 : 0) - (left ? 1 : 0), thrust, fire };
}
