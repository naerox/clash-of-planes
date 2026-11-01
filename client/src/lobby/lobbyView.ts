// DOM for the lobby. Knows the Lobby's events and public methods, nothing about fetch.

import type { RoomInfo } from "@dogfight/shared";
import { errorMessage } from "../errors.ts";
import { el } from "../ui/dom.ts";
import { NAME_MAX, isFull, validateName, type Lobby } from "./lobby.ts";

const NAME_KEY = "clash.playerName";

function readSavedName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? "";
  } catch {
    return "";
  }
}

function saveName(name: string): void {
  try {
    localStorage.setItem(NAME_KEY, name);
  } catch {
    /* private mode — the name just isn't remembered */
  }
}

/** Mounts the lobby UI into `root`; returns `unmount()`. `notes` are shown under the title
 * (e.g. "sprites failed to load — vector graphics"). */
export interface RoomPreset {
  readonly name: string;
  readonly arena: RoomInfo["arena"];
}

export function mountLobbyView(
  lobby: Lobby,
  root: HTMLElement,
  { notes = [], presets = [] }: { notes?: readonly string[]; presets?: readonly RoomPreset[] } = {},
): () => void {
  const ac = new AbortController();
  const { signal } = ac;
  let selected: string | null = null;
  let lastUpdate = 0;

  const nameInput = el("input", {
    id: "lobby-name",
    maxLength: NAME_MAX,
    placeholder: "Пілот",
    value: readSavedName(),
  });
  nameInput.setAttribute("autocomplete", "nickname");
  const list = el("ul", { className: "rooms" });
  const status = el("p", { className: "status" });
  const formError = el("p", { className: "form-error", role: "alert" });
  const refreshBtn = el("button", { type: "button", className: "secondary" }, "Оновити");
  const joinBtn = el("button", { type: "submit" }, "Join");

  // "create room": a name + an arena preset → POST /api/rooms
  const presetSelect = el(
    "select",
    { id: "preset" },
    ...presets.map((p, i) => el("option", { value: String(i) }, p.name)),
  );
  const roomName = el("input", { id: "room-name", maxLength: 32, placeholder: "Назва кімнати" });
  const createBtn = el("button", { type: "button", className: "secondary" }, "Створити");
  const createError = el("p", { className: "form-error", role: "alert" });
  const createBox = presets.length
    ? [
        el("h2", {}, "Нова кімната"),
        el("div", { className: "create" }, roomName, presetSelect, createBtn),
        createError,
      ]
    : [];

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
    ...createBox,
  );
  root.replaceChildren(form);
  root.hidden = false;
  nameInput.focus();

  function renderRooms(rooms: readonly RoomInfo[]): void {
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
        const a = room.arena;
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
      const text = lastUpdate
        ? "Кімнат немає. Створіть першу нижче."
        : "Список кімнат ще не отримано…";
      list.append(el("li", { className: "empty" }, text));
    }
  }

  lobby.on(
    "rooms",
    (e) => {
      lastUpdate = e.at;
      renderRooms(e.rooms);
    },
    { signal },
  );

  lobby.on(
    "status",
    (e) => {
      const { state, error } = e;
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

  refreshBtn.addEventListener(
    "click",
    () => {
      void lobby.refresh();
    },
    { signal },
  );

  createBtn.addEventListener(
    "click",
    () => {
      void createRoom();
    },
    { signal },
  );
  async function createRoom(): Promise<void> {
    createError.textContent = "";
    const preset = presets[Number(presetSelect.value)];
    if (!preset) return;
    const name = roomName.value.trim() || preset.name;
    createBtn.disabled = true;
    try {
      const room = await lobby.createRoom({ name, arena: preset.arena });
      selected = room.id; // the next render (createRoom emitted "rooms") ticks its radio
      renderRooms(lobby.rooms);
      roomName.value = "";
    } catch (err: unknown) {
      createError.textContent = errorMessage(err);
    } finally {
      createBtn.disabled = false;
    }
  }

  form.addEventListener(
    "submit",
    (e) => {
      e.preventDefault();
      const name = validateName(nameInput.value);
      try {
        lobby.join(selected ?? "", nameInput.value);
        if (name.ok) saveName(name.name);
      } catch (err: unknown) {
        formError.textContent = errorMessage(err);
      }
    },
    { signal },
  );

  renderRooms(lobby.rooms);

  return function unmount(): void {
    ac.abort();
    root.replaceChildren();
    root.hidden = true;
  };
}
