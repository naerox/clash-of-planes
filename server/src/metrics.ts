// What the server measures about itself, in the Prometheus text format (GET /metrics).
//
// `prom-client` keeps the numbers; this file decides WHICH numbers and how they are wired:
//
//   counters  (only go up; the rate is computed by whoever scrapes them)
//     dogfight_messages_in_total{type}   frames received, by message type
//     dogfight_messages_out_total        frames sent
//     dogfight_bytes_in_total / dogfight_bytes_out_total
//     dogfight_rejections_total{reason}  connections or clients we refused or cut off
//     dogfight_connections_total         WebSocket connections accepted
//   gauges    (the value right now — computed at scrape time from the live server)
//     dogfight_players, dogfight_rooms, dogfight_connections
//     dogfight_tick_p99_seconds          the slowest room's 99th-percentile tick (last ~10 s)
//     dogfight_event_loop_utilization    share of time since the last scrape the loop was busy
//   histogram
//     dogfight_tick_duration_seconds     every tick of every room
//   plus prom-client's defaults: process RSS, heap, GC, event-loop lag…
//
// "messages/s" and "bytes/s" are `rate(…_total[1m])` on the scraper's side; `npm run … /metrics`
// shows the totals, and `server/scripts/chaos.ts` takes two samples to compute a rate.

import { performance } from "node:perf_hooks";
import { Counter, Gauge, Histogram, Registry, collectDefaultMetrics } from "prom-client";

export const REJECTION_REASONS = [
  "origin", // the Origin header is not on the list
  "ip_limit", // too many connections from one address
  "bad_message", // a frame that is not valid protocol
  "rate_limit", // more messages per second than the bucket allows
  "join_timeout", // connected but never joined
  "join_rejected", // no such room, room full, name taken
  "heartbeat", // stopped answering pings
  "slow_client", // reads slower than we write
  "shutdown", // we are going away
] as const;
export type RejectionReason = (typeof REJECTION_REASONS)[number];

/** What `/metrics` needs to read from the live server at scrape time. */
export interface LiveView {
  rooms(): number;
  players(): number;
  connections(): number;
  /** The slowest room's tick p99, in ms. */
  tickP99Ms(): number;
}

export class Metrics {
  readonly registry = new Registry();
  readonly messagesIn: Counter<"type">;
  readonly messagesOut: Counter;
  readonly bytesIn: Counter;
  readonly bytesOut: Counter;
  readonly rejections: Counter<"reason">;
  readonly connections: Counter;
  readonly tickDuration: Histogram;
  #view: LiveView | null = null;

  constructor({
    version,
    gitSha,
    processMetrics = false,
  }: {
    version: string;
    gitSha: string;
    /** prom-client's process/GC/event-loop-lag collectors: on in the real server, off in tests (they install GC observers). */
    processMetrics?: boolean;
  }) {
    const registry = this.registry;
    if (processMetrics) collectDefaultMetrics({ register: registry });

    this.messagesIn = new Counter({
      name: "dogfight_messages_in_total",
      help: "WebSocket frames received",
      labelNames: ["type"],
      registers: [registry],
    });
    this.messagesOut = new Counter({
      name: "dogfight_messages_out_total",
      help: "WebSocket frames sent",
      registers: [registry],
    });
    this.bytesIn = new Counter({
      name: "dogfight_bytes_in_total",
      help: "Bytes received over WebSockets",
      registers: [registry],
    });
    this.bytesOut = new Counter({
      name: "dogfight_bytes_out_total",
      help: "Bytes sent over WebSockets",
      registers: [registry],
    });
    this.rejections = new Counter({
      name: "dogfight_rejections_total",
      help: "Connections refused or clients cut off, by reason",
      labelNames: ["reason"],
      registers: [registry],
    });
    for (const reason of REJECTION_REASONS) this.rejections.inc({ reason }, 0); // visible from the first scrape
    this.connections = new Counter({
      name: "dogfight_connections_total",
      help: "WebSocket connections accepted",
      registers: [registry],
    });
    this.tickDuration = new Histogram({
      name: "dogfight_tick_duration_seconds",
      help: "How long a simulation tick took to compute (budget: 1/30 s)",
      buckets: [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.033, 0.05, 0.1, 0.25],
      registers: [registry],
    });

    const view = (): LiveView | null => this.#view;
    const live = (name: string, help: string, read: (v: LiveView) => number): void => {
      new Gauge({
        name,
        help,
        registers: [registry],
        collect() {
          const v = view();
          this.set(v ? read(v) : 0);
        },
      });
    };
    live("dogfight_rooms", "Rooms that exist", (v) => v.rooms());
    live("dogfight_players", "Players in rooms", (v) => v.players());
    live("dogfight_connections", "Open WebSocket connections", (v) => v.connections());
    live(
      "dogfight_tick_p99_seconds",
      "Slowest room's tick p99 over its last 300 ticks",
      (v) => v.tickP99Ms() / 1000,
    );

    let previous = performance.eventLoopUtilization();
    new Gauge({
      name: "dogfight_event_loop_utilization",
      help: "Share of the time since the previous scrape that the event loop was busy (0..1)",
      registers: [registry],
      collect() {
        const now = performance.eventLoopUtilization();
        this.set(performance.eventLoopUtilization(now, previous).utilization);
        previous = now;
      },
    });

    new Gauge({
      name: "dogfight_build_info",
      help: "Which build is running (always 1; the labels carry the information)",
      labelNames: ["version", "git_sha"],
      registers: [registry],
    }).set({ version, git_sha: gitSha }, 1);
  }

  /** Connect the gauges to the live server (done once, by `createApp`). */
  observe(view: LiveView): void {
    this.#view = view;
  }

  reject(reason: RejectionReason): void {
    this.rejections.inc({ reason });
  }

  async render(): Promise<string> {
    return this.registry.metrics();
  }

  get contentType(): string {
    return this.registry.contentType;
  }
}
