// Five microtask/task ordering puzzles (README, Lab 3). Open `/?puzzles` — each one runs
// in the real browser and prints its actual output next to the expected one. `log` stands
// in for console.log so the output can be collected.

export const PUZZLES = [
  {
    title: "1. await, then, queueMicrotask, setTimeout",
    expected: ["A", "D", "G", "C", "E", "F", "B"],
    run(log) {
      log("A");
      setTimeout(() => log("B"), 0);
      Promise.resolve().then(() => log("C"));
      (async () => {
        log("D");
        await null;
        log("E");
      })();
      queueMicrotask(() => log("F"));
      log("G");
    },
  },
  {
    title: "2. setTimeout всередині .then",
    expected: ["P1", "P2", "T1", "T3", "T2"],
    run(log) {
      setTimeout(() => log("T1"), 0);
      Promise.resolve()
        .then(() => {
          log("P1");
          setTimeout(() => log("T2"), 0);
        })
        .then(() => log("P2"));
      setTimeout(() => log("T3"), 0);
    },
  },
  {
    title: "3. return promise vs return await",
    expected: ["t1", "await", "t2", "return", "t3"],
    run(log) {
      async function viaReturn() {
        return Promise.resolve("return");
      }
      async function viaAwait() {
        return await Promise.resolve("await");
      }
      viaReturn().then(log);
      viaAwait().then(log);
      Promise.resolve()
        .then(() => log("t1"))
        .then(() => log("t2"))
        .then(() => log("t3"));
    },
  },
  {
    title: "4. requestAnimationFrame, мікрозадача, таймер, вкладений rAF",
    expected: ["raf A", "micro", "raf B", "timeout", "raf C"],
    run(log) {
      requestAnimationFrame(() => {
        log("raf A");
        requestAnimationFrame(() => log("raf C"));
        setTimeout(() => log("timeout"), 0);
        Promise.resolve().then(() => log("micro"));
      });
      requestAnimationFrame(() => log("raf B"));
    },
  },
  {
    title: "5. dispatchEvent на нашій шині — синхронний",
    expected: ["before", "listener 1", "listener 2", "after", "micro"],
    run(log) {
      const bus = new EventTarget();
      bus.addEventListener("fired", () => {
        log("listener 1");
        Promise.resolve().then(() => log("micro"));
      });
      bus.addEventListener("fired", () => log("listener 2"));
      log("before");
      bus.dispatchEvent(new CustomEvent("fired"));
      log("after");
    },
  },
];

/** Runs one puzzle and resolves with its output once everything it scheduled has run. */
export function runPuzzle(puzzle, settleMs = 200) {
  const out = [];
  puzzle.run((x) => out.push(String(x)));
  return new Promise((resolve) => setTimeout(() => resolve(out), settleMs));
}

export async function showPuzzles(root) {
  const pre = document.createElement("pre");
  pre.className = "panel report";
  root.replaceChildren(pre);
  root.hidden = false;
  for (const p of PUZZLES) {
    const got = await runPuzzle(p); // sequential on purpose: puzzles must not interleave
    const ok = got.join() === p.expected.join();
    const line = `${ok ? "✓" : "✗"} ${p.title}\n   ${got.join(" ")}${ok ? "" : `\n   очікувалось: ${p.expected.join(" ")}`}\n`;
    pre.textContent += line;
    console.log(line);
  }
}
