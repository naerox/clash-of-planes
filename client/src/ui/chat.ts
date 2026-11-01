// The in-game chat panel and room roster. DOM only: it listens to the Connection's events
// and calls `connection.send`; it knows nothing about WebSockets.

import type { JoinedMessage, RosterEntry, ServerControlOf } from "@dogfight/shared";
import type { Connection } from "../net/connection.ts";
import { msg } from "../net/protocol.ts";
import { el } from "./dom.ts";

const KEEP_LINES = 40;

/** Mounts into `root`; returns `unmount()`. Enter focuses the box, Enter again sends,
 * Escape gives the keyboard back to the game. `joined` is the server's `joined` message that
 * the caller already consumed while entering the room (a later one, after a reconnect, arrives
 * as an ordinary event). */
export function mountChat(
  connection: Connection,
  root: HTMLElement,
  {
    joined = null,
    target = window,
  }: { joined?: JoinedMessage | null; target?: Pick<Window, "addEventListener"> } = {},
): () => void {
  const ac = new AbortController();
  const { signal } = ac;
  let you: string | null = null;
  let known = new Map<string, string>(); // id → name, to announce arrivals and departures

  const roster = el("p", { className: "roster" });
  const net = el("span", { className: "net" });
  const log = el("ul", { className: "log" });
  const input = el("input", {
    type: "text",
    maxLength: 200,
    placeholder: "Enter — чат",
    autocomplete: "off",
  });
  input.setAttribute("aria-label", "Чат");
  root.replaceChildren(roster, log, input);
  root.hidden = false;

  // every line is built with textContent (el(...) children are text nodes): a chat message
  // can never inject markup into the page
  function addLine(className: string, ...parts: (Node | string)[]): void {
    log.append(el("li", { className }, ...parts));
    while (log.children.length > KEEP_LINES) log.firstElementChild?.remove();
  }

  function renderRoster(players: readonly RosterEntry[]): void {
    roster.replaceChildren(
      `У кімнаті (${players.length}): ${players.map((p) => p.name).join(", ")} `,
      net,
    );
  }

  function diff(players: readonly RosterEntry[]): void {
    const next = new Map(players.map((p) => [p.id, p.name]));
    for (const [id, name] of next)
      if (!known.has(id) && id !== you) addLine("system", `${name} приєднався`);
    for (const [id, name] of known) if (!next.has(id)) addLine("system", `${name} вийшов`);
    known = next;
  }

  function onJoined(m: JoinedMessage): void {
    you = m.you;
    known = new Map(m.players.map((p) => [p.id, p.name]));
    renderRoster(m.players);
    addLine("system", `Ви в кімнаті «${m.room.name}»`);
  }
  connection.on("joined", onJoined, { signal });
  if (joined) onJoined(joined);
  connection.on(
    "roster",
    (m: ServerControlOf<"roster">) => {
      diff(m.players);
      renderRoster(m.players);
    },
    { signal },
  );
  connection.on(
    "chat",
    (m) => {
      addLine(
        m.from.id === you ? "me" : "",
        el("span", { className: "who" }, `${m.from.name}: `),
        m.text,
      );
    },
    { signal },
  );
  connection.on("error", (m) => addLine("system", `Помилка сервера: ${m.message}`), { signal });
  connection.on(
    "status",
    (s) => {
      if (s.state === "reconnecting") {
        net.textContent = `· немає зв'язку, повтор через ${((s.delayMs ?? 0) / 1000).toFixed(1)} с`;
      } else if (s.state === "connecting" && s.attempt > 0) net.textContent = "· підключення…";
      else net.textContent = "";
    },
    { signal },
  );

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

  return function unmount(): void {
    ac.abort();
    root.replaceChildren();
    root.hidden = true;
  };
}
