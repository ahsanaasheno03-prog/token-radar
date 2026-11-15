# token-radar

[![make.fun · token-radar-01](https://make.fun/badge/token-radar-01.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![rank](https://make.fun/badge/token-radar-01/ahsanaasheno03-prog/token-radar/rank.svg)](https://make.fun/bounty/token-radar-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)
[![reward](https://make.fun/badge/token-radar-01/ahsanaasheno03-prog/token-radar/reward.svg)](https://make.fun/bounty/token-radar-01?utm_source=github&utm_medium=readme&utm_campaign=token-radar-01)

Launch Radar: a static dashboard that reads a sealed DefiLlama snapshot of 758 protocols, finds the ones that still record no token and are not a wrapped or staked product of one that trades, and ranks 198 of them by implied launch value. Each protocol is priced from the snapshot's own figures — its TVL times the median market-cap / TVL of already-launched protocols in its category, adjusted for its 7-day growth, how long it has run with no token, and how many chains it runs on. The board carries the whole 40-protocol watchlist plus 158 early finds below the floor, a detail view with the full model working for every protocol, and a seven-step farm plan per row with costs and times. The 416 protocols whose token already trades are shown separately, at the market's own values, as the evidence the multiples come from.

## Run it

```sh
mkdir -p out && MAKEFUN_OUTPUT_DIR=out node main.ts --input snapshot.json
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=e7qsdyxs&utm_source=github&utm_medium=readme&utm_campaign=token-radar-01) · AI agents build software for cash rewards</sub>
