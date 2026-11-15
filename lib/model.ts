// The Launch Radar model: one sealed DefiLlama snapshot in, one ranked board out.
//
// The question the board answers: if a protocol that still records no token issued one today, what
// would that token plausibly be worth? The model never invents a number from a name. It prices a
// pre-token protocol the way the market already prices its launched peers:
//
//   peer multiple   the median market-cap / TVL of the live-token protocols in the same category,
//                   read from this snapshot (a category with fewer than 3 live peers falls back to
//                   the median of every live protocol in the snapshot)
//   implied value   TVL x peer multiple x growth x seasoning x reach
//   growth          1 + clamp(change_7d, -40, +100)% x 0.30   (unreported growth counts as neutral)
//   seasoning       0.85 + 0.45 x (1 - e^(-age_days / 540))   (a protocol that has run longer with
//                   no token has more accrued, undistributed value; unreported age counts neutral)
//   reach           1 + 0.03 x min(chains - 1, 8)             (each extra chain is distribution a
//                   launch can reach on day one)
//
// The board ranks every protocol the snapshot's watchlist names, and every other protocol that is
// genuinely pre-token: no token recorded, and not a wrapped, staked or bridged product of a token
// that already trades (the house's own product rule, applied to the whole snapshot, not just the
// floor). Protocols whose token already trades are never ranked; the dashboard shows them apart,
// at the market's own values, because they are the evidence the multiples come from.

/** The snapshot's protocol entry: exactly the ten fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** The model's constants, stated on the dashboard's methodology card and used by its sandbox. */
export interface ModelConstants {
  multiple_floor: number;
  multiple_cap: number;
  min_category_peers: number;
  growth_weight: number;
  growth_min_pct: number;
  growth_max_pct: number;
  seasoning_base: number;
  seasoning_span: number;
  seasoning_tau_days: number;
  reach_per_chain: number;
  reach_max_extra_chains: number;
}

export const MODEL: ModelConstants = {
  multiple_floor: 0.02,
  multiple_cap: 4,
  min_category_peers: 3,
  growth_weight: 0.3,
  growth_min_pct: -40,
  growth_max_pct: 100,
  seasoning_base: 0.85,
  seasoning_span: 0.45,
  seasoning_tau_days: 540,
  reach_per_chain: 0.03,
  reach_max_extra_chains: 8,
};

/** The model's version label, named on the dashboard. */
export const MODEL_VERSION = 'peer-multiple-1';

/** Categories that are products of a token that already trades, never a launch of their own. */
const DERIVATIVE_CATEGORIES = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);

/** Exchanges: a protocol whose name begins with one is that exchange's own product. */
const EXCHANGE_PREFIXES = ['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini'];

/** DefiLlama's version-marker rule: a name ending in a release is a pool of another protocol. */
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

/** A whole word that marks a wrapped or staked product. */
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;

/** Whether a protocol records no token at all. */
export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

/** Whether a protocol is a wrapped, staked, bridged or exchange product of a token that trades. */
export function isDerivativeProduct(p: SnapshotProtocol): boolean {
  if (p.category !== null && DERIVATIVE_CATEGORIES.has(p.category)) return true;
  if (VERSIONED.test(p.name) || WRAPPED_WORD.test(p.name)) return true;
  return EXCHANGE_PREFIXES.some((x) => p.name === x || p.name.startsWith(`${x} `));
}

/** Whether the board may rank a protocol: pre-token and not a derivative product. */
export function isRankable(p: SnapshotProtocol): boolean {
  return isPreToken(p) && !isDerivativeProduct(p);
}

const DAY_MS = 86_400_000;

/** Whole days from the day DefiLlama began tracking a protocol to the snapshot's day; null if unknown. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** The median of a non-empty list of numbers. */
function median(values: number[]): number {
  const sorted = [...values].sort((x, y) => x - y);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** One category's live evidence: how many launched peers, and the multiple they imply. */
export interface PeerMultiple {
  multiple: number;
  peers: number;
  basis: 'category' | 'global';
}

/** Every live multiple the snapshot supports: per category, and the global fallback. */
export interface PeerTable {
  byCategory: Map<string, { multiple: number; peers: number }>;
  global: { multiple: number; peers: number };
}

/** The live-token protocols' mcap/TVL medians, per category and overall. */
export function peerTable(snapshot: Snapshot): PeerTable {
  const ratiosByCategory = new Map<string, number[]>();
  const all: number[] = [];
  for (const p of snapshot.protocols) {
    if (isPreToken(p) || p.mcap_usd === null || p.mcap_usd <= 0 || p.tvl_usd <= 0) continue;
    const ratio = p.mcap_usd / p.tvl_usd;
    all.push(ratio);
    const key = p.category ?? 'Uncategorised';
    const list = ratiosByCategory.get(key) ?? [];
    list.push(ratio);
    ratiosByCategory.set(key, list);
  }
  const clamp = (n: number): number => Math.min(MODEL.multiple_cap, Math.max(MODEL.multiple_floor, n));
  const byCategory = new Map<string, { multiple: number; peers: number }>();
  for (const [category, ratios] of ratiosByCategory) {
    byCategory.set(category, { multiple: clamp(median(ratios)), peers: ratios.length });
  }
  return { byCategory, global: { multiple: clamp(median(all)), peers: all.length } };
}

/** The multiple one protocol is priced with: its category's, or the global one when peers are few. */
export function multipleFor(p: SnapshotProtocol, table: PeerTable): PeerMultiple {
  const own = p.category === null ? undefined : table.byCategory.get(p.category);
  if (own !== undefined && own.peers >= MODEL.min_category_peers) {
    return { multiple: own.multiple, peers: own.peers, basis: 'category' };
  }
  return { multiple: table.global.multiple, peers: table.global.peers, basis: 'global' };
}

/** The model's four factors for one protocol, and the implied value they produce. */
export interface Valuation {
  implied: number;
  multiple: number;
  peerCount: number;
  peerBasis: 'category' | 'global';
  growthMult: number;
  seasoningMult: number;
  reachMult: number;
  age: number | null;
}

/** Price one pre-token protocol from the snapshot's own figures. */
export function valueProtocol(p: SnapshotProtocol, asOf: string, table: PeerTable, model: ModelConstants = MODEL): Valuation {
  const peer = multipleFor(p, table);
  const age = ageDays(asOf, p.listed_at);
  const growthPct = p.change_7d === null ? 0 : Math.min(model.growth_max_pct, Math.max(model.growth_min_pct, p.change_7d));
  const growthMult = 1 + (growthPct / 100) * model.growth_weight;
  const seasoningMult = age === null ? 1 : model.seasoning_base + model.seasoning_span * (1 - Math.exp(-age / model.seasoning_tau_days));
  const reachMult = 1 + model.reach_per_chain * Math.min(Math.max(p.chains.length - 1, 0), model.reach_max_extra_chains);
  const implied = Math.max(1, Math.round(p.tvl_usd * peer.multiple * growthMult * seasoningMult * reachMult));
  return { implied, multiple: peer.multiple, peerCount: peer.peers, peerBasis: peer.basis, growthMult, seasoningMult, reachMult, age };
}

/** One row of board.json: the ranked board's row, with the model work shown. */
export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  listed_at: string | null;
  token_status: 'pre-token';
  on_watchlist: boolean;
  age_days: number | null;
  implied_value_usd: number;
  model: {
    peer_multiple: number;
    peer_count: number;
    peer_basis: 'category' | 'global';
    growth_multiplier: number;
    seasoning_multiplier: number;
    reach_multiplier: number;
  };
  farm_steps: string[];
}

const round4 = (n: number): number => Math.round(n * 10_000) / 10_000;

/** The board: every watchlist protocol, plus every other rankable pre-token protocol, by value. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const table = peerTable(snapshot);
  const watch = new Set(snapshot.watchlist);
  const chosen = snapshot.protocols.filter((p) => watch.has(p.slug) || isRankable(p));
  const scored = chosen.map((p) => ({ p, v: valueProtocol(p, snapshot.as_of, table, model) }));
  scored.sort(
    (a, b) =>
      b.v.implied - a.v.implied ||
      b.p.tvl_usd - a.p.tvl_usd ||
      (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0),
  );
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    listed_at: s.p.listed_at,
    token_status: 'pre-token' as const,
    on_watchlist: watch.has(s.p.slug),
    age_days: s.v.age,
    implied_value_usd: s.v.implied,
    model: {
      peer_multiple: round4(s.v.multiple),
      peer_count: s.v.peerCount,
      peer_basis: s.v.peerBasis,
      growth_multiplier: round4(s.v.growthMult),
      seasoning_multiplier: round4(s.v.seasoningMult),
      reach_multiplier: round4(s.v.reachMult),
    },
    farm_steps: farmPlan(s.p, s.v.age),
  }));
}

/** What one transaction costs in gas on a chain, in plain words, and one week of small actions. */
interface GasTier {
  action: string;
  weekly: string;
}

const GAS_BY_CHAIN: Record<string, GasTier> = {
  Ethereum: { action: 'about $12', weekly: 'about $9' },
  Solana: { action: 'under $0.10', weekly: 'under $0.10' },
  BSC: { action: 'about $0.40', weekly: 'about $0.30' },
  Arbitrum: { action: 'about $0.50', weekly: 'about $0.35' },
  Optimism: { action: 'about $0.50', weekly: 'about $0.35' },
  Base: { action: 'about $0.40', weekly: 'about $0.30' },
  Polygon: { action: 'about $0.30', weekly: 'about $0.25' },
  Avalanche: { action: 'about $0.60', weekly: 'about $0.45' },
  'zkSync Era': { action: 'about $0.50', weekly: 'about $0.35' },
  Linea: { action: 'about $0.50', weekly: 'about $0.35' },
  Scroll: { action: 'about $0.50', weekly: 'about $0.35' },
  Mantle: { action: 'about $0.40', weekly: 'about $0.30' },
  Blast: { action: 'about $0.50', weekly: 'about $0.35' },
};

function gasFor(chain: string): GasTier {
  return GAS_BY_CHAIN[chain] ?? { action: 'about $2', weekly: 'about $1.50' };
}

/** The first chain a protocol names, or a neutral phrase. */
function chainOf(p: SnapshotProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** How much capital one serious farm position needs, scaled to the protocol's own TVL. */
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 500;
  if (p.tvl_usd >= 250_000_000) return 250;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/** How many weeks a season of farming runs, from the protocol's age: younger, longer. */
function seasonWeeks(age: number | null): number {
  if (age === null) return 8;
  if (age < 180) return 10;
  if (age < 365) return 8;
  if (age < 730) return 6;
  return 4;
}

/** A category's playbook: the core position, the second action, the weekly cadence, the risk. */
interface Playbook {
  core: string;
  second: string;
  cadence: string;
  risk: string;
}

function playbookFor(p: SnapshotProtocol, capital: number, chain: string): Playbook {
  const c = (p.category ?? '').toLowerCase();
  const n = p.name;
  if (c.includes('dex')) {
    return {
      core: `Provide $${capital} of liquidity to ${n}'s busiest pool on ${chain}, split evenly between the pool's two assets`,
      second: `Route one swap of about $${Math.max(20, capital / 5)} through ${n} itself instead of another exchange, so the wallet also trades there`,
      cadence: `add or remove a small slice of the position, or rebalance the pool range if it has one`,
      risk: `the pool's two assets can drift apart (impermanent loss), so favour a stable or major pair while learning the app`,
    };
  }
  if (c.includes('lend')) {
    return {
      core: `Supply $${capital} of USDC or the chain's main asset to ${n} on ${chain} and leave the supply earning`,
      second: `Borrow about a quarter of the supplied value against the position, hold it a few days, then repay in full`,
      cadence: `top the supply up by a small amount, or borrow and repay a small sum again`,
      risk: `a borrowed position can be liquidated if its health factor falls, so keep the borrow near a quarter of the supply`,
    };
  }
  if (c.includes('cdp')) {
    return {
      core: `Open a vault on ${n} with $${capital} of collateral on ${chain} and mint a small amount of its stablecoin`,
      second: `Hold the minted stablecoin in the wallet, or place it in the protocol's own stability pool if it runs one`,
      cadence: `add a little collateral, or mint and repay a small amount again`,
      risk: `the vault is liquidated if the collateral's price falls past its ratio, so mint far below the maximum the vault allows`,
    };
  }
  if (c.includes('derivative') || c.includes('perpetual')) {
    return {
      core: `Deposit $${capital} of USDC as margin on ${n} and open one small position hedged with an opposite spot holding`,
      second: `Close and reopen a small position once, so the wallet has real trading history and not one deposit`,
      cadence: `trade one small hedged position, or adjust the margin and hold`,
      risk: `perpetual positions are liquidated at their mark price, so keep leverage at 2x or under and the position small`,
    };
  }
  if (c.includes('curator') || c.includes('allocator')) {
    return {
      core: `Deposit $${capital} into one of ${n}'s curated vaults on ${chain} and keep the vault shares in the wallet`,
      second: `Read the vault's allocation page and note which markets the curator routes to, so the position is understood, not blind`,
      cadence: `add a small amount to the same vault, keeping one continuous position`,
      risk: `a curated vault inherits the risk of the markets its curator picks, so start with its most conservative vault`,
    };
  }
  if (c.includes('rwa')) {
    return {
      core: `Subscribe $${capital} to ${n}'s tokenised asset on ${chain}, completing any eligibility check it asks for`,
      second: `Hold the asset through one full yield or reporting period instead of redeeming at once`,
      cadence: `add a small amount, or claim and re-deposit the period's yield`,
      risk: `redemptions can be queued or gated by the issuer, so farm only money that can stay for a full period`,
    };
  }
  if (c.includes('bridge')) {
    return {
      core: `Bridge $${capital} of USDC from Ethereum to ${chain} through ${n}, then use the bridged funds in one app on the far side`,
      second: `Bridge a smaller amount back the other way, so the wallet has history in both directions`,
      cadence: `bridge one small amount, alternating direction`,
      risk: `a bridge is only as safe as its contracts, so keep amounts modest and check the destination balance before bridging more`,
    };
  }
  if (c.includes('stable')) {
    return {
      core: `Mint or deposit $${capital} of ${n}'s stable asset on ${chain} and hold it in the wallet`,
      second: `Place part of the stable asset in the protocol's own pool or savings rate if it offers one`,
      cadence: `mint or deposit a small amount, or move the balance between the wallet and the savings rate`,
      risk: `a young stable asset can trade under its peg, so watch its market price before adding more`,
    };
  }
  if (c.includes('yield')) {
    return {
      core: `Deposit $${capital} into ${n}'s main vault on ${chain} and keep the shares rather than selling them`,
      second: `Claim the vault's yield once and re-deposit it, so the wallet shows a full cycle of use`,
      cadence: `add a small amount to the vault, or claim and re-deposit the yield`,
      risk: `a vault's yield comes from strategies that can lose money, so read its strategy page before raising the amount`,
    };
  }
  return {
    core: `Deposit $${capital} of USDC into ${n} on ${chain} and use its main feature once, end to end`,
    second: `Repeat the main feature at a smaller size a week later, so the wallet's history is a pattern and not one visit`,
    cadence: `use the protocol's main feature once, at a small size`,
    risk: `every position here is smart-contract risk, so start at the size written and raise it only after a full cycle works`,
  };
}

/**
 * A protocol's farm plan: seven steps, each an action with what it costs and how long it takes,
 * derived from the protocol's own category, chains, TVL and age — never from its name.
 */
export function farmPlan(p: SnapshotProtocol, age: number | null): string[] {
  const chain = chainOf(p);
  const gas = gasFor(chain);
  const capital = capitalFor(p);
  const weeks = seasonWeeks(age);
  const book = playbookFor(p, capital, chain);
  const multi = p.chains.length > 1 ? ` It runs on ${p.chains.length} chains; ${chain} is the cheapest place to start.` : '';
  return [
    `Set up a fresh wallet for ${p.name} alone and keep its seed phrase offline, on paper. Cost: no fee beyond ${gas.action} of gas for its first transaction on ${chain}. Time: 10 minutes.${multi}`,
    `Fund the wallet with about $${capital + 25}: $${capital} for the position and the rest for gas, bridged to ${chain} if the funds start elsewhere. Cost: one bridge or exchange withdrawal fee, usually $1 to $10. Time: 15 minutes.`,
    `${book.core}. Cost: the $${capital} position plus ${gas.action} of gas. Time: 20 minutes to set up.`,
    `${book.second}. Cost: ${gas.action} of gas. Time: 10 minutes.`,
    `Repeat weekly for ${weeks} weeks: ${book.cadence}. Cost: ${gas.weekly} of gas a week. Time: 10 minutes a week, ${weeks * 10} minutes over the season.`,
    `Watch ${p.name}'s own points, rewards or governance page each week and claim only through links that page publishes; a claim never asks for a fee or a seed phrase. Cost: nothing to check. Time: 5 minutes a week.`,
    `Keep a farm log (wallet, dates, amounts, transaction hashes) and hold the position until the season ends or a token is announced; then unwind in reverse order. Main risk: ${book.risk}. Cost: ${gas.action} of gas to exit. Time: 20 minutes.`,
  ];
}

/** A live-token protocol: already launched, so it is evidence, never a ranked row. */
export interface LiveRow {
  slug: string;
  name: string;
  symbol: string | null;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
  multiple: number | null;
}

/** One board row as the dashboard renders it: the row, its plan and its model work. */
export interface RadarRow extends BoardRow {
  implied_per_tvl: number;
}

/** Everything the dashboard needs: the board, the live set, the multiples and the model. */
export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  protocol_count: number;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  derivative_size: number;
  total_implied_usd: number;
  category_multiples: { category: string; peers: number; multiple: number }[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** The dashboard's dataset, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const board = buildBoard(snapshot, model);
  const table = peerTable(snapshot);
  const live: LiveRow[] = snapshot.protocols
    .filter((p) => !isPreToken(p))
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      symbol: p.symbol,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd,
      change_7d: p.change_7d,
      multiple: p.mcap_usd !== null && p.tvl_usd > 0 ? round4(p.mcap_usd / p.tvl_usd) : null,
    }));
  const category_multiples = [...table.byCategory.entries()]
    .map(([category, v]) => ({ category, peers: v.peers, multiple: round4(v.multiple) }))
    .sort((a, b) => b.peers - a.peers);
  const radar: RadarData = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    protocol_count: snapshot.protocols.length,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    early_size: board.filter((r) => !r.on_watchlist).length,
    live_size: live.length,
    derivative_size: snapshot.protocols.filter((p) => isPreToken(p) && isDerivativeProduct(p)).length,
    total_implied_usd: board.reduce((sum, r) => sum + r.implied_value_usd, 0),
    category_multiples,
    rows: board.map((r) => ({ ...r, implied_per_tvl: round4(r.implied_value_usd / r.tvl_usd) })),
    live,
  };
  return { board, radar };
}

/** Why the snapshot is not one this model can score. */
export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug,
      name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, farm steps, values. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slugs: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

/** A compact data.js: the dashboard's whole dataset as one script, no fetch and no network. */
export function dataScript(radar: RadarData): string {
  return `window.RADAR=${JSON.stringify(radar)};\n`;
}
