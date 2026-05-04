/// Reservation lifecycle SSE broadcast bridge — Epic 1.15a.
///
/// Ponder event handlers (LaunchEscrow.* and FilterLauncher.SeasonActivated/Aborted)
/// pass each lifecycle change through `broadcastReservation*`, which fans the events
/// out through a dedicated `Hub` instance subscribed by `/season/:id/launch/stream`.
///
/// **Why a separate hub from `/events`?** The main hub carries market signals (rank
/// changes, large trades, HP updates) — high-volume, every-tick. Reservation events
/// are low-volume but per-season-scoped; clients on the launch stream only care about
/// their seasonId. Mixing them on the main hub would force every connected client to
/// receive (and ignore) reservation events for seasons they don't care about. A
/// dedicated hub keeps the wire shape predictable.
///
/// **ID space.** The launch hub uses a private monotonic id counter. SSE clients
/// see `id: 1, 2, 3, ...` per launch stream — they don't share id-space with the main
/// hub. Genesis (no replay buffer) means this is purely cosmetic; clients reconnecting
/// to /season/:id/launch/stream miss any frames during the disconnect.

import {Hub} from "./hub.js";
import type {EventPriority, EventType, TickerEvent} from "./types.js";

const launchHub = new Hub({perConnQueueMax: 256});
let nextLaunchId = 1;
const nextId = (): number => nextLaunchId++;

export function getLaunchHub(): Hub {
  return launchHub;
}

export interface ReservationEventInput {
  type: Extract<
    EventType,
    | "SLOT_RESERVED"
    | "SLOT_RELEASED"
    | "SLOT_REFUNDED"
    | "SLOT_REFUND_PENDING"
    | "SLOT_REFUND_CLAIMED"
    | "SLOT_FORFEITED"
  >;
  seasonId: bigint;
  creator: `0x${string}`;
  amountWei?: bigint;
  slotIndex?: bigint;
  tickerHash?: `0x${string}`;
  token?: `0x${string}` | null;
  message?: string;
}

export interface SeasonStateEventInput {
  type: Extract<EventType, "SEASON_ACTIVATED" | "SEASON_ABORTED">;
  seasonId: bigint;
  /// SEASON_ABORTED: per-contract reservationCount + totalRefunded args.
  /// SEASON_ACTIVATED: filled slot count.
  totalRefundedWei?: bigint;
  reservationCount?: bigint;
  filledSlots?: bigint;
  message?: string;
}

const PRIORITY_BY_TYPE: Record<ReservationEventInput["type"] | SeasonStateEventInput["type"], EventPriority> = {
  SLOT_RESERVED: "LOW",
  SLOT_RELEASED: "LOW",
  SLOT_REFUNDED: "MEDIUM",
  SLOT_REFUND_PENDING: "HIGH",
  SLOT_REFUND_CLAIMED: "LOW",
  SLOT_FORFEITED: "MEDIUM",
  SEASON_ACTIVATED: "HIGH",
  SEASON_ABORTED: "HIGH",
};

const DEFAULT_MESSAGES: Record<ReservationEventInput["type"] | SeasonStateEventInput["type"], string> = {
  SLOT_RESERVED: "Slot reserved",
  SLOT_RELEASED: "Slot launched",
  SLOT_REFUNDED: "Refund delivered",
  SLOT_REFUND_PENDING: "Refund waiting to claim",
  SLOT_REFUND_CLAIMED: "Refund claimed",
  SLOT_FORFEITED: "Stake forfeited",
  SEASON_ACTIVATED: "Season activated",
  SEASON_ABORTED: "Season aborted — claim refunds if owed",
};

/// Convert a reservation lifecycle event into the wire format and broadcast.
/// Idempotent on a closed hub (broadcast is a no-op).
export function broadcastReservationEvent(input: ReservationEventInput): void {
  const event: TickerEvent = {
    id: nextId(),
    type: input.type,
    priority: PRIORITY_BY_TYPE[input.type],
    token: null, // creator-scoped, not token-scoped — token is null on the wire
    address: input.token ?? null,
    message: input.message ?? DEFAULT_MESSAGES[input.type],
    data: {
      seasonId: input.seasonId.toString(),
      creator: input.creator,
      ...(input.amountWei !== undefined ? {amountWei: input.amountWei.toString()} : {}),
      ...(input.slotIndex !== undefined ? {slotIndex: input.slotIndex.toString()} : {}),
      ...(input.tickerHash ? {tickerHash: input.tickerHash} : {}),
      ...(input.token ? {token: input.token} : {}),
    },
    timestamp: new Date().toISOString(),
  };
  launchHub.broadcast([event]);
}

export function broadcastSeasonStateEvent(input: SeasonStateEventInput): void {
  const event: TickerEvent = {
    id: nextId(),
    type: input.type,
    priority: PRIORITY_BY_TYPE[input.type],
    token: null,
    address: null,
    message: input.message ?? DEFAULT_MESSAGES[input.type],
    data: {
      seasonId: input.seasonId.toString(),
      ...(input.totalRefundedWei !== undefined
        ? {totalRefundedWei: input.totalRefundedWei.toString()}
        : {}),
      ...(input.reservationCount !== undefined
        ? {reservationCount: input.reservationCount.toString()}
        : {}),
      ...(input.filledSlots !== undefined ? {filledSlots: input.filledSlots.toString()} : {}),
    },
    timestamp: new Date().toISOString(),
  };
  launchHub.broadcast([event]);
}
