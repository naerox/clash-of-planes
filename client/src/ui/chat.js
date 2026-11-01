// The in-game chat panel and room roster. DOM only: it listens to the Connection's events
// and calls `connection.send`; it knows nothing about WebSockets.

import { msg } from "../net/protocol.js";

const KEEP_LINES = 40;

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

/** Mounts into `root`; returns `unmount()`. Enter focuses the box, Enter again sends,
 * Escape gives the keyboard back to the game. `joined` is the server's `joined` message that
 * the caller already consumed while entering the room (a later one, after a reconnect, arrives
 * as an ordinary event). */
export function mountChat(connection, root, { joined = null, target = window } = {}) {
  const ac = new AbortController();
  const { signal } = ac;
  let you = null;
  let known = new Map(); // id → name, to announce arrivals and departures

  const roster = el("p", { className: "roster" });
  const net = el("span", { className: "net" });
  const log = el("ul", { className: "log" });
  const input = el("input", {
    type: "text",
    maxLength: 200,
    placeholder: "Enter — чат",
    autocomplete: "off",
    "aria-label": "Чат",
  });
  root.replaceChildren(roster, log, input);
  root.hidden = false;

  // every line is built with textContent (el(...) children are text nodes): a chat message
  // can never inject markup into the page
  function addLine(className, ...parts) {
    log.append(el("li", { className }, ...parts));
    while (log.children.length > KEEP_LINES) log.firstChild.remove();
  }

  function renderRoster(players) {
    roster.replaceChildren(
      `У кімнаті (${players.length}): ${players.map((p) => p.name).join(", ")} `,
      net,
    );
  }

  function diff(players) {
    const next = new Map(players.map((p) => [p.id, p.name]));
    for (const [id, name] of next)
      if (!known.has(id) && id !== you) addLine("system", `${name} приєднався`);
    for (const [id, name] of known) if (!next.has(id)) addLine("system", `${name} вийшов`);
    known = next;
  }

  const on = (type, handler) =>
    connection.addEventListener(type, (e) => handler(e.detail), { signal });

  function onJoined(m) {
    you = m.you;
    known = new Map(m.players.map((p) => [p.id, p.name]));
    renderRoster(m.players);
    addLine("system", `Ви в кімнаті «${m.room.name}»`);
  }
  on("joined", onJoined);
  if (joined) onJoined(joined);
  on("roster", (m) => {
    diff(m.players);
    renderRoster(m.players);
  });
  on("chat", (m) => {
    addLine(
      m.from.id === you ? "me" : "",
      el("span", { className: "who" }, `${m.from.name}: `),
      m.text,
    );
  });
  on("error", (m) => addLine("system", `Помилка сервера: ${m.message}`));
  on("status", (s) => {
    if (s.state === "reconnecting") {
      net.textContent = `· немає зв'язку, повтор через ${(s.delayMs / 1000).toFixed(1)} с`;
    } else if (s.state === "connecting" && s.attempt > 0) net.textContent = "· підключення…";
    else net.textContent = "";
  });

  target.addEventListener(
    "keydown",
    (e) => {
      if (e.code !== "Enter" || e.repeat || document.activeElement === input) return;
      e.preventDefault();
      input.focus();
    },
    { signal },
  );

  input.addEventListener(
    "keydown",
    (e) => {
      if (e.code === "Escape") input.blur();
      if (e.code !== "Enter" || e.isComposing) return;
      const text = input.value.trim();
      if (text && !connection.send(msg.chat(text))) {
        addLine("system", "Черга повідомлень переповнена, спробуйте пізніше");
        return;
      }
      input.value = "";
      input.blur(); // back to flying
    },
    { signal },
  );

  return function unmount() {
    ac.abort();
    root.replaceChildren();
    root.hidden = true;
  };
}
