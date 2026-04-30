/// Connection registry + fanout — the impure boundary between the pure pipeline and the
/// HTTP layer.
///
/// Each connected client gets a `Subscriber` with a bounded queue. `broadcast()` enqueues
/// every emitted event onto every subscriber's queue. When a subscriber is slower than
/// the broadcast rate and its queue exceeds `perConnQueueMax`, the hub evicts the oldest
/// LOW event first, then the oldest MEDIUM, and never drops HIGH — so important signals
/// always arrive even if the consumer is behind.
///
/// `Subscriber.next()` is an async iterator: it yields the next event from the queue, or
/// awaits one if the queue is empty. The SSE route awaits in a loop and writes each event
/// down the wire. When a client disconnects, the route calls `disconnect()` to clean up.

import type {EventPriority, TickerEvent} from "./types.js";

export interface HubMetrics {
  connections: number;
  /// Cumulative events broadcast to clients (counts each subscriber-delivered event).
  delivered: number;
  /// Cumulative events evicted from per-conn queues by backpressure.
  evicted: number;
}

export interface Subscriber {
  /// Block until an event is available. Returns `null` when disconnected.
  next: () => Promise<TickerEvent | null>;
  /// Close the subscriber — pending `next()` resolves to null and further enqueues no-op.
  close: () => void;
}

interface InternalSub extends Subscriber {
  queue: TickerEvent[];
  resolveNext: ((v: TickerEvent | null) => void) | null;
  closed: boolean;
}

export interface HubOpts {
  perConnQueueMax: number;
}

export class Hub {
  private subs: Set<InternalSub> = new Set();
  private metrics: HubMetrics = {connections: 0, delivered: 0, evicted: 0};

  constructor(private opts: HubOpts) {}

  connect(): Subscriber {
    const queue: TickerEvent[] = [];
    let resolveNext: ((v: TickerEvent | null) => void) | null = null;
    const sub: InternalSub = {
      queue,
      resolveNext,
      closed: false,
      next: () => {
        if (sub.closed) return Promise.resolve(null);
        const head = sub.queue.shift();
        if (head) return Promise.resolve(head);
        return new Promise<TickerEvent | null>((res) => {
          sub.resolveNext = res;
        });
      },
      close: () => {
        if (sub.closed) return;
        sub.closed = true;
        this.subs.delete(sub);
        this.metrics.connections = this.subs.size;
        if (sub.resolveNext) {
          sub.resolveNext(null);
          sub.resolveNext = null;
        }
      },
    };
    this.subs.add(sub);
    this.metrics.connections = this.subs.size;
    return sub;
  }

  /// Broadcast every event in `evts` to every subscriber. Eviction policy fires per
  /// subscriber when its queue exceeds the cap.
  broadcast(evts: ReadonlyArray<TickerEvent>): void {
    if (evts.length === 0) return;
    for (const sub of this.subs) {
      if (sub.closed) continue;
      for (const e of evts) {
        // If a `next()` is already awaiting, hand it directly — bypass the queue.
        if (sub.resolveNext) {
          const r = sub.resolveNext;
          sub.resolveNext = null;
          r(e);
          this.metrics.delivered++;
          continue;
        }
        sub.queue.push(e);
        if (sub.queue.length > this.opts.perConnQueueMax) {
          this.evictOne(sub);
        }
        this.metrics.delivered++;
      }
    }
  }

  /// Evict the lowest-priority oldest event from the subscriber's queue. Order:
  ///   1. oldest LOW
  ///   2. oldest MEDIUM
  ///   3. oldest non-HIGH (none — in practice we never reach here unless every event
  ///      was HIGH, in which case we keep them all and let the queue grow by one).
  private evictOne(sub: InternalSub): void {
    const order: EventPriority[] = ["LOW", "MEDIUM"];
    for (const p of order) {
      const idx = sub.queue.findIndex((e) => e.priority === p);
      if (idx !== -1) {
        sub.queue.splice(idx, 1);
        this.metrics.evicted++;
        return;
      }
    }
    // No LOW or MEDIUM found — every queued event is HIGH. Don't evict.
  }

  getMetrics(): HubMetrics {
    return {...this.metrics};
  }

  /// Snapshot of all subscribers' queue lengths — exposed for tests + debugging only.
  queueDepths(): number[] {
    return Array.from(this.subs).map((s) => s.queue.length);
  }

  /// Close every active subscription. Used at process shutdown.
  closeAll(): void {
    for (const sub of [...this.subs]) sub.close();
  }
}
