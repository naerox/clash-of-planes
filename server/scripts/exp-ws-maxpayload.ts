// Notes experiment 5 (Lab 4): a WebSocketServer and a client in one script; echo, then a
// message larger than maxPayload — which event fires where?
//   node scripts/exp-ws-maxpayload.ts

import { WebSocket, WebSocketServer, type RawData } from "ws";
import { errorCode } from "./common.ts";

const wss = new WebSocketServer({ port: 0, maxPayload: 1024 });
await new Promise<void>((r) => wss.on("listening", () => r()));
const address = wss.address();
if (address === null || typeof address === "string") throw new Error("expected a TCP address");
const url = `ws://127.0.0.1:${address.port}`;
const bytesOf = (d: RawData): number =>
  Array.isArray(d) ? d.reduce((n, b) => n + b.length, 0) : d.byteLength;
const log = (who: string, what: string): void => console.log(`${who.padEnd(7)} ${what}`);

wss.on("connection", (socket) => {
  socket.on("message", (data) => {
    log("server", `message, ${bytesOf(data)} bytes → echo`);
    socket.send(data);
  });
  socket.on("error", (err) => log("server", `error: ${err.message} (code ${errorCode(err)})`));
  socket.on("close", (code) => log("server", `close ${code}`));
});

const client = new WebSocket(url);
client.on("message", (d) => log("client", `message, ${bytesOf(d)} bytes (echo received)`));
client.on("error", (err) => log("client", `error: ${err.message}`));
const closed = new Promise<void>((r) =>
  client.on("close", (code) => (log("client", `close ${code}`), r())),
);

await new Promise<void>((r) => client.on("open", () => r()));
client.send("x".repeat(100)); // under the limit: echoed
await new Promise((r) => setTimeout(r, 100));
log("client", "sending 2048 bytes (limit is 1024)");
client.send("x".repeat(2048));
await closed;
await new Promise((r) => setTimeout(r, 50));
wss.close();
