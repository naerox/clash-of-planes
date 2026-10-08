// Loading screen: a real progress bar on the canvas (overall + one row per file) drawn
// by its own rAF loop, plus a DOM overlay for the error message and the Retry button.

import { beginScreen } from "../render/canvas.js";

const C = {
  bg: "#070d13",
  text: "#9fc3d8",
  dim: "#4d6b80",
  bar: "#22405a",
  fill: "#5ec88a",
  retry: "#ffb84d",
  fail: "#ff7a59",
};

const STATUS_LABEL = {
  pending: "очікує",
  loading: "",
  retrying: "повтор",
  done: "✓",
  failed: "✗",
  cancelled: "—",
};

function formatBytes(n) {
  return n >= 1024 ? `${(n / 1024).toFixed(1)} KB` : `${n} B`;
}

export function createLoadingScreen(view, overlay) {
  let progress = { files: [], fraction: 0, finished: 0 };
  let message = "Завантаження маніфесту…";
  let rafId = 0;

  function draw() {
    const { ctx, width, height } = view;
    beginScreen(view);
    ctx.fillStyle = C.bg;
    ctx.fillRect(0, 0, width, height);

    const w = Math.min(560, width - 48);
    const x = (width - w) / 2;
    let y = Math.max(32, height * 0.1);

    ctx.font = '600 20px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    ctx.textBaseline = "top";
    ctx.fillStyle = C.text;
    ctx.fillText("Clash of Planes", x, y);
    y += 34;

    ctx.font = '13px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
    ctx.fillStyle = C.bar;
    ctx.fillRect(x, y, w, 14);
    ctx.fillStyle = C.fill;
    ctx.fillRect(x, y, w * progress.fraction, 14);
    y += 22;
    ctx.fillStyle = C.text;
    const pct = Math.floor(progress.fraction * 100); // never "100%" while a file is missing
    ctx.fillText(
      `${pct}%  ·  ${progress.finished}/${progress.files.length} файлів  ·  ${message}`,
      x,
      y,
    );
    y += 28;

    for (const f of progress.files) {
      const frac = f.status === "done" ? 1 : f.total ? Math.min(1, f.loaded / f.total) : 0;
      const colour =
        f.status === "failed" || f.status === "cancelled"
          ? C.fail
          : f.status === "retrying"
            ? C.retry
            : C.fill;
      ctx.fillStyle = C.bar;
      ctx.fillRect(x, y + 4, 90, 6);
      ctx.fillStyle = colour;
      ctx.fillRect(x, y + 4, 90 * frac, 6);

      ctx.fillStyle = f.status === "pending" ? C.dim : C.text;
      const size = f.total ? `${formatBytes(f.loaded)} / ${formatBytes(f.total)}` : "";
      const tag =
        f.status === "retrying" ? `${STATUS_LABEL.retrying} #${f.attempt}` : STATUS_LABEL[f.status];
      const path = f.url.split("?")[0]; // hide the fault/latency query from the player
      ctx.fillText(`${path.padEnd(20)} ${size.padEnd(20)} ${tag}`, x + 102, y);
      y += 18;
      if (f.error && f.status !== "done") {
        ctx.fillStyle = colour;
        ctx.fillText(
          `  ${f.error}${f.optional ? " (необов'язковий)" : ""}`.slice(0, 90),
          x + 102,
          y,
        );
        y += 18;
      }
    }

    ctx.fillStyle = C.dim;
    ctx.fillText("Esc — скасувати завантаження", x, Math.max(y + 16, height - 30));
  }

  function tick() {
    draw();
    rafId = requestAnimationFrame(tick);
  }

  return {
    show() {
      overlay.replaceChildren();
      overlay.hidden = true;
      message = "Завантаження маніфесту…";
      progress = { files: [], fraction: 0, finished: 0 };
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(tick);
    },
    setMessage(text) {
      message = text;
    },
    update(snapshot) {
      progress = snapshot;
      message = "завантаження…";
    },
    /** Stops the loop, shows `err` and resolves once the player presses Retry (or Enter). */
    fail(err) {
      message = err.name === "AbortError" ? "скасовано" : "помилка";
      draw();
      cancelAnimationFrame(rafId);
      const title =
        err.name === "AbortError" ? "Завантаження скасовано" : "Не вдалося завантажити гру";
      const button = Object.assign(document.createElement("button"), {
        type: "button",
        textContent: "Retry",
      });
      const panel = document.createElement("div");
      panel.className = "panel error";
      panel.append(
        Object.assign(document.createElement("h1"), { textContent: title }),
        Object.assign(document.createElement("p"), { textContent: err.message ?? String(err) }),
        button,
      );
      overlay.replaceChildren(panel);
      overlay.hidden = false;
      button.focus();
      return new Promise((resolve) => button.addEventListener("click", resolve, { once: true }));
    },
    hide() {
      cancelAnimationFrame(rafId);
      overlay.replaceChildren();
      overlay.hidden = true;
    },
  };
}
