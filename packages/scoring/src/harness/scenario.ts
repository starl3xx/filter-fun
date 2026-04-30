import type {Address, Phase} from "../types.js";
import type {HarnessEvent} from "./events.js";
import {mulberry32, type Prng} from "./prng.js";

/// Fluent builder for scenario event streams. Each method appends one
/// event to an internal list and returns `this` so scenarios read
/// declaratively:
///
/// ```ts
/// const s = new Scenario({seed: 1, startTs: 1_700_000_000n})
///   .launch(TOKEN, 5n * WETH)
///   .buy(WALLET, TOKEN, WETH)
///   .advance(60)
///   .sell(WALLET, TOKEN, WETH);
/// runScenario({events: s.build(), assertions: [...]});
/// ```
///
/// The internal clock advances only via `.advance(seconds)` — every other
/// method emits its event at the current clock value. This keeps the
/// scenario authoring contract simple: the order of method calls matches
/// the order events fire.
///
/// Scenarios that need randomness (random wallet addresses, jittered buy
/// amounts) consume from `this.prng` rather than `Math.random`, so a seed
/// produces byte-identical event streams across machines.
export class Scenario {
  private readonly events: HarnessEvent[] = [];
  private clock: bigint;
  readonly prng: Prng;
  readonly seed: number;

  constructor(opts: {seed: number; startTs?: bigint} = {seed: 0}) {
    this.seed = opts.seed;
    this.prng = mulberry32(opts.seed);
    this.clock = opts.startTs ?? 0n;
  }

  /// Current scenario clock (seconds since `startTs`). Useful when emitting
  /// custom events outside the fluent API.
  now(): bigint {
    return this.clock;
  }

  /// Advance the scenario clock by `seconds`. Emits a `TIME_ADVANCE` event
  /// so the engine sees a clock-only beat (helpful when stepping through
  /// long quiet stretches between bursts of activity).
  advance(seconds: number): this {
    if (seconds < 0) throw new Error("Scenario.advance: seconds must be >= 0");
    this.clock += BigInt(seconds);
    this.events.push({type: "TIME_ADVANCE", ts: this.clock});
    return this;
  }

  launch(token: Address, initialLpWeth: bigint): this {
    this.events.push({type: "LAUNCH", ts: this.clock, token, initialLpWeth});
    return this;
  }

  buy(wallet: Address, token: Address, amountWeth: bigint): this {
    this.events.push({type: "BUY", ts: this.clock, wallet, token, amountWeth});
    return this;
  }

  sell(wallet: Address, token: Address, amountWeth: bigint): this {
    this.events.push({type: "SELL", ts: this.clock, wallet, token, amountWeth});
    return this;
  }

  lpAdd(token: Address, amountWeth: bigint, opts: {protocol?: boolean} = {}): this {
    this.events.push({type: "LP_ADD", ts: this.clock, token, amountWeth, protocol: opts.protocol === true});
    return this;
  }

  lpRemove(token: Address, amountWeth: bigint, opts: {protocol?: boolean} = {}): this {
    this.events.push({type: "LP_REMOVE", ts: this.clock, token, amountWeth, protocol: opts.protocol === true});
    return this;
  }

  setPhase(phase: Phase): this {
    this.events.push({type: "PHASE", ts: this.clock, phase});
    return this;
  }

  /// Returns the accumulated event stream. Subsequent fluent calls keep
  /// appending — scenarios may build, run, then continue building, but the
  /// engine itself sees only the snapshot it was constructed with.
  build(): HarnessEvent[] {
    return [...this.events];
  }
}
