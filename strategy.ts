// Dip Runner — a deterministic paper bot for the pump.fun bot sprint.
//
// The replay is 6 hours of pump.fun bonding-curve traffic (TradeEvent /
// CreateEvent / CompleteEvent) and the score is final net PnL in SOL after
// every fee, starting from 10 SOL of paper money. Two constraints drive
// the whole design:
//
//   * Guardrail: a round trip of at least 0.01 SOL on each of at least
//     20 coins, and max drawdown at most 50%. Miss it and the entry ranks
//     below every entry that meets it.
//   * Determinism: the grader runs the bot twice and the two action logs
//     must match byte for byte. So every decision comes only from the
//     hello / batch / orders / slot stream — no clock, no randomness,
//     no network, no environment. All iteration is over insertion-ordered
//     maps fed by the batches.
//
// How it trades: most pump.fun curves grind down, but a minority snap
// back hard after a dip. The bot buys small into a dip once buy flow
// turns back up (price down 5-30% over an 80-slot tape, newer-half net
// flow positive and improving on the older half), then gets out fast:
// a +30% take-profit, a -5% stop-loss, a trailing stop once up 10%, a
// fade exit when short-term flow turns, a big-sell exit, and a max-hold
// cap. Winners get pyramided in small steps while they keep stepping up.
// When the main signal is quiet and the guardrail pace lags, the bot
// opens tiny 0.012 SOL probe round trips on liquid curves so the run
// still clears the 20-coin bar.
//
// Lineage: the numbers below are the author's own swept set from the
// earlier "Dip Sprinter" entry for the sister 6-hour paper sprint
// (best of 27 swept variants on the shared dev window: -0.117 SOL,
// 92 coins, 139 round trips, 1.5% max drawdown — a down-market window
// where every genuine strategy lost money, so the set is the one that
// lost least while keeping tail upside). The code here is written fresh
// in this session: same rules, same numbers, re-authored line by line.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

/** All tunable numbers for the bot. */
export interface Tuning {
  /** Tape length for entry decisions, in slots. */
  tapeSlots: number;
  /** Buys minus sells (SOL) over the tape needed for a surge entry. */
  surgeNetSol: number;
  /** Buy trades over the tape needed to enter. */
  tapeBuys: number;
  /** Distinct buyers over the tape needed to enter. */
  tapeBuyers: number;
  /** Price rise over the tape needed for a surge entry. */
  surgeRise: number;
  /** Price must sit at least this close to the tape high (surge mode). */
  surgeNearHigh: number;
  /** No single buyer may fund more than this share of tape buy SOL. */
  buyerCap: number;
  /** Real SOL reserve range a curve must sit in at entry. */
  reserveLow: number;
  reserveHigh: number;
  /** Slots after creation before a curve may be entered. */
  curveAge: number;
  /** First buy of a position, SOL. */
  firstBuySol: number;
  /** Each pyramid add, SOL. */
  addBuySol: number;
  /** Most SOL in one position. */
  positionCapSol: number;
  /** Smallest buy worth placing, SOL. */
  smallestBuySol: number;
  /** Buy slippage allowance, bps. Sells always go out at 10000 bps. */
  buySlippageBps: number;
  /** Sell when worth drops below cost * (1 - lossCut). */
  lossCut: number;
  /** Sell when worth reaches cost * (1 + winTake). */
  winTake: number;
  /** Trailing stop arms once peak worth reaches cost * (1 + trailArmAt). */
  trailArmAt: number;
  /** ...then sell when worth falls below peak * (1 - trailDrop). */
  trailDrop: number;
  /** Fade exit: sell when net SOL over fadeSlots slots is below -fadeSol. */
  fadeSlots: number;
  fadeSol: number;
  /** Sell when any single recorded sell is at least this big, SOL. */
  whaleSellSol: number;
  /** Sell after holding this many slots, unless up enough. */
  holdLimit: number;
  /** ...unless worth is at least cost * (1 + holdIfUpBy). */
  holdIfUpBy: number;
  /** Slots to wait after an exit before re-entering the same curve. */
  reentryWait: number;
  /** Most entries per curve over the whole run. */
  entriesPerCurve: number;
  /** Most main positions open at once. */
  mainSlots: number;
  /** Most SOL at cost across all positions at once. */
  exposureCapSol: number;
  /** Guardrail pace: coins and fills to reach by the end of the window. */
  paceCoins: number;
  paceFills: number;
  /** Block-time seconds the pace is measured over (6 hours). */
  paceWindowSecs: number;
  /** One guardrail probe round trip, SOL. */
  probeSizeSol: number;
  /** Most probe round trips open at once. */
  probeSlots: number;
  /** True: buy dips (price down, flow returning). False: buy surges. */
  buyDips: boolean;
  /** Dip entry: price must have fallen at least this much. */
  dipAtLeast: number;
  /** Dip entry: price must not have fallen more than this. */
  dipAtMost: number;
}

export const DEFAULT_TUNING: Tuning = {
  tapeSlots: 80,
  surgeNetSol: 1,
  tapeBuys: 6,
  tapeBuyers: 6,
  surgeRise: 0.12,
  surgeNearHigh: 0.97,
  buyerCap: 0.5,
  reserveLow: 2,
  reserveHigh: 60,
  curveAge: 200,
  firstBuySol: 0.03,
  addBuySol: 0.03,
  positionCapSol: 0.12,
  smallestBuySol: 0.01,
  buySlippageBps: 1500,
  lossCut: 0.05,
  winTake: 0.3,
  trailArmAt: 0.1,
  trailDrop: 0.15,
  fadeSlots: 20,
  fadeSol: 0.3,
  whaleSellSol: 1.5,
  holdLimit: 800,
  holdIfUpBy: 0.1,
  reentryWait: 150,
  entriesPerCurve: 2,
  mainSlots: 5,
  exposureCapSol: 2,
  paceCoins: 25,
  paceFills: 60,
  paceWindowSecs: 21600,
  probeSizeSol: 0.012,
  probeSlots: 1,
  buyDips: true,
  dipAtLeast: 0.05,
  dipAtMost: 0.3,
};

const SOL = 1_000_000_000;
/** Curve fee: 0.95% protocol + 0.30% creator fallback, per side. */
const CURVE_FEE = 0.0125;

interface TapeTick {
  slot: number;
  isBuy: boolean;
  sol: number;
  wallet: string;
  price: number;
}

interface CurveTape {
  bornAt: number | null;
  ticks: TapeTick[];
  entriesUsed: number;
  exitedAt: number;
}

interface LivePosition {
  openedAt: number;
  bestWorth: number;
  spentSol: number;
  selling: boolean;
  landed: boolean;
  buyPrice: number;
  worthNow: number;
}

/** A dip-buying bot with tight exits and guardrail probes. */
export class DipRunner implements Bot {
  private tapes = new Map<Pubkey, CurveTape>();
  private books = new Map<Pubkey, LivePosition>();
  /** Probes in flight: false while the buy is out, true once selling. */
  private probes = new Map<Pubkey, boolean>();
  private myFills = 0;
  private tradedCoins = new Set<Pubkey>();
  private firstBlockTime: number | null = null;
  private lastBlockTime: number | null = null;

  constructor(private readonly cfg: Tuning = DEFAULT_TUNING) {}

  private tapeFor(mint: Pubkey): CurveTape {
    let tape = this.tapes.get(mint);
    if (tape === undefined) {
      tape = { bornAt: null, ticks: [], entriesUsed: 0, exitedAt: -1_000_000_000_000 };
      this.tapes.set(mint, tape);
    }
    return tape;
  }

  /** Net SOL (buys minus sells) over the last `slots` slots of a tape. */
  private recentNet(tape: CurveTape, now: number, slots: number): number {
    let net = 0;
    for (let i = tape.ticks.length - 1; i >= 0; i--) {
      const tick = tape.ticks[i]!;
      if (tick.slot <= now - slots) break;
      net += tick.isBuy ? tick.sol : -tick.sol;
    }
    return net;
  }

  /** Worth of `tokens` now, in SOL, after the curve fee and one tx fee. */
  private worthOf(tokens: number, quoteRes: number, tokenRes: number, txFeeSol: number): number {
    const gross = (tokens * quoteRes) / (tokenRes + tokens);
    return (gross / SOL) * (1 - CURVE_FEE) - txFeeSol;
  }

  /** Does this curve's tape justify an entry right now? */
  private tapeLooksGood(tape: CurveTape, now: number, realSol: number): boolean {
    const c = this.cfg;
    if (realSol < c.reserveLow || realSol > c.reserveHigh) return false;
    if (tape.bornAt === null || now - tape.bornAt < c.curveAge) return false;
    const start = now - c.tapeSlots;
    let buysSol = 0;
    let sellsSol = 0;
    let buyTrades = 0;
    let anchorPrice = -1;
    let topPrice = 0;
    let endPrice = 0;
    const walletSol = new Map<string, number>();
    for (const tick of tape.ticks) {
      if (tick.slot <= start) {
        // Last trade at or before the tape start anchors the move.
        anchorPrice = tick.price;
        continue;
      }
      if (anchorPrice < 0) anchorPrice = tick.price;
      if (tick.isBuy) {
        buysSol += tick.sol;
        buyTrades++;
        walletSol.set(tick.wallet, (walletSol.get(tick.wallet) ?? 0) + tick.sol);
      } else {
        sellsSol += tick.sol;
      }
      if (tick.price > topPrice) topPrice = tick.price;
      endPrice = tick.price;
    }
    if (buyTrades < c.tapeBuys || walletSol.size < c.tapeBuyers) return false;
    if (anchorPrice <= 0 || endPrice <= 0) return false;
    const move = endPrice / anchorPrice - 1;
    if (c.buyDips) {
      // Dip: price fell, but the newer half of the tape shows buy flow
      // coming back (mean reversion, not a dead coin). Whole-tape net
      // flow is usually negative in a dip, so it is not required here —
      // only the newer half turning positive and beating the older half.
      if (move > -c.dipAtLeast || move < -c.dipAtMost) return false;
      const midpoint = now - c.tapeSlots / 2;
      let earlyNet = 0;
      let lateNet = 0;
      for (const tick of tape.ticks) {
        if (tick.slot <= start) continue;
        const signed = tick.isBuy ? tick.sol : -tick.sol;
        if (tick.slot <= midpoint) earlyNet += signed;
        else lateNet += signed;
      }
      if (lateNet <= 0 || lateNet < earlyNet) return false;
    } else {
      if (buysSol - sellsSol < c.surgeNetSol) return false;
      if (move < c.surgeRise) return false;
      if (endPrice < topPrice * c.surgeNearHigh) return false;
    }
    let whale = 0;
    for (const v of walletSol.values()) if (v > whale) whale = v;
    if (whale > c.buyerCap * buysSol) return false;
    return true;
  }

  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const c = this.cfg;
    const slot = batch.slot;
    const whaleDumps = new Set<Pubkey>();
    const activeMints = new Set<Pubkey>();

    for (const fill of batch.fills) {
      if (fill.status === 'filled' && !fill.client_id.startsWith('_')) {
        this.myFills++;
        this.tradedCoins.add(fill.mint);
      }
    }
    for (const event of batch.events) {
      if (event.block_time !== null) {
        if (this.firstBlockTime === null) this.firstBlockTime = event.block_time;
        if (this.lastBlockTime === null || event.block_time > this.lastBlockTime) {
          this.lastBlockTime = event.block_time;
        }
      }
      if (event.event === 'CreateEvent') {
        this.tapeFor(event.mint).bornAt = event.slot;
      } else if (event.event === 'TradeEvent') {
        const tape = this.tapeFor(event.mint);
        const sol = Number(event.sol_amount) / SOL;
        tape.ticks.push({
          slot: event.slot,
          isBuy: event.is_buy,
          sol,
          wallet: event.user,
          price: Number(event.virtual_quote_reserves) / Number(event.virtual_token_reserves),
        });
        activeMints.add(event.mint);
        if (!event.is_buy && sol >= c.whaleSellSol) whaleDumps.add(event.mint);
      }
    }
    // Drop tape older than the longest lookback we ever use.
    const keepFrom = slot - (Math.max(c.tapeSlots, c.fadeSlots) + 10);
    for (const mint of activeMints) {
      const tape = this.tapes.get(mint)!;
      let drop = 0;
      while (drop < tape.ticks.length && tape.ticks[drop]!.slot <= keepFrom) drop++;
      if (drop > 0) tape.ticks.splice(0, drop);
    }

    const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
    const pendingPerMint = new Map<Pubkey, number>();
    for (const pending of state.pending.values()) {
      pendingPerMint.set(pending.order.mint, (pendingPerMint.get(pending.order.mint) ?? 0) + 1);
    }

    const orders: OrderInput[] = [];
    const orderCap = state.hello.caps.max_orders_per_batch;
    const txFeeSol = Number(state.txFeeLamports()) / SOL;

    // ---- Exits: take-profit, stop-loss, trailing stop, fade, whale, hold.
    for (const [mint, pos] of this.books) {
      const holding = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (holding === undefined) {
        if (!pendingPerMint.has(mint)) {
          this.books.delete(mint);
          const tape = this.tapeFor(mint);
          if (pos.landed) tape.exitedAt = slot;
          else tape.entriesUsed--;
        }
        continue;
      }
      pos.landed = true;
      if (curve === undefined || curve.complete) continue;
      const mark = marks.get(mint);
      const quoteRes = mark ? Number(mark.virtual_quote_reserves) : Number(curve.virtual_quote_reserves);
      const tokenRes = mark ? Number(mark.virtual_token_reserves) : Number(curve.virtual_token_reserves);
      const worth = this.worthOf(Number(holding.token_amount), quoteRes, tokenRes, txFeeSol);
      const cost = Number(holding.cost_lamports) / SOL;
      if (worth > pos.bestWorth) pos.bestWorth = worth;
      pos.worthNow = worth;
      let exit = pos.selling;
      const tape = this.tapeFor(mint);
      if (!exit && worth >= cost * (1 + c.winTake)) exit = true;
      if (!exit && worth < cost * (1 - c.lossCut)) exit = true;
      if (!exit && pos.bestWorth >= cost * (1 + c.trailArmAt) && worth < pos.bestWorth * (1 - c.trailDrop)) exit = true;
      if (!exit && this.recentNet(tape, slot, c.fadeSlots) < -c.fadeSol) exit = true;
      if (!exit && whaleDumps.has(mint)) exit = true;
      if (!exit && slot - pos.openedAt > c.holdLimit && worth < cost * (1 + c.holdIfUpBy)) exit = true;
      if (!exit) continue;
      pos.selling = true;
      if (pendingPerMint.has(mint)) {
        let sellOut = false;
        for (const pending of state.pending.values()) {
          if (pending.order.mint === mint && pending.order.side === 'sell') sellOut = true;
        }
        if (sellOut) continue;
      }
      if (orders.length >= orderCap) break;
      orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: 10_000 });
    }

    // ---- Probes: sell the whole probe as soon as its buy has landed.
    for (const [mint, closing] of this.probes) {
      const holding = state.positions.get(mint);
      const curve = state.curves.get(mint);
      if (holding === undefined) {
        if (!pendingPerMint.has(mint)) this.probes.delete(mint);
        continue;
      }
      if (curve === undefined || curve.complete || pendingPerMint.has(mint)) continue;
      if (orders.length >= orderCap) break;
      orders.push({ side: 'sell', mint, token_amount: holding.token_amount, max_slippage_bps: 10_000 });
      if (!closing) this.probes.set(mint, true);
    }

    // ---- Entries and pyramid adds.
    let cashSol = Number(state.freeCashLamports()) / SOL;
    let freePositions = state.hello.caps.max_open_positions - state.committedPositionCount();
    let freeMain = c.mainSlots - this.books.size;
    let spent = 0;
    for (const [mint, pos] of this.books) {
      const live = state.positions.get(mint);
      const liveCost = live === undefined ? 0 : Number(live.cost_lamports) / SOL;
      spent += Math.max(pos.spentSol, liveCost);
    }
    for (const mint of activeMints) {
      if (orders.length >= orderCap) break;
      const curve = state.curves.get(mint);
      if (curve === undefined || curve.complete) continue;
      if (pendingPerMint.has(mint) || this.probes.has(mint)) continue;
      const tape = this.tapes.get(mint)!;
      const pos = this.books.get(mint);
      const price = Number(curve.virtual_quote_reserves) / Number(curve.virtual_token_reserves);
      const realSol = Number(curve.real_quote_reserves) / SOL;
      let buySol: number;
      if (pos === undefined) {
        if (freePositions <= 0 || freeMain <= 0) continue;
        if (tape.entriesUsed >= c.entriesPerCurve || slot - tape.exitedAt < c.reentryWait) continue;
        if (!this.tapeLooksGood(tape, slot, realSol)) continue;
        buySol = c.firstBuySol;
      } else {
        // Pyramid into strength only: price stepped up from the last buy
        // and net SOL over the tape still flows in.
        if (pos.selling || !pos.landed || pos.spentSol >= c.positionCapSol - c.smallestBuySol) continue;
        const holding = state.positions.get(mint);
        if (holding === undefined) continue;
        if (price < pos.buyPrice * 1.08) continue;
        if (this.recentNet(tape, slot, c.tapeSlots) < c.surgeNetSol) continue;
        if (realSol > c.reserveHigh) continue;
        buySol = Math.min(c.addBuySol, c.positionCapSol - pos.spentSol);
      }
      const buyLimit = Number(state.maxBuyLamports(mint)) / SOL;
      let spendSol = Math.min(buyLimit, buySol, c.exposureCapSol - spent);
      if (spendSol > cashSol - txFeeSol) spendSol = cashSol - txFeeSol;
      if (spendSol < c.smallestBuySol) continue;
      const lamports = BigInt(Math.floor(spendSol * SOL));
      orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: c.buySlippageBps });
      cashSol -= spendSol + txFeeSol;
      spent += spendSol;
      if (pos === undefined) {
        this.books.set(mint, {
          openedAt: slot,
          bestWorth: 0,
          spentSol: spendSol,
          selling: false,
          landed: false,
          buyPrice: price,
          worthNow: 0,
        });
        tape.entriesUsed++;
        freePositions--;
        freeMain--;
      } else {
        pos.spentSol += spendSol;
        pos.buyPrice = price;
      }
    }

    // ---- Guardrail pacing: open a probe when coins or fills lag the pace.
    if (
      this.probes.size < c.probeSlots &&
      freePositions > 0 &&
      this.firstBlockTime !== null &&
      this.lastBlockTime !== null
    ) {
      const progress = Math.min(1, (this.lastBlockTime - this.firstBlockTime) / c.paceWindowSecs);
      const coinsBehind = this.tradedCoins.size < Math.ceil(c.paceCoins * progress);
      const fillsBehind = this.myFills < Math.ceil(c.paceFills * progress);
      if (coinsBehind || fillsBehind) {
        const minReserve = (c.probeSizeSol * 10_000) / state.hello.caps.max_order_bps_of_real_reserve;
        for (const mint of activeMints) {
          if (orders.length >= orderCap || this.probes.size >= c.probeSlots) break;
          if (this.books.has(mint) || this.probes.has(mint) || pendingPerMint.has(mint) || state.positions.has(mint)) continue;
          if (coinsBehind && !fillsBehind && this.tradedCoins.has(mint)) continue;
          const curve = state.curves.get(mint);
          if (curve === undefined || curve.complete) continue;
          if (Number(curve.real_quote_reserves) / SOL < minReserve * 1.5) continue;
          if (cashSol < c.probeSizeSol + 2 * txFeeSol) break;
          orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(c.probeSizeSol * SOL)), max_slippage_bps: c.buySlippageBps });
          this.probes.set(mint, false);
          cashSol -= c.probeSizeSol + txFeeSol;
        }
      }
    }
    return orders;
  }
}

export function createBot(tuning: Tuning = DEFAULT_TUNING): Bot {
  return new DipRunner(tuning);
}
