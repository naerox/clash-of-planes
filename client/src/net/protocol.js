// The client's side of the wire protocol. The protocol itself (constants, close codes, message
// validation, both codecs) lives in @dogfight/shared since Lab 5 — one definition for browser and
// server. What stays here is client-only: building the control messages, and user-facing text.

import { PROTOCOL_VERSION, isFatalClose } from "@dogfight/shared";

export { PROTOCOL_VERSION, isFatalClose };

export const msg = {
  join: (room, name, codec = "binary") => ({
    v: PROTOCOL_VERSION,
    type: "join",
    room,
    name,
    codec,
  }),
  chat: (text) => ({ v: PROTOCOL_VERSION, type: "chat", text }),
  leave: () => ({ v: PROTOCOL_VERSION, type: "leave" }),
  netsim: ({ latency, jitter, drop }) => ({
    v: PROTOCOL_VERSION,
    type: "netsim",
    latency,
    jitter,
    drop,
  }),
};

/** The server's `error` messages carry a stable `code`; the words are ours. */
export const SERVER_ERRORS = {
  no_such_room: "такої кімнати вже немає",
  room_full: "кімната заповнена",
  name_taken: "це ім'я в кімнаті вже зайняте",
  netsim_disabled: "симуляція мережі вимкнена на цьому сервері",
};

export function describeClose(code) {
  const text = {
    1001: "сервер перезапускається",
    1003: "сервер не приймає такі повідомлення",
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
