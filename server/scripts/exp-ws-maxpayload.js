// Notes experiment 5 (Lab 4): a WebSocketServer and a client in one script; echo, then a
// message larger than maxPayload — which event fires where?
//   node scripts/exp-ws-maxpayload.js

import { WebSocket, WebSocketServer } from "ws";

const wss = new WebSocketServer({ port: 0, maxPayload: 1024 });
await new Promise((r) => wss.on("listening", r));
const url = `ws://127.0.0.1:${wss.address().port}`;
const log = (who, what) => console.log(`${who.padEnd(7)} ${what}`);

wss.on("connection", (socket) => {
  socket.on("message", (data) => {
    log("server", `message, ${data.length} bytes → echo`);
    socket.send(data);
  });
  socket.on("error", (err) => log("server", `error: ${err.message} (code ${err.code})`));
  socket.on("close", (code) => log("server", `close ${code}`));
});

const client = new WebSocket(url);
client.on("message", (d) => log("client", `message, ${d.length} bytes (echo received)`));
client.on("error", (err) => log("client", `error: ${err.message}`));
const closed = new Promise((r) =>
  client.on("close", (code) => (log("client", `close ${code}`), r())),
);

await new Promise((r) => client.on("open", r));
client.send("x".repeat(100)); // under the limit: echoed
await new Promise((r) => setTimeout(r, 100));
log("client", "sending 2048 bytes (limit is 1024)");
client.send("x".repeat(2048));
await closed;
await new Promise((r) => setTimeout(r, 50));
wss.close();
