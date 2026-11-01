// The client's half of the wire protocol (server/src/protocol.js is the authority; Lab 6's
// shared/ package will make them one file). Messages are JSON text frames: { v, type, … }.

export const PROTOCOL_VERSION = 1;

export const msg = {
  join: (room, name) => ({ v: PROTOCOL_VERSION, type: "join", room, name }),
  chat: (text) => ({ v: PROTOCOL_VERSION, type: "chat", text }),
  leave: () => ({ v: PROTOCOL_VERSION, type: "leave" }),
};

/** Close codes after which reconnecting would only repeat the mistake: the server read our
 * message and refused it (1003 binary, 1008 rate limit, 1009 too big, 4xxx protocol/join
 * errors). Everything else — 1006 dropped, 1001 server restarting, 1013 try later — is
 * worth another attempt. */
export function isFatalClose(code) {
  return code === 1003 || code === 1008 || code === 1009 || (code >= 4000 && code < 4100);
}

/** The server's `error` messages carry a stable `code`; the words are ours. */
export const SERVER_ERRORS = {
  no_such_room: "такої кімнати вже немає",
  room_full: "кімната заповнена",
  name_taken: "це ім'я в кімнаті вже зайняте",
};

export function describeClose(code) {
  const text = {
    1001: "сервер перезапускається",
    1003: "сервер не приймає бінарні повідомлення",
    1008: "перевищено ліміт повідомлень",
    1009: "повідомлення завелике",
    1013: "сервер перевантажений",
    4000: "некоректне повідомлення",
    4001: "невідомий тип повідомлення",
    4002: "спершу потрібно увійти в кімнату",
    4003: "не встигли увійти за 5 с",
    4004: "кімнату не знайдено, заповнено, або ім'я зайняте",
    4005: "ви вже в кімнаті",
  }[code];
  return text ?? `код ${code}`;
}
