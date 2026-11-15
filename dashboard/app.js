/* Launch Radar — the page's whole logic. Reads window.RADAR (written by main.ts beside this page),
   renders the ranked board, a detail view per protocol and the live-token evidence set, and lets a
   reader filter, sort and re-weight the model. No network, no framework. */
(function () {
  'use strict';
  var R = window.RADAR;
  if (!R) return;

  var $ = function (id) { return document.getElementById(id); };
  var esc = function (s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  };
  var money = function (n) {
    if (n == null) return '—';
    var a = Math.abs(n);
    if (a >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (a >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (a >= 1e3) return '$' + (n / 1e3).toFixed(1) + 'K';
    return '$' + n;
  };
  var full = function (n) { return n == null ? '—' : '$' + Math.round(n).toLocaleString('en-US'); };
  var pct = function (n) {
    if (n == null) return '<span class="flat">—</span>';
    var cls = n > 0.05 ? 'up' : n < -0.05 ? 'down' : 'flat';
    return '<span class="' + cls + '">' + (n > 0 ? '+' : '') + n.toFixed(1) + '%</span>';
  };
  var mult = function (n) { return n == null ? '—' : n.toFixed(3) + '×'; };
  var trunc = function (s, n) {
    if (s.length <= n) return s;
    var cut = s.slice(0, n), sp = cut.lastIndexOf(' ');
    return (sp > 40 ? cut.slice(0, sp) : cut) + '…';
  };

  var state = {
    seg: 'all', q: '', category: 'all', chain: 'all', sort: 'implied',
    sandbox: null, // {gw, span, rpc} while the reader re-weights the model
  };

  /* ---------- header ---------- */
  $('snapshot-note').textContent =
    'Snapshot ' + R.as_of + ' · ' + R.source + ' · floor ' + money(R.floor_usd) + ' · model ' + R.model_version;
  var stats = [
    [R.protocol_count, 'protocols scanned', ''],
    [R.watchlist_size, 'on the watchlist', 'amber'],
    [R.board_size, 'pre-token rows ranked', ''],
    [R.early_size, 'early finds off the list', ''],
    [money(R.total_implied_usd), 'total implied value', ''],
    [R.live_size, 'already live (set aside)', ''],
  ];
  $('stats').innerHTML = stats.map(function (s) {
    return '<div class="stat ' + s[2] + '"><b>' + esc(s[0]) + '</b><span>' + esc(s[1]) + '</span></div>';
  }).join('');

  /* ---------- filter options ---------- */
  var cats = {}, chains = {};
  R.rows.forEach(function (r) {
    if (r.category) cats[r.category] = 1;
    r.chains.forEach(function (c) { chains[c] = 1; });
  });
  $('f-category').innerHTML = '<option value="all">All categories</option>' + Object.keys(cats).sort().map(function (c) {
    return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
  }).join('');
  $('f-chain').innerHTML = '<option value="all">All chains</option>' + Object.keys(chains).sort().map(function (c) {
    return '<option value="' + esc(c) + '">' + esc(c) + '</option>';
  }).join('');

  /* ---------- sandbox ---------- */
  var M = R.model;
  var sb = { gw: $('sb-growth'), span: $('sb-season'), rpc: $('sb-reach') };
  sb.gw.value = M.growth_weight; sb.span.value = M.seasoning_span; sb.rpc.value = M.reach_per_chain;
  function sbLabels() {
    $('sb-growth-v').textContent = Number(sb.gw.value).toFixed(2);
    $('sb-season-v').textContent = Number(sb.span.value).toFixed(2);
    $('sb-reach-v').textContent = Number(sb.rpc.value).toFixed(2);
  }
  function sbRead() {
    var gw = Number(sb.gw.value), span = Number(sb.span.value), rpc = Number(sb.rpc.value);
    var shipped = gw === M.growth_weight && span === M.seasoning_span && rpc === M.reach_per_chain;
    state.sandbox = shipped ? null : { gw: gw, span: span, rpc: rpc };
    $('sb-note').textContent = shipped
      ? 'Showing the shipped model, the one board.json carries.'
      : 'Sandbox ranking: implied values recomputed with your weights. board.json keeps the shipped model.';
    sbLabels();
  }
  function impliedOf(r) {
    if (!state.sandbox) return r.implied_value_usd;
    var s = state.sandbox;
    var g = r.change_7d == null ? 1 : 1 + (Math.min(100, Math.max(-40, r.change_7d)) / 100) * s.gw;
    var se = r.age_days == null ? 1 : 0.85 + s.span * (1 - Math.exp(-r.age_days / 540));
    var re = 1 + s.rpc * Math.min(Math.max(r.chains.length - 1, 0), 8);
    return Math.max(1, Math.round(r.tvl_usd * r.model.peer_multiple * g * se * re));
  }
  $('sb-toggle').addEventListener('click', function () {
    var body = $('sb-body');
    var open = body.hidden;
    body.hidden = !open;
    $('sb-toggle').setAttribute('aria-expanded', String(open));
    $('sb-toggle').querySelector('.chev').textContent = open ? '▾' : '▸';
  });
  [sb.gw, sb.span, sb.rpc].forEach(function (el) { el.addEventListener('input', function () { sbRead(); renderBoard(); }); });
  $('sb-reset').addEventListener('click', function () {
    sb.gw.value = M.growth_weight; sb.span.value = M.seasoning_span; sb.rpc.value = M.reach_per_chain;
    sbRead(); renderBoard();
  });
  sbLabels();

  /* ---------- board ---------- */
  function visibleRows() {
    var rows = R.rows.filter(function (r) {
      if (state.seg === 'watch' && !r.on_watchlist) return false;
      if (state.seg === 'early' && r.on_watchlist) return false;
      if (state.category !== 'all' && r.category !== state.category) return false;
      if (state.chain !== 'all' && r.chains.indexOf(state.chain) < 0) return false;
      if (state.q) {
        var hay = (r.name + ' ' + r.slug + ' ' + (r.category || '')).toLowerCase();
        if (hay.indexOf(state.q) < 0) return false;
      }
      return true;
    });
    var by = {
      implied: function (a, b) { return impliedOf(b) - impliedOf(a) || b.tvl_usd - a.tvl_usd; },
      tvl: function (a, b) { return b.tvl_usd - a.tvl_usd; },
      growth: function (a, b) { return (b.change_7d == null ? -1e9 : b.change_7d) - (a.change_7d == null ? -1e9 : a.change_7d); },
      age: function (a, b) { return (b.age_days == null ? -1 : b.age_days) - (a.age_days == null ? -1 : a.age_days); },
      name: function (a, b) { return a.name < b.name ? -1 : 1; },
    };
    rows.sort(by[state.sort] || by.implied);
    return rows;
  }

  var SEG_LABEL = { all: 'full board', watch: 'watchlist only', early: 'early finds only' };
  var SORT_LABEL = { implied: 'implied value', tvl: 'TVL', growth: '7-day growth', age: 'time tokenless', name: 'name' };
  function renderBoard() {
    var rows = visibleRows();
    var maxIv = rows.reduce(function (m, r) { return Math.max(m, impliedOf(r)); }, 1);
    var cap = '<strong>' + rows.length + ' protocols</strong> · ' + (SEG_LABEL[state.seg] || 'full board');
    if (state.category !== 'all') cap += ' · category: ' + esc(state.category);
    if (state.chain !== 'all') cap += ' · chain: ' + esc(state.chain);
    if (state.q) cap += ' · matching “' + esc(state.q) + '”';
    cap += ' · ranked by ' + (state.sandbox ? 'your sandbox weights' : SORT_LABEL[state.sort] || 'implied value');
    $('board-caption').innerHTML = cap;
    var ranked = state.sort === 'implied' && !state.sandbox;
    $('board-body').innerHTML = rows.map(function (r, i) {
      var iv = impliedOf(r);
      var shownRank = ranked ? r.rank : i + 1;
      var decorate = ranked && r.rank <= 3;
      var badge = r.on_watchlist
        ? '<span class="badge watch">WATCHLIST</span>'
        : '<span class="badge early">EARLY FIND</span>';
      if (ranked && r.rank === 1) badge += '<span class="badge top">★ TOP PICK</span>';
      var rankCell = decorate
        ? '<span class="rank-pill r' + r.rank + '">' + r.rank + '</span>'
        : String(shownRank);
      var age = r.age_days == null ? '—' : r.age_days.toLocaleString('en-US') + ' d';
      return '<tr data-slug="' + esc(r.slug) + '"' + (decorate ? ' class="top' + r.rank + '"' : '') + '>' +
        '<td class="num rank">' + rankCell + '</td>' +
        '<td><span class="pname">' + esc(r.name) + '</span>' + badge +
        '<div class="pmeta">' + esc(r.category || 'Uncategorised') + ' · ' + esc(r.chains.slice(0, 3).join(', ') || '—') +
        (r.chains.length > 3 ? ' +' + (r.chains.length - 3) : '') + '</div>' +
        (r.farm ? '<div class="pfarm">Farm · $' + r.farm.capital_usd + ' position · ' + r.farm.season_weeks +
          '-week season — ' + esc(trunc(r.farm.action, 118)) + '</div>' : '') + '</td>' +
        '<td class="num">' + money(r.tvl_usd) + '</td>' +
        '<td class="num">' + pct(r.change_7d) + '</td>' +
        '<td class="num">' + age + '</td>' +
        '<td class="num">' + mult(r.model.peer_multiple) + '</td>' +
        '<td class="ivcell"><span class="ivval">' + money(iv) + '</span>' +
        '<div class="ivbar"><i style="width:' + Math.max(2, Math.round(100 * Math.log10(iv + 1) / Math.log10(maxIv + 1))) + '%"></i></div></td>' +
        '<td class="num">' + (iv / r.tvl_usd).toFixed(2) + '×</td></tr>';
    }).join('');
    $('row-count').textContent = rows.length + ' of ' + R.board_size + ' ranked protocols shown. Click any row for its detail view and farm plan.';
    Array.prototype.forEach.call(document.querySelectorAll('#board-body tr'), function (tr) {
      tr.addEventListener('click', function () { location.hash = '#/p/' + tr.getAttribute('data-slug'); });
    });
  }

  /* ---------- live set ---------- */
  function renderLive() {
    $('live-body').innerHTML = R.live.map(function (p) {
      return '<tr data-slug=""><td><span class="pname">' + esc(p.name) + '</span>' +
        '<div class="pmeta">' + esc(p.chains.slice(0, 3).join(', ') || '—') + '</div></td>' +
        '<td>' + esc(p.symbol || '—') + '</td><td>' + esc(p.category || 'Uncategorised') + '</td>' +
        '<td class="num">' + money(p.mcap_usd) + '</td><td class="num">' + money(p.tvl_usd) + '</td>' +
        '<td class="num">' + mult(p.multiple) + '</td><td class="num">' + pct(p.change_7d) + '</td></tr>';
    }).join('');
  }

  /* ---------- detail ---------- */
  function peersOf(row) {
    return R.live.filter(function (p) { return p.category === row.category && p.mcap_usd != null; }).slice(0, 5);
  }
  function renderDetail(slug) {
    var idx = -1;
    R.rows.forEach(function (r, i) { if (r.slug === slug) idx = i; });
    if (idx < 0) { location.hash = '#/'; return; }
    var r = R.rows[idx];
    var m = r.model;
    var base = r.tvl_usd * m.peer_multiple;
    var afterG = base * m.growth_multiplier;
    var afterS = afterG * m.seasoning_multiplier;
    var prev = R.rows[idx - 1], next = R.rows[idx + 1];
    var nav = '<p class="detail-nav">' +
      (prev ? '<a href="#/p/' + esc(prev.slug) + '">← #' + prev.rank + ' ' + esc(prev.name) + '</a>' : '') +
      (next ? '<a href="#/p/' + esc(next.slug) + '">#' + next.rank + ' ' + esc(next.name) + ' →</a>' : '') + '</p>';
    var takeaway = '<p class="takeaway">Implied launch value <b>' + money(r.implied_value_usd) + '</b> — ' +
      (r.implied_value_usd / r.tvl_usd).toFixed(2) + '× its TVL, priced on ' +
      (m.peer_basis === 'category'
        ? 'the median of ' + m.peer_count + ' launched ' + esc(r.category || '') + ' peers'
        : 'the global median of ' + m.peer_count + ' launched protocols') +
      '. ' + (r.on_watchlist ? 'On the snapshot watchlist.' : 'An early find — not on the watchlist.') + '</p>';
    var peers = peersOf(r);
    var peerRows = peers.length ? peers.map(function (p) {
      return '<tr><td>' + esc(p.name) + ' (' + esc(p.symbol || '—') + ')</td><td class="num">' + money(p.mcap_usd) +
        '</td><td class="num">' + money(p.tvl_usd) + '</td><td class="num">' + mult(p.multiple) + '</td></tr>';
    }).join('') : '<tr><td colspan="4">No launched peers in this category — the board prices it on the global median instead.</td></tr>';
    var catInfo = null;
    R.category_multiples.forEach(function (c) { if (c.category === (r.category || 'Uncategorised')) catInfo = c; });
    var basisNote;
    if (m.peer_basis === 'category') {
      basisNote = 'Priced on the category median: ' + m.peer_count + ' launched ' + esc(r.category || '') +
        ' protocols carry a recorded market cap — the largest are above, and the median of all ' + m.peer_count +
        ' is ' + m.peer_multiple.toFixed(3) + '×.';
    } else if (catInfo && catInfo.peers > 0) {
      basisNote = 'Only ' + catInfo.peers + ' launched ' + esc(r.category || 'this category') +
        (catInfo.peers === 1 ? ' protocol carries' : ' protocols carry') + ' a recorded market cap (median ' +
        catInfo.multiple.toFixed(3) + '×) — too few to price a category on — so this row is priced on the global median of ' +
        R.priced_peer_size + ' launched protocols, ' + m.peer_multiple.toFixed(3) + '×.';
    } else {
      basisNote = 'No launched protocol in its category carries a recorded market cap, so this row is priced on the global median of ' +
        R.priced_peer_size + ' launched protocols, ' + m.peer_multiple.toFixed(3) + '×.';
    }
    $('view-detail').innerHTML =
      '<button type="button" class="back" id="d-back">← Back to the board</button>' +
      '<div class="detail-head"><div><h2>' + esc(r.name) +
      (r.on_watchlist ? '<span class="badge watch">WATCHLIST</span>' : '<span class="badge early">EARLY FIND</span>') +
      '</h2><p class="pmeta">Rank #' + r.rank + ' of ' + R.board_size + ' · ' + esc(r.category || 'Uncategorised') +
      ' · ' + esc(r.chains.join(', ') || 'no chains recorded') + ' · slug ' + esc(r.slug) + '</p>' + takeaway + '</div></div>' + nav +
      '<div class="detail-grid"><div>' +
      '<div class="card"><h3>The protocol in figures</h3><div class="kv">' +
      '<div><b>' + full(r.tvl_usd) + '</b><span>TVL</span></div>' +
      '<div><b>' + (r.change_7d == null ? '—' : (r.change_7d > 0 ? '+' : '') + r.change_7d.toFixed(1) + '%') + '</b><span>TVL change, 7d</span></div>' +
      '<div><b>' + (r.age_days == null ? '—' : r.age_days.toLocaleString('en-US') + ' days') + '</b><span>Run with no token</span></div>' +
      '<div><b>' + esc(r.listed_at || 'not reported') + '</b><span>Tracked since</span></div>' +
      '<div><b>' + r.chains.length + '</b><span>Chains</span></div>' +
      '<div><b>' + full(r.implied_value_usd) + '</b><span>Implied launch value</span></div>' +
      '</div>' +
      '<h3>Why this value — the model, step by step</h3>' +
      '<table class="mini"><tr><td>TVL (snapshot)</td><td class="num">' + full(r.tvl_usd) + '</td></tr>' +
      '<tr><td>× peer multiple — median mcap / TVL of ' + m.peer_count + ' launched ' +
      (m.peer_basis === 'category' ? esc(r.category || '') + ' protocols' : 'protocols across all categories') +
      '</td><td class="num">' + m.peer_multiple.toFixed(3) + '×</td></tr>' +
      '<tr><td>= peer-priced base</td><td class="num">' + full(base) + '</td></tr>' +
      '<tr><td>× growth (7d TVL change, weighted 0.30)</td><td class="num">' + m.growth_multiplier.toFixed(3) + '×</td></tr>' +
      '<tr><td>= after growth</td><td class="num">' + full(afterG) + '</td></tr>' +
      '<tr><td>× seasoning (time run with no token)</td><td class="num">' + m.seasoning_multiplier.toFixed(3) + '×</td></tr>' +
      '<tr><td>= after seasoning</td><td class="num">' + full(afterS) + '</td></tr>' +
      '<tr><td>× reach (' + r.chains.length + ' chain' + (r.chains.length === 1 ? '' : 's') + ')</td><td class="num">' + m.reach_multiplier.toFixed(3) + '×</td></tr>' +
      '<tr class="total"><td>Implied launch value</td><td class="num">' + full(r.implied_value_usd) + '</td></tr></table>' +
      '<div class="peers"><h3>Launched peers in ' + esc(r.category || 'this category') + '</h3>' +
      '<table class="mini"><tr><th>Protocol</th><th class="num">Market cap</th><th class="num">TVL</th><th class="num">Mcap / TVL</th></tr>' +
      peerRows + '</table><p class="basis-note">' + basisNote + '</p></div>' +
      '</div></div>' +
      '<div class="card"><h3>Farm plan — how to be positioned if it launches</h3><ol class="steps">' +
      r.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') +
      '</ol></div></div>';
    $('d-back').addEventListener('click', function () { location.hash = '#/'; });
    window.scrollTo(0, 0);
  }

  /* ---------- methodology ---------- */
  function renderMethod() {
    var multRows = R.category_multiples.slice(0, 16).map(function (c) {
      return '<tr><td>' + esc(c.category) + '</td><td class="num">' + c.peers + '</td><td class="num">' + c.multiple.toFixed(3) + '×</td></tr>';
    }).join('');
    var byCatName = {};
    R.category_multiples.forEach(function (c) { byCatName[c.category] = c; });
    var thinExample = 'With one or two peers the median is one protocol\'s accident, not a market price.';
    if (byCatName['Risk Curators'] && byCatName['Onchain Capital Allocator']) {
      thinExample = 'In this snapshot the lone launched Risk Curators peer carries a market cap of ' +
        byCatName['Risk Curators'].multiple.toFixed(2) + '× its TVL, while Onchain Capital Allocator\'s two launched peers median ' +
        byCatName['Onchain Capital Allocator'].multiple.toFixed(2) + '× — one or two peers are one protocol\'s accident, not a market price.';
    }
    var top = R.rows[0];
    var workedPlan = top ? '<div class="card"><h3>One complete plan, as the board carries it</h3>' +
      '<p>Rank #1, <b>' + esc(top.name) + '</b> — the same seven steps its detail view carries, generated from its own category, first chain, TVL and age:</p>' +
      '<ol class="steps">' + top.farm_steps.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ol></div>' : '';
    $('method-body').innerHTML =
      '<div class="card"><h3>The formula</h3>' +
      '<p><code>implied = TVL × peer multiple × growth × seasoning × reach</code>, every input read from the sealed snapshot of ' +
      esc(R.as_of) + ' (' + esc(R.source) + '). No protocol name is special-cased anywhere in the model: one function prices every row, and each row of the board carries its own factors so the working can be checked.</p>' +
      '<ul>' +
      '<li><b>Peer multiple.</b> For the protocol\'s category, the median market-cap / TVL of protocols whose token already trades. A category with fewer than 3 launched peers falls back to the median of every launched protocol in the snapshot with a recorded market cap. The multiple is clamped between 0.02× and 4× so one wild category cannot carry a board. The pricing evidence is the ' + R.priced_peer_size + ' launched protocols that carry a recorded market cap, of the ' + R.live_size + ' whose token trades — the rest record no market cap and cannot price anything.</li>' +
      '<li><b>Why three peers.</b> ' + thinExample + ' So below three launched peers a category does not price its own rows at all: they are priced on the global median instead, and each such row\'s detail view says so and names the thin evidence it set aside.</li>' +
      '<li><b>Growth.</b> <code>1 + clamp(7d TVL change, −40%, +100%) × 0.30</code>. Unreported growth counts as neutral, never as zero.</li>' +
      '<li><b>Seasoning.</b> <code>0.85 + 0.45 × (1 − e^(−age / 540 days))</code>: the longer a protocol has run with no token, the more of its value is still undistributed. An unreported listing date counts as neutral.</li>' +
      '<li><b>Reach.</b> <code>1 + 0.03 × min(chains − 1, 8)</code>: each extra chain is an audience a launch reaches on day one.</li></ul></div>' +
      '<div class="card"><h3>Who is on the board, and who is not</h3>' +
      '<p>The board ranks <b>' + R.board_size + ' pre-token protocols</b>: every one of the ' + R.watchlist_size +
      ' protocols on the snapshot\'s watchlist (TVL at or above ' + money(R.floor_usd) + ', no token recorded), plus ' + R.early_size +
      ' early finds the watchlist does not name — most below that floor, ' +
      R.rows.filter(function (r) { return !r.on_watchlist && r.tvl_usd >= R.floor_usd; }).length +
      ' already above it. A protocol is only ranked when it records no token <b>and</b> is not a wrapped, staked or bridged product of a token that already trades: bridge, liquid staking, restaking and exchange categories, names carrying a whole word wrapped / staked / staking, exchange-prefixed names and versioned pools (a name ending in V2, 2.0 and the like) are all set aside — ' +
      R.derivative_size + ' such products in this snapshot. Their token, in substance, already exists.</p>' +
      '<p>The ' + R.live_size + ' protocols whose token already trades are never ranked. They sit under <b>Already live</b> at the market\'s own values, and they are the evidence the peer multiples are read from:</p>' +
      '<table class="mini"><tr><th>Category</th><th class="num">Launched peers</th><th class="num">Median mcap / TVL</th></tr>' +
      multRows + '</table></div>' +
      '<div class="card"><h3>Farm plans</h3>' +
      '<p>Every row carries a seven-step plan generated from its own record — its category\'s playbook (supply and borrow for lending, liquidity for a DEX, a vault for a curator, margin for a derivatives venue), the gas price of its first chain, a position size scaled to its TVL, and a season length set by its age. Each step states what it costs and how long it takes. The board itself shows each row\'s position size, season length and core step, so the plan is visible before a row is opened; the detail view carries the whole plan. The plans are starting points for a reader\'s own research, not instructions to invest.</p></div>' +
      workedPlan;
  }

  /* ---------- routing ---------- */
  function show(view) {
    document.body.classList.toggle('is-detail', view === 'detail');
    $('view-board').hidden = view !== 'board';
    $('view-live').hidden = view !== 'live';
    $('view-detail').hidden = view !== 'detail';
    document.querySelector('.controls').style.display = view === 'detail' ? 'none' : '';
    document.querySelector('.sandbox').style.display = view === 'detail' ? 'none' : '';
    $('stats').style.display = view === 'detail' ? 'none' : '';
    document.querySelector('.model-strip').style.display = view === 'detail' ? 'none' : '';
  }
  function route() {
    var h = location.hash || '#/';
    var parts = h.replace(/^#\//, '').split('/');
    if (parts[0] === 'p' && parts[1]) { show('detail'); renderDetail(decodeURIComponent(parts[1])); return; }
    if (parts[0] === 'live') {
      state.seg = 'live'; syncSeg(); show('live'); return;
    }
    if (parts[0] === 'f' && parts[1]) {
      state.category = decodeURIComponent(parts[1]);
      $('f-category').value = state.category;
      state.seg = 'all'; syncSeg(); show('board'); renderBoard(); return;
    }
    if (state.seg === 'live') state.seg = 'all';
    syncSeg(); show('board'); renderBoard();
  }
  function syncSeg() {
    Array.prototype.forEach.call(document.querySelectorAll('.seg'), function (b) {
      b.classList.toggle('is-on', b.getAttribute('data-seg') === state.seg);
    });
  }
  Array.prototype.forEach.call(document.querySelectorAll('.seg'), function (b) {
    b.addEventListener('click', function () {
      state.seg = b.getAttribute('data-seg');
      if (state.seg === 'live') { location.hash = '#/live'; }
      else if (location.hash === '#/live' || /^#\/p\//.test(location.hash)) { location.hash = '#/'; }
      else { syncSeg(); show('board'); renderBoard(); }
    });
  });
  $('q').addEventListener('input', function () { state.q = $('q').value.trim().toLowerCase(); if (state.seg !== 'live') renderBoard(); });
  $('f-category').addEventListener('change', function () { state.category = $('f-category').value; renderBoard(); });
  $('f-chain').addEventListener('change', function () { state.chain = $('f-chain').value; renderBoard(); });
  $('f-sort').addEventListener('change', function () { state.sort = $('f-sort').value; renderBoard(); });
  window.addEventListener('hashchange', route);

  renderLive();
  renderMethod();
  route();
})();
