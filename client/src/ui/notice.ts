// A one-line message that has to survive a page reload: "the server restarted, pick a room again".
// sessionStorage can throw (private mode, blocked storage) — then the message is simply lost,
// and the lobby still opens: a missing notice must never be the reason the game does not start.

const KEY = "dogfight.notice";

export function saveNotice(text: string, storage: Pick<Storage, "setItem"> = sessionStorage): void {
  try {
    storage.setItem(KEY, text);
  } catch {
    /* storage unavailable: nothing to do */
  }
}

/** Reads the notice and removes it, so it is shown once. */
export function takeNotice(
  storage: Pick<Storage, "getItem" | "removeItem"> = sessionStorage,
): string | null {
  try {
    const text = storage.getItem(KEY);
    if (text !== null) storage.removeItem(KEY);
    return text;
  } catch {
    return null;
  }
}
