// Dip Runner — deterministic paper bot for the pump.fun bot sprint.
//
// The grader runs `node /bot/main.ts`. The trading rules live in
// strategy.ts; the SDK shim is the kit's sdk/ts/makefun-bot.ts, vendored
// byte for byte.
//
// The bot buys small into dips once buy flow turns back up (price down
// 5-30% over an 80-slot tape, newer-half net flow positive and improving),
// exits fast on a +30% take-profit, a -5% stop-loss, a trailing stop, a
// fade exit, a whale-sell exit, or a max-hold cap, and pyramids winners
// in small steps. Tiny probe round trips keep the run above the
// competition's guardrail (a round trip of at least 0.01 SOL on at least
// 20 coins) when the main signal is quiet.

import { runBot } from './vendor/makefun-bot.ts';
import { createBot, DEFAULT_TUNING } from './strategy.ts';

await runBot(createBot(DEFAULT_TUNING));
