// GENERATED FILE. Edit src/viewer/page.html and run:
//   node scripts/build-viewer-page.mjs
//
// The viewer is one self-contained page: no bundler, no CDN, no fonts to fetch.
// A memory store is private, so its window onto it makes no network requests
// beyond the local API it is served from.

export const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>reMem</title>
<style>
  :root{
    --ink:#111114; --paper:#FBFBF9; --plate:#FFFFFF; --rule:#E4E4E0; --mute:#8C8C86;
    --sage:#3F6A51; --sage-tint:#E9F1EA; --sage-wash:#F6FAF6; --sage-rule:#CBDDCF;
    --lilac:#6E5E92; --lilac-tint:#EDE8F4; --lilac-wash:#F9F7FC; --lilac-rule:#D8CFE6;
    --code:#3D5C8C; --code-tint:#E9EFF8; --code-wash:#F6F9FD; --code-rule:#C9D8EC;
    --serif:"Instrument Serif","Iowan Old Style",Georgia,serif;
    --mono:ui-monospace,SFMono-Regular,"SF Mono",Menlo,Consolas,monospace;
    --shadow:0 1px 2px rgba(17,17,20,.04);
  }
  @media (prefers-color-scheme: dark){
    :root:not([data-theme="light"]){
      --ink:#F2F2EF; --paper:#0D0D0F; --plate:#141416; --rule:#2A2A2E; --mute:#7E7E86;
      --sage:#9CC7A8; --sage-tint:#182219; --sage-wash:#121815; --sage-rule:#2C3D31;
      --lilac:#B4A4D6; --lilac-tint:#1D1A28; --lilac-wash:#16151D; --lilac-rule:#352E45;
      --code:#9FBFE8; --code-tint:#161D26; --code-wash:#111519; --code-rule:#2A3646;
      --shadow:none;
    }
  }
  :root[data-theme="dark"]{
    --ink:#F2F2EF; --paper:#0D0D0F; --plate:#141416; --rule:#2A2A2E; --mute:#7E7E86;
    --sage:#9CC7A8; --sage-tint:#182219; --sage-wash:#121815; --sage-rule:#2C3D31;
    --lilac:#B4A4D6; --lilac-tint:#1D1A28; --lilac-wash:#16151D; --lilac-rule:#352E45;
    --code:#9FBFE8; --code-tint:#161D26; --code-wash:#111519; --code-rule:#2A3646;
    --shadow:none;
  }

  *{box-sizing:border-box}
  html,body{height:100%}
  body{
    margin:0; background:var(--paper); color:var(--ink);
    font-family:var(--mono); font-size:13px; line-height:1.65;
    -webkit-font-smoothing:antialiased;
  }
  button{font:inherit; color:inherit; background:none; border:none; cursor:pointer}
  :focus-visible{outline:2px solid var(--ink); outline-offset:2px}
  ::selection{background:var(--sage-tint)}

  /* Header */
  header{
    position:sticky; top:0; z-index:20; background:var(--paper);
    border-bottom:1px solid var(--rule);
  }
  .bar{
    max-width:1000px; margin:0 auto; padding:12px 24px;
    display:flex; align-items:center; gap:14px;
  }
  .brand{display:flex; align-items:center; gap:9px; flex:none}
  .brand svg{width:15px; height:15px; display:block; color:var(--ink)}
  .brand b{font-family:var(--serif); font-weight:400; font-size:19px; letter-spacing:-.01em}
  .grow{flex:1; min-width:0}
  .search{
    width:100%; background:var(--plate); border:1px solid var(--rule);
    padding:7px 11px; font:inherit; color:inherit; border-radius:2px;
  }
  .search::placeholder{color:var(--mute)}
  .search:focus{outline:none; border-color:var(--code-rule); background:var(--code-wash)}
  select{
    background:var(--plate); border:1px solid var(--rule); color:inherit;
    font:inherit; padding:7px 9px; border-radius:2px; max-width:190px;
  }
  .iconbtn{
    border:1px solid var(--rule); background:var(--plate); padding:7px 9px;
    border-radius:2px; line-height:1; color:var(--mute);
  }
  .iconbtn:hover{color:var(--ink)}
  .tally{
    font-size:11px; color:var(--mute); white-space:nowrap;
    display:flex; gap:12px; align-items:baseline;
  }
  .tally b{font-family:var(--serif); font-size:15px; font-weight:400; color:var(--ink)}

  .sheet{max-width:1000px; margin:0 auto; padding:0 24px 120px}

  /* Section headings */
  .lede{
    display:flex; align-items:baseline; gap:12px; margin:26px 0 12px;
    border-bottom:1px solid var(--rule); padding-bottom:9px;
  }
  .lede h2{
    font-family:var(--serif); font-weight:400; font-size:19px; margin:0;
    letter-spacing:-.01em;
  }
  .lede .note{font-size:11px; color:var(--mute); margin-left:auto}
  .filters{display:flex; gap:1px; background:var(--rule); border:1px solid var(--rule)}
  .filter{
    background:var(--plate); color:var(--mute); font-size:10.5px; padding:4px 10px;
    line-height:1.5;
  }
  .filter:hover{color:var(--ink)}
  .filter.on{background:var(--ink); color:var(--paper)}

  /* The belief band */
  .beliefs{display:grid; grid-template-columns:repeat(auto-fill,minmax(205px,1fr)); gap:8px}
  /* The ledger is the point of this page, so the belief band stays out of its
     way until asked. Two rows, then a count. */
  .beliefs.folded{
    max-height:196px; overflow:hidden;
    -webkit-mask-image:linear-gradient(180deg,#000 66%,transparent);
    mask-image:linear-gradient(180deg,#000 66%,transparent);
  }
  .bandmore{
    display:block; width:100%; margin-top:7px; padding:7px; font-size:11px;
    color:var(--mute); border:1px solid var(--rule); border-radius:2px;
    background:var(--plate);
  }
  .bandmore:hover{color:var(--ink); border-color:var(--mute)}
  .belief{
    background:var(--sage-wash); border:1px solid var(--sage-rule);
    border-radius:2px; padding:11px 12px; text-align:left; width:100%;
    display:flex; flex-direction:column; gap:3px; transition:border-color .12s;
    /* A grid item will not shrink below its content unless told to, and
       predicates are single unbroken tokens. Without both of these, a long one
       pushes straight out through the border. */
    min-width:0; overflow:hidden;
  }
  .belief:hover{border-color:var(--sage)}
  /* Predicates are snake_case identifiers with no spaces, so normal wrapping
     has nowhere to break: crawl_linkedin_staffing_spam_dominates_volume_queries
     is one word. Break anywhere, and cap it at two lines so a long name cannot
     set the height of every card beside it. */
  .belief .pred{
    font-size:10px; letter-spacing:.08em; text-transform:uppercase;
    color:var(--sage); overflow-wrap:anywhere; word-break:break-word;
    display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical;
    overflow:hidden;
  }
  /* Clamped so one long belief cannot set the height of the whole band. The
     full text is one click away in the drawer. */
  .belief .val{
    font-family:var(--serif); font-size:17px; line-height:1.25; letter-spacing:-.01em;
    overflow-wrap:anywhere; word-break:break-word; display:-webkit-box;
    -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden;
  }
  /* The superseded value is context, not the headline. Two lines of it is
     enough to recognise what was replaced; the rest is in the drawer. */
  .belief .was{
    font-size:10.5px; color:var(--lilac); overflow-wrap:anywhere;
    word-break:break-word; display:-webkit-box; -webkit-line-clamp:2;
    -webkit-box-orient:vertical; overflow:hidden;
  }
  .belief .was s{text-decoration:line-through; text-decoration-thickness:1px}
  .belief .foot{
    display:flex; gap:9px; font-size:10px; color:var(--mute); margin-top:2px;
    font-variant-numeric:tabular-nums;
  }
  .empty{
    border:1px dashed var(--rule); border-radius:2px; padding:22px;
    color:var(--mute); font-size:12px; text-align:center; line-height:1.7;
  }
  .empty code{
    background:var(--code-tint); border:1px solid var(--code-rule);
    color:var(--code); padding:1px 6px; border-radius:2px;
  }

  /* Feed */
  .day{
    display:flex; align-items:center; gap:12px; margin:22px 0 10px;
    font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--mute);
  }
  .day::after{content:""; flex:1; border-top:1px solid var(--rule)}

  .card{
    display:block; width:100%; text-align:left; background:var(--plate);
    min-width:0; overflow:hidden;
    border:1px solid var(--rule); border-left:2px solid var(--rule);
    border-radius:2px; padding:13px 15px; margin-bottom:7px;
    box-shadow:var(--shadow); transition:border-color .12s, transform .12s;
  }
  .card:hover{border-color:var(--mute)}
  .card:active{transform:translateY(1px)}
  .card.prompt{border-left-color:var(--code); background:var(--code-wash)}
  .card.prompt:hover{border-color:var(--code-rule)}
  /* A routine, not a person. Kept in the ledger, kept visually quieter than
     the things the user actually typed. */
  .card.scheduled{border-left-color:var(--mute)}
  .card.scheduled:hover{border-color:var(--mute)}
  .card.episode{border-left-color:var(--sage)}
  .card.episode:hover{border-color:var(--sage-rule)}
  .card.action{border-left-color:var(--rule)}

  .chead{display:flex; align-items:center; gap:9px; margin-bottom:7px; flex-wrap:wrap}
  .tag{
    font-size:9.5px; letter-spacing:.1em; text-transform:uppercase;
    padding:2px 7px; border-radius:2px; border:1px solid var(--rule); color:var(--mute);
  }
  .tag.said{border-color:var(--code-rule); background:var(--code-tint); color:var(--code)}
  .tag.ran{border-color:var(--rule); color:var(--mute)}
  .tag.acct{border-color:var(--sage-rule); background:var(--sage-tint); color:var(--sage)}
  .proj{font-size:10.5px; color:var(--mute)}
  .when{margin-left:auto; font-size:10.5px; color:var(--mute); font-variant-numeric:tabular-nums}

  .ctitle{
    font-family:var(--serif); font-size:17px; line-height:1.25; margin:0 0 3px;
    letter-spacing:-.005em; overflow-wrap:anywhere;
  }
  .csub{font-size:12px; color:var(--mute); margin:0; overflow-wrap:anywhere}
  .cbody{
    margin:0; white-space:pre-wrap; word-break:break-word; font-size:12.5px;
    line-height:1.6;
  }
  .fade{
    -webkit-mask-image:linear-gradient(180deg,#000 62%,transparent);
    mask-image:linear-gradient(180deg,#000 62%,transparent);
    max-height:104px; overflow:hidden;
  }
  .cfoot{
    display:flex; gap:12px; margin-top:8px; font-size:10.5px; color:var(--mute);
    flex-wrap:wrap;
  }
  .cfoot .became{color:var(--sage)}

  .more{
    width:100%; border:1px solid var(--rule); background:var(--plate);
    padding:11px; border-radius:2px; color:var(--mute); margin-top:10px;
  }
  .more:hover{color:var(--ink); border-color:var(--mute)}

  /* Detail drawer */
  .scrim{
    position:fixed; inset:0; background:rgba(17,17,20,.28); opacity:0;
    pointer-events:none; transition:opacity .16s; z-index:30;
  }
  .scrim.on{opacity:1; pointer-events:auto}
  .drawer{
    position:fixed; top:0; right:0; bottom:0; width:min(560px,100%);
    background:var(--paper); border-left:1px solid var(--rule); z-index:31;
    transform:translateX(100%); transition:transform .18s cubic-bezier(.2,.7,.2,1);
    display:flex; flex-direction:column;
  }
  .drawer.on{transform:translateX(0)}
  .dhead{
    display:flex; align-items:center; gap:10px; padding:14px 20px;
    border-bottom:1px solid var(--rule); flex:none;
  }
  .dhead .x{margin-left:auto; color:var(--mute); font-size:17px; line-height:1; padding:4px 8px}
  .dhead .x:hover{color:var(--ink)}
  .dbody{padding:18px 20px 60px; overflow-y:auto}
  .dbody h3{
    font-size:10px; letter-spacing:.12em; text-transform:uppercase; color:var(--mute);
    margin:22px 0 9px; font-weight:400;
  }
  .dbody h3:first-child{margin-top:0}
  .said{
    background:var(--code-wash); border:1px solid var(--code-rule); border-radius:2px;
    padding:14px 15px; white-space:pre-wrap; word-break:break-word; font-size:12.5px;
    line-height:1.65; margin:0;
  }
  .acct{
    background:var(--sage-wash); border:1px solid var(--sage-rule); border-radius:2px;
    padding:14px 15px; font-size:12.5px; line-height:1.65; margin:0;
  }
  .acct .t{
    font-family:var(--serif); font-size:20px; line-height:1.2; margin-bottom:5px;
    overflow-wrap:anywhere;
  }
  .meta{
    display:grid; grid-template-columns:auto 1fr; gap:5px 14px; font-size:11.5px;
    color:var(--mute);
  }
  .meta dt{color:var(--mute)}
  .meta dd{margin:0; color:var(--ink); word-break:break-all}
  ul.facts{margin:0; padding-left:17px; font-size:12px; line-height:1.6}
  ul.facts li{margin-bottom:4px}
  .files{display:flex; flex-wrap:wrap; gap:5px}
  .file{
    font-size:10.5px; border:1px solid var(--rule); border-radius:2px;
    padding:2px 7px; color:var(--mute); word-break:break-all;
  }
  .rel{
    display:block; width:100%; text-align:left; border:1px solid var(--rule);
    border-radius:2px; padding:10px 12px; margin-bottom:6px; background:var(--plate);
    min-width:0; overflow:hidden;
  }
  .rel:hover{border-color:var(--mute)}
  .rel .k{
    display:block; font-size:10px; letter-spacing:.08em; text-transform:uppercase;
    color:var(--sage); margin-bottom:2px; overflow-wrap:anywhere;
  }
  .rel .v{
    display:block; font-family:var(--serif); font-size:16px; line-height:1.25;
    overflow-wrap:anywhere;
  }
  .rel .m{
    display:block; font-size:10.5px; color:var(--mute); margin-top:3px;
    font-variant-numeric:tabular-nums;
  }
  .quote{
    border-left:2px solid var(--code); padding:2px 0 2px 13px; margin:0 0 8px;
    white-space:pre-wrap; word-break:break-word; font-size:12px; color:var(--ink);
  }
  .quote .m{display:block; font-size:10px; color:var(--mute); margin-top:4px}

  .loading{padding:40px 0; text-align:center; color:var(--mute); font-size:12px}

  @media (max-width:720px){
    .bar{flex-wrap:wrap; gap:9px}
    .tally{order:3; width:100%}
    .sheet{padding:0 16px 90px}
    .drawer{width:100%}
  }
</style>
</head>
<body>

<header>
  <div class="bar">
    <span class="brand">
      <svg viewBox="0 0 96 96" aria-hidden="true">
        <path fill="currentColor" fill-rule="evenodd" d="M12 12H60V60H12Z M36 36H84V84H36Z"/>
      </svg>
      <b>reMem</b>
    </span>
    <select id="project" aria-label="Project"><option value="">All projects</option></select>
    <span class="grow">
      <input id="q" class="search" type="search" placeholder="Search what you said, what happened, what memory believes" aria-label="Search">
    </span>
    <span class="tally" id="tally"></span>
    <button class="iconbtn" id="theme" title="Toggle theme" aria-label="Toggle theme">◐</button>
  </div>
</header>

<main class="sheet">
  <section id="beliefBand"></section>
  <section id="feedSection">
    <div class="lede">
      <h2 id="feedTitle">The ledger</h2>
      <span class="filters" id="filters" role="group" aria-label="Filter the ledger">
        <button class="filter on" data-kinds="">Everything</button>
        <button class="filter" data-kinds="prompt">You said</button>
        <button class="filter" data-kinds="scheduled">Scheduled</button>
        <button class="filter" data-kinds="episode">What happened</button>
      </span>
      <span class="note" id="feedNote"></span>
    </div>
    <div id="feed"><div class="loading">Reading the ledger...</div></div>
    <button class="more" id="more" hidden>Load older</button>
  </section>
</main>

<div class="scrim" id="scrim"></div>
<aside class="drawer" id="drawer" aria-hidden="true">
  <div class="dhead">
    <span class="tag" id="dtag"></span>
    <span class="proj" id="dwhen"></span>
    <button class="x" id="dclose" aria-label="Close">&times;</button>
  </div>
  <div class="dbody" id="dbody"></div>
</aside>

<script>
(function(){
  "use strict";

  var state = {
    project: "",
    kinds: "",
    bandFolded: true,
    query: "",
    cursor: null,
    items: [],
    counts: null,
    lastSignature: ""
  };

  var el = function(id){ return document.getElementById(id); };

  function esc(s){
    return String(s == null ? "" : s)
      .replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;")
      .replace(/"/g,"&quot;");
  }

  function fmtTime(ts){
    var d = new Date(ts);
    return d.toLocaleTimeString([], {hour:"2-digit", minute:"2-digit"});
  }

  function fmtDay(ts){
    var d = new Date(ts);
    var today = new Date();
    var yday = new Date(today.getTime() - 86400000);
    var same = function(a,b){
      return a.getFullYear()===b.getFullYear() && a.getMonth()===b.getMonth() && a.getDate()===b.getDate();
    };
    if (same(d,today)) return "Today";
    if (same(d,yday)) return "Yesterday";
    return d.toLocaleDateString([], {weekday:"short", month:"short", day:"numeric", year: d.getFullYear()===today.getFullYear()?undefined:"numeric"});
  }

  function fmtNum(n){ return (n||0).toLocaleString(); }

  function get(url){
    return fetch(url, {cache:"no-store"}).then(function(r){
      if (!r.ok) throw new Error("request failed: " + r.status);
      return r.json();
    });
  }

  // --- the band of beliefs above the feed ---

  function renderBeliefs(data){
    var band = el("beliefBand");
    var b = data.beliefs || [];
    var head = '<div class="lede"><h2>What memory holds</h2>' +
      '<span class="note">' + fmtNum(data.counts.activeBeliefs) + ' active' +
      (data.counts.supersededBeliefs ? ', ' + fmtNum(data.counts.supersededBeliefs) + ' superseded' : '') +
      '</span></div>';

    if (b.length === 0){
      var why = data.counts.observations
        ? "Nothing consolidated yet. Beliefs form when a session ends, or run consolidation by hand."
        : "Nothing observed yet. Beliefs appear here once there is something to derive them from.";
      band.innerHTML = head + '<div class="empty">' + esc(why) + '</div>';
      return;
    }

    var folded = state.bandFolded !== false && b.length > 8;
    var cards = b.map(function(x){
      var was = x.supersedes
        ? '<span class="was">was <s>' + esc(x.supersedes.value) + '</s></span>'
        : '';
      return '<button class="belief" data-belief="' + esc(x.id) + '">' +
        '<span class="pred">' + esc(x.predicate) + '</span>' +
        '<span class="val">' + esc(x.value) + '</span>' + was +
        '<span class="foot"><span>' + x.effectiveConfidence.toFixed(2) + '</span>' +
        '<span>' + x.observationCount + ' source' + (x.observationCount===1?'':'s') + '</span></span>' +
        '</button>';
    }).join("");
    band.innerHTML = head +
      '<div class="beliefs' + (folded ? ' folded' : '') + '">' + cards + '</div>' +
      (b.length > 8
        ? '<button class="bandmore" id="bandmore">' +
          (folded ? 'Show all ' + b.length + ' beliefs' : 'Fold beliefs away') +
          '</button>'
        : '');

    var toggle = document.getElementById("bandmore");
    if (toggle){
      toggle.addEventListener("click", function(){
        state.bandFolded = !folded;
        renderBeliefs(data);
      });
    }
  }

  // --- the feed ---

  function cardFor(item){
    var when = fmtTime(item.ts);
    var proj = item.projectName || item.project || "";

    if (item.kind === "episode"){
      return '<button class="card episode" data-episode="' + esc(item.id) + '">' +
        '<span class="chead">' +
          '<span class="tag acct">' + esc(item.episodeKind || "account") + '</span>' +
          (proj ? '<span class="proj">' + esc(proj) + '</span>' : '') +
          '<span class="when">' + when + '</span>' +
        '</span>' +
        '<p class="ctitle">' + esc(item.title) + '</p>' +
        (item.subtitle ? '<p class="csub">' + esc(item.subtitle) + '</p>' : '') +
        ((item.factCount || item.fileCount) ?
          '<span class="cfoot">' +
            (item.factCount ? '<span>' + item.factCount + ' facts</span>' : '') +
            (item.fileCount ? '<span>' + item.fileCount + ' files</span>' : '') +
          '</span>' : '') +
        '</button>';
    }

    // A routine's instructions are worth keeping and are not something the
    // person said this morning. Same card, different name for it.
    var scheduled = item.kind === "scheduled";
    var label = scheduled ? "scheduled run" : "you said";
    return '<button class="card ' + item.kind + '" data-observation="' + esc(item.id) + '">' +
      '<span class="chead">' +
        '<span class="tag ' + (scheduled ? 'ran' : 'said') + '">' + esc(label) + '</span>' +
        (proj ? '<span class="proj">' + esc(proj) + '</span>' : '') +
        '<span class="when">' + when + '</span>' +
      '</span>' +
      '<p class="cbody' + (item.truncated ? ' fade' : '') + '">' + esc(item.excerpt) + '</p>' +
      (item.beliefCount ?
        '<span class="cfoot"><span class="became">became ' + item.beliefCount +
        ' belief' + (item.beliefCount===1?'':'s') + '</span></span>' : '') +
      '</button>';
  }

  function renderFeed(items, append){
    var host = el("feed");
    var html = "";
    var lastDay = append && state.items.length
      ? fmtDay(state.items[state.items.length - items.length - 1] ? state.items[state.items.length - items.length - 1].ts : 0)
      : "";

    if (!append) lastDay = "";
    items.forEach(function(item){
      var day = fmtDay(item.ts);
      if (day !== lastDay){
        html += '<div class="day">' + esc(day) + '</div>';
        lastDay = day;
      }
      html += cardFor(item);
    });

    if (append) host.insertAdjacentHTML("beforeend", html);
    else host.innerHTML = html || emptyLedger();
  }

  // The first thing a new install shows. Someone arriving here with a
  // claude-mem store already full of history should be told, once, that they
  // do not have to start over.
  function emptyLedger(){
    return '<div class="empty">Nothing here yet. Say something to Claude Code ' +
      'and it lands in this ledger.<br><br>' +
      'Already using claude-mem? <code>remem-import</code> brings it across ' +
      'in one command.</div>';
  }

  function loadFeed(append){
    var url = "/api/feed?limit=40";
    if (state.project) url += "&project=" + encodeURIComponent(state.project);
    // "You said" is the ledger proper. "What happened" is the derived account
    // of it. Everything interleaves both, which is the default because that is
    // the order the work actually happened in.
    if (state.kinds) url += "&kinds=" + encodeURIComponent(state.kinds);
    // Both halves of the cursor: time alone stops at the first group of items
    // sharing a millisecond and never gets past it.
    if (append && state.cursor) {
      url += "&before=" + state.cursor.ts +
             "&beforeId=" + encodeURIComponent(state.cursor.id);
    }

    return get(url).then(function(page){
      state.cursor = page.nextCursor || null;
      if (append) state.items = state.items.concat(page.items);
      else state.items = page.items;
      renderFeed(page.items, append);
      el("more").hidden = !page.hasMore;
      el("feedTitle").textContent = "The ledger";
      el("feedNote").textContent = state.counts
        ? fmtNum(state.counts.prompts) + " things you said, " +
          fmtNum(state.counts.episodes) + " accounts of what happened"
        : "";
    });
  }

  function runSearch(query){
    if (!query){
      el("more").hidden = false;
      return loadFeed(false);
    }
    var url = "/api/search?q=" + encodeURIComponent(query);
    if (state.project) url += "&project=" + encodeURIComponent(state.project);
    return get(url).then(function(res){
      el("feedTitle").textContent = "Search";
      el("feedNote").textContent = res.total + " result" + (res.total===1?"":"s") +
        (res.usedFts ? "" : " (scan)");
      el("more").hidden = true;
      var host = el("feed");
      if (!res.hits.length){
        host.innerHTML = '<div class="empty">Nothing matched ' + esc(query) + '.</div>';
        return;
      }
      host.innerHTML = res.hits.map(function(h){
        var attr = h.kind === "episode" ? "data-episode"
                 : h.kind === "belief" ? "data-belief" : "data-observation";
        var cls = h.kind === "episode" ? "episode" : (h.kind === "belief" ? "" : "prompt");
        return '<button class="card ' + cls + '" ' + attr + '="' + esc(h.id) + '">' +
          '<span class="chead"><span class="tag">' + esc(h.kind) + '</span>' +
          (h.project ? '<span class="proj">' + esc(h.project) + '</span>' : '') +
          '<span class="when">' + fmtDay(h.ts) + '</span></span>' +
          '<p class="ctitle">' + esc(h.title) + '</p>' +
          (h.excerpt ? '<p class="csub">' + esc(h.excerpt) + '</p>' : '') +
          '</button>';
      }).join("");
    });
  }

  // --- the drawer: what a single thing actually was ---

  function openDrawer(){
    el("drawer").classList.add("on");
    el("drawer").setAttribute("aria-hidden","false");
    el("scrim").classList.add("on");
  }

  function closeDrawer(){
    el("drawer").classList.remove("on");
    el("drawer").setAttribute("aria-hidden","true");
    el("scrim").classList.remove("on");
  }

  function relObservation(o){
    return '<button class="rel" data-observation="' + esc(o.id) + '">' +
      '<span class="quote">' + esc(o.content.length > 320 ? o.content.slice(0,320) + "..." : o.content) +
      '<span class="m">' + esc(o.actor) + ', ' + fmtDay(o.ts) + ' ' + fmtTime(o.ts) + '</span></span>' +
      '</button>';
  }

  function showObservation(id){
    openDrawer();
    el("dbody").innerHTML = '<div class="loading">Loading...</div>';
    get("/api/observation/" + encodeURIComponent(id)).then(function(d){
      var wasScheduled = d.origin === "scheduled";
      el("dtag").className = "tag " + (wasScheduled ? "ran" : "said");
      el("dtag").textContent = wasScheduled ? "scheduled run" : "you said";
      el("dwhen").textContent = fmtDay(d.ts) + ", " + fmtTime(d.ts);

      var html = '<h3>' + (wasScheduled ? "What the routine asked for" : "The words, in full") +
        '</h3><p class="said">' + esc(d.content) + '</p>';

      html += '<h3>Where it came from</h3><dl class="meta">';
      if (d.projectName) html += '<dt>project</dt><dd>' + esc(d.projectName) + '</dd>';
      if (d.session && d.session.title) html += '<dt>session</dt><dd>' + esc(d.session.title) + '</dd>';
      if (d.promptNumber) html += '<dt>turn</dt><dd>' + d.promptNumber + '</dd>';
      html += '<dt>recorded</dt><dd>' + new Date(d.ts).toLocaleString() + '</dd>';
      html += '<dt>id</dt><dd>' + esc(d.id) + '</dd></dl>';

      if (d.beliefs.length){
        html += '<h3>What memory made of it</h3>' + d.beliefs.map(function(b){
          return '<button class="rel" data-belief="' + esc(b.id) + '">' +
            '<span class="k">' + esc(b.predicate) + '</span>' +
            '<span class="v">' + esc(b.value) + '</span>' +
            '<span class="m">' + esc(b.status) + ', confidence ' + b.confidence.toFixed(2) + '</span>' +
            '</button>';
        }).join("");
      } else {
        html += '<h3>What memory made of it</h3><div class="empty">Nothing yet. This observation is on the record but has not been consolidated into a belief.</div>';
      }

      if (d.episodes.length){
        html += '<h3>Accounts drawn from it</h3>' + d.episodes.map(function(e){
          return '<button class="rel" data-episode="' + esc(e.id) + '">' +
            '<span class="k">' + esc(e.kind) + '</span>' +
            '<span class="v">' + esc(e.title) + '</span>' +
            '<span class="m">' + fmtDay(e.ts) + '</span></button>';
        }).join("");
      }

      el("dbody").innerHTML = html;
    }).catch(function(err){
      el("dbody").innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
    });
  }

  function showEpisode(id){
    openDrawer();
    el("dbody").innerHTML = '<div class="loading">Loading...</div>';
    get("/api/episode/" + encodeURIComponent(id)).then(function(d){
      var e = d.episode;
      el("dtag").className = "tag acct";
      el("dtag").textContent = e.kind;
      el("dwhen").textContent = fmtDay(e.ts) + ", " + fmtTime(e.ts);

      var html = '<div class="acct"><div class="t">' + esc(e.title) + '</div>' +
        (e.subtitle ? '<div>' + esc(e.subtitle) + '</div>' : '') + '</div>';

      if (e.narrative) html += '<h3>What happened</h3><p class="cbody">' + esc(e.narrative) + '</p>';

      if (e.facts && e.facts.length){
        html += '<h3>Facts</h3><ul class="facts">' +
          e.facts.map(function(f){ return '<li>' + esc(f) + '</li>'; }).join("") + '</ul>';
      }

      var files = (e.filesChanged || []).concat(e.filesRead || []);
      if (files.length){
        html += '<h3>Files</h3><div class="files">' +
          files.slice(0,40).map(function(f){ return '<span class="file">' + esc(f) + '</span>'; }).join("") +
          '</div>';
      }

      if (e.concepts && e.concepts.length){
        html += '<h3>Concepts</h3><div class="files">' +
          e.concepts.map(function(c){ return '<span class="file">' + esc(c) + '</span>'; }).join("") +
          '</div>';
      }

      html += '<h3>What this was drawn from</h3>';
      html += d.observations.length
        ? d.observations.map(relObservation).join("")
        : '<div class="empty">No source observation recorded for this account.</div>';

      el("dbody").innerHTML = html;
    }).catch(function(err){
      el("dbody").innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
    });
  }

  function showBelief(id){
    openDrawer();
    el("dbody").innerHTML = '<div class="loading">Loading...</div>';
    get("/api/belief/" + encodeURIComponent(id)).then(function(d){
      el("dtag").className = "tag acct";
      el("dtag").textContent = d.status;
      el("dwhen").textContent = "since " + fmtDay(d.createdTs);

      var html = '<div class="acct"><div class="t">' + esc(d.value) + '</div>' +
        '<div>' + esc(d.predicate) + '</div></div>';

      html += '<h3>Standing</h3><dl class="meta">' +
        '<dt>confidence</dt><dd>' + d.confidence.toFixed(2) + ' stored, ' +
        d.effectiveConfidence.toFixed(2) + ' after decay</dd>' +
        '<dt>first held</dt><dd>' + new Date(d.createdTs).toLocaleString() + '</dd>' +
        '<dt>last reinforced</dt><dd>' + new Date(d.lastReinforcedTs).toLocaleString() + '</dd>' +
        (d.scope && d.scope.project ? '<dt>scope</dt><dd>' + esc(d.scope.project) + '</dd>' : '') +
        '</dl>';

      html += '<h3>Why memory believes it</h3>';
      html += d.observations.length
        ? d.observations.map(relObservation).join("")
        : '<div class="empty">No provenance recorded. A belief without a source should not exist; this one predates provenance tracking.</div>';

      el("dbody").innerHTML = html;
    }).catch(function(err){
      el("dbody").innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
    });
  }

  // --- wiring ---

  document.addEventListener("click", function(ev){
    var t = ev.target.closest("[data-observation],[data-episode],[data-belief]");
    if (!t) return;
    if (t.hasAttribute("data-observation")) showObservation(t.getAttribute("data-observation"));
    else if (t.hasAttribute("data-episode")) showEpisode(t.getAttribute("data-episode"));
    else showBelief(t.getAttribute("data-belief"));
  });

  el("dclose").addEventListener("click", closeDrawer);
  el("scrim").addEventListener("click", closeDrawer);
  document.addEventListener("keydown", function(ev){
    if (ev.key === "Escape") closeDrawer();
    if (ev.key === "/" && document.activeElement !== el("q")){
      ev.preventDefault(); el("q").focus();
    }
  });

  el("more").addEventListener("click", function(){ loadFeed(true); });

  el("filters").addEventListener("click", function(ev){
    var b = ev.target.closest(".filter");
    if (!b) return;
    [].forEach.call(el("filters").children, function(c){ c.classList.remove("on"); });
    b.classList.add("on");
    state.kinds = b.getAttribute("data-kinds");
    state.cursor = null;
    el("q").value = "";
    state.query = "";
    loadFeed(false);
  });

  var debounce = null;
  el("q").addEventListener("input", function(){
    clearTimeout(debounce);
    var v = el("q").value.trim();
    debounce = setTimeout(function(){
      state.query = v;
      runSearch(v);
    }, 220);
  });

  el("project").addEventListener("change", function(){
    state.project = el("project").value;
    state.cursor = null;
    refresh(true);
  });

  el("theme").addEventListener("click", function(){
    var root = document.documentElement;
    var now = root.getAttribute("data-theme");
    var next = now === "dark" ? "light" : (now === "light" ? "dark" : "light");
    root.setAttribute("data-theme", next);
    try { localStorage.setItem("remem-theme", next); } catch (e) {}
  });

  try {
    var saved = localStorage.getItem("remem-theme");
    if (saved) document.documentElement.setAttribute("data-theme", saved);
  } catch (e) {}

  function renderTally(c){
    el("tally").innerHTML =
      '<span><b>' + fmtNum(c.prompts) + '</b> said</span>' +
      '<span><b>' + fmtNum(c.episodes) + '</b> happened</span>' +
      '<span><b>' + fmtNum(c.activeBeliefs) + '</b> believed</span>';
  }

  function renderProjects(list){
    var sel = el("project");
    if (sel.options.length - 1 === list.length) return;
    var current = sel.value;
    sel.innerHTML = '<option value="">All projects</option>' + list.map(function(p){
      return '<option value="' + esc(p.name) + '">' + esc(p.name) + '</option>';
    }).join("");
    sel.value = current;
  }

  function refresh(reload){
    var url = "/api/overview";
    if (state.project) url += "?project=" + encodeURIComponent(state.project);
    return get(url).then(function(data){
      state.counts = data.counts;
      renderTally(data.counts);
      renderProjects(data.projects || []);
      renderBeliefs(data);
      var signature = [data.counts.observations, data.counts.episodes,
                       data.counts.activeBeliefs, data.counts.supersededBeliefs].join(":");
      var changed = signature !== state.lastSignature;
      state.lastSignature = signature;
      if (reload || changed){
        state.cursor = null;
        if (state.query) return runSearch(state.query);
        return loadFeed(false);
      }
    }).catch(function(err){
      el("feed").innerHTML = '<div class="empty">' + esc(err.message) + '</div>';
    });
  }

  refresh(true);
  // The store is a file another process is writing. Polling the counts is
  // cheap and means the page keeps up with a session running beside it.
  setInterval(function(){ refresh(false); }, 4000);
})();
</script>
</body>
</html>
`;
