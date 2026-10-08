// DOM for the lobby. Knows the Lobby's events and public methods, nothing about fetch.

import { NAME_MAX, isFull, validateName } from "./lobby.js";

const NAME_KEY = "clash.playerName";

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children);
  return node;
}

function readSavedName() {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveName(name) {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode — the name just isn't remembered */
  }
}

/** Mounts the lobby UI into `root`; returns `unmount()`. `notes` are shown under the title
 * (e.g. "sprites failed to load — vector graphics"). */
export function mountLobbyView(lobby, root, { notes = [] } = {}) {
  const ac = new AbortController();
  const { signal } = ac;
  let selected = null;
  let lastUpdate = 0;

  const nameInput = el("input", {
    id: "lobby-name",
    maxLength: NAME_MAX,
    placeholder: "Пілот",
    value: readSavedName(),
    autocomplete: "nickname",
  });
  const list = el("ul", { className: "rooms" });
  const status = el("p", { className: "status" });
  const formError = el("p", { className: "form-error", role: "alert" });
  const refreshBtn = el("button", { type: "button", className: "secondary" }, "Оновити");
  const joinBtn = el("button", { type: "submit" }, "Join");

  const form = el(
    "form",
    { className: "panel lobby" },
    el("h1", {}, "Clash of Planes — лобі"),
    ...notes.map((n) => el("p", { className: "note" }, n)),
    el("label", { htmlFor: "lobby-name" }, "Ім'я"),
    nameInput,
    el("h2", {}, "Кімнати"),
    list,
    status,
    formError,
    el("div", { className: "actions" }, refreshBtn, joinBtn),
  );
  root.replaceChildren(form);
  root.hidden = false;
  nameInput.focus();

  function renderRooms(rooms) {
    if (!rooms.some((r) => r.id === selected && !isFull(r))) {
      selected = rooms.find((r) => !isFull(r))?.id ?? null;
    }
    list.replaceChildren(
      ...rooms.map((room) => {
        const full = isFull(room);
        const radio = el("input", {
          type: "radio",
          name: "room",
          value: room.id,
          checked: room.id === selected,
          disabled: full,
        });
        radio.addEventListener("change", () => (selected = room.id), { signal });
        const a = room.arena ?? {};
        return el(
          "li",
          { className: full ? "full" : "" },
          el(
            "label",
            {},
            radio,
            el("span", { className: "room-name" }, room.name),
            el("span", { className: "room-meta" }, `${room.players}/${room.maxPlayers}`),
            el(
              "span",
              { className: "room-arena" },
              `астероїдів ${a.asteroids ?? "?"} · мисливців ${a.hunters ?? "?"}`,
            ),
          ),
        );
      }),
    );
    if (!rooms.length) {
      const text = lastUpdate ? "Кімнат немає" : "Список кімнат ще не отримано…";
      list.append(el("li", { className: "empty" }, text));
    }
  }

  lobby.addEventListener(
    "rooms",
    (e) => {
      lastUpdate = e.detail.at;
      renderRooms(e.detail.rooms);
    },
    { signal },
  );

  lobby.addEventListener(
    "status",
    (e) => {
      const { state, error } = e.detail;
      status.classList.toggle("error", state === "error");
      if (state === "loading") status.textContent = "Оновлення…";
      else if (state === "ok") status.textContent = "Список актуальний";
      else {
        const age = lastUpdate
          ? ` (останній список — ${new Date(lastUpdate).toLocaleTimeString()})`
          : "";
        status.textContent = `${error}. Повтор автоматично${age}`;
      }
    },
    { signal },
  );

  refreshBtn.addEventListener("click", () => lobby.refresh(), { signal });

  form.addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      const name = validateName(nameInput.value);
      try {
        lobby.join(selected, nameInput.value);
        if (name.ok) saveName(name.name);
      } catch (err) {
        formError.textContent = err.message;
      }
    },
    { signal },
  );

  renderRooms(lobby.rooms);

  return function unmount() {
    ac.abort();
    root.replaceChildren();
    root.hidden = true;
  };
}
