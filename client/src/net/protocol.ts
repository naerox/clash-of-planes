// The client's side of the wire protocol. The protocol itself (constants, close codes, message
// validation, both codecs) lives in @dogfight/shared since Lab 5 — one definition for browser and
// server. What stays here is client-only: building the control messages, and user-facing text.

import {
  PROTOCOL_VERSION,
  isFatalClose,
  type ClientMessageOf,
  type CodecName,
  type NetsimSettings,
  type WithVersion,
} from "@dogfight/shared";

export { PROTOCOL_VERSION, isFatalClose };

/** The JSON control messages a client sends: `{ v, type, … }`. (Input and ping go through a codec.) */
export type ControlOut = WithVersion<ClientMessageOf<"join" | "chat" | "leave" | "netsim">>;

export const msg = {
  join: (room: string, name: string, codec: CodecName = "binary"): ControlOut => ({
    v: PROTOCOL_VERSION,
    type: "join",
    room,
    name,
    codec,
  }),
  chat: (text: string): ControlOut => ({ v: PROTOCOL_VERSION, type: "chat", text }),
  leave: (): ControlOut => ({ v: PROTOCOL_VERSION, type: "leave" }),
  netsim: ({ latency, jitter, drop }: NetsimSettings): ControlOut => ({
    v: PROTOCOL_VERSION,
    type: "netsim",
    latency,
    jitter,
    drop,
  }),
};

/** The server's `error` messages carry a stable `code`; the words are ours. */
export const SERVER_ERRORS: Readonly<Record<string, string>> = {
  no_such_room: "такої кімнати вже немає",
  room_full: "кімната заповнена",
  name_taken: "це ім'я в кімнаті вже зайняте",
  netsim_disabled: "симуляція мережі вимкнена на цьому сервері",
};

const CLOSE_TEXT: Readonly<Record<number, string>> = {
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
};

export function describeClose(code: number): string {
  return CLOSE_TEXT[code] ?? `код ${code}`;
}
