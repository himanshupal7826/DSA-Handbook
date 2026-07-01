/* =====================================================================
 * pattern-extras.js — enhancements injected into pattern.html.
 *
 * Adds, without touching existing pattern-page behaviour:
 *   • Listen Mode      (Feature 6)  — SpeechSynthesis read-aloud w/ controls,
 *                                      sentence highlight, resume position.
 *   • Quick Revision   (Feature 7)  — floating widget + slide-out drawer.
 *   • Video + Resources(Features 5/16) — free-only recommendations.
 *   • Smart Recommends (Feature 10) — next/related/weak/revision/follow-ups.
 *   • Pattern-complete XP sync into the Journey engine (Feature 9).
 *
 * Depends on: DSA_PATTERNS, DSAApp, DSAProgress, DSAJourney, DSA_CONTENT.
 * Everything is offline-safe (no fetch beyond what app.js already does).
 * ===================================================================== */
(function () {
  "use strict";
  if (!window.DSAJourney) return;

  var J = window.DSAJourney;
  var slug = new URLSearchParams(location.search).get("p") || "01-frequency-counter";
  var pattern = (window.DSA_PATTERNS || []).filter(function (p) { return p.slug === slug; })[0];
  if (!pattern) return;

  function esc(s) { return String(s == null ? "" : s).replace(/[&<>"]/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]; }); }

  /* =================================================================== */
  /* XP sync — award once when a pattern is marked complete, revoke on    */
  /* un-complete. Idempotent via the engine's xpLog.                      */
  /* =================================================================== */
  // Awarding is idempotent (guarded by the engine's xpLog). Un-completing a
  // pattern intentionally KEEPS the earned XP — like a badge you don't lose.
  function syncPatternXP() {
    if (!window.DSAProgress) return;
    if (window.DSAProgress.isComplete(slug)) J.awardXP("pattern:" + slug, 20, "Completed pattern");
  }
  if (window.DSAProgress) {
    syncPatternXP();
    window.DSAProgress.onChange(syncPatternXP);
  }
  // First visit to any pattern page counts as "opening the handbook".
  J.awardXP("first-open", 5, "Opened the handbook");

  /* =================================================================== */
  /* LISTEN MODE                                                          */
  /* =================================================================== */
  var Listen = (function () {
    var synth = window.speechSynthesis;
    var supported = !!synth && !!window.SpeechSynthesisUtterance;
    var sections = [];      // [{title, sentences:[...]}]
    var queue = [];         // flat [{sec, si, text}]
    var idx = 0;            // current queue index
    var playing = false, paused = false;
    var voices = [];
    var barEl, transcriptEl, progEl, titleEl;

    function build() {
      var raw = J.listenSections(slug);
      sections = raw.map(function (s) {
        return { title: s.title, sentences: splitSentences(s.text) };
      });
      queue = [];
      sections.forEach(function (s, si) {
        s.sentences.forEach(function (sent) { queue.push({ sec: si, text: sent }); });
      });
    }
    function splitSentences(text) {
      var parts = String(text).match(/[^.!?]+[.!?]+|\S[^.!?]*$/g) || [text];
      return parts.map(function (p) { return p.trim(); }).filter(Boolean);
    }

    function ensureBar() {
      if (barEl) return;
      barEl = document.createElement("div");
      barEl.className = "j-listen-bar";
      barEl.innerHTML =
        '<div class="j-listen-row">' +
        '<div class="j-listen-title">🎧 Listen — <span id="lb-sec"></span> <small id="lb-count"></small></div>' +
        '<button class="j-listen-close" title="Close" id="lb-close">×</button></div>' +
        '<div id="lb-transcript" class="j-detail-block" style="min-height:38px;font-size:13.5px"></div>' +
        '<div class="j-listen-progress"><span id="lb-prog"></span></div>' +
        '<div class="j-listen-row" style="justify-content:center;gap:8px">' +
        '<button class="j-lb-btn" id="lb-restart" title="Restart">⏮</button>' +
        '<button class="j-lb-btn" id="lb-prevsec" title="Previous section">⏪</button>' +
        '<button class="j-lb-btn play" id="lb-play" title="Play / Pause">▶</button>' +
        '<button class="j-lb-btn" id="lb-skip" title="Skip section">⏩</button>' +
        '<select id="lb-rate" title="Playback speed">' +
        '<option value="0.75">0.75×</option><option value="1" selected>1×</option>' +
        '<option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option></select>' +
        '<select id="lb-voice" title="Voice"></select>' +
        '</div>';
      document.body.appendChild(barEl);
      transcriptEl = barEl.querySelector("#lb-transcript");
      progEl = barEl.querySelector("#lb-prog");
      titleEl = barEl.querySelector("#lb-sec");

      barEl.querySelector("#lb-close").onclick = function () { stop(); barEl.classList.remove("show"); };
      barEl.querySelector("#lb-play").onclick = toggle;
      barEl.querySelector("#lb-restart").onclick = function () { idx = 0; if (playing) { synth.cancel(); speakCurrent(); } else render(); };
      barEl.querySelector("#lb-skip").onclick = function () { skipSection(1); };
      barEl.querySelector("#lb-prevsec").onclick = function () { skipSection(-1); };
      barEl.querySelector("#lb-rate").onchange = function () {
        J.setPref("rate", parseFloat(this.value));
        if (playing) { synth.cancel(); speakCurrent(); }
      };
      barEl.querySelector("#lb-voice").onchange = function () {
        J.setPref("voice", this.value);
        if (playing) { synth.cancel(); speakCurrent(); }
      };
      loadVoices();
      if (synth) synth.onvoiceschanged = loadVoices;

      // restore saved rate
      var r = J.getPref("rate", 1);
      barEl.querySelector("#lb-rate").value = String(r);
    }

    function loadVoices() {
      if (!synth) return;
      voices = synth.getVoices().filter(function (v) { return /en/i.test(v.lang); });
      if (!voices.length) voices = synth.getVoices();
      var sel = barEl.querySelector("#lb-voice");
      var saved = J.getPref("voice", null);
      sel.innerHTML = voices.map(function (v) {
        return '<option value="' + esc(v.name) + '"' + (v.name === saved ? " selected" : "") + '>' + esc(v.name.replace(/\(.*\)/, "").trim()) + '</option>';
      }).join("");
    }
    function currentVoice() {
      var name = J.getPref("voice", null);
      return voices.filter(function (v) { return v.name === name; })[0] || voices[0] || null;
    }

    function open() {
      if (!supported) { alert("Your browser doesn't support the Speech Synthesis API used by Listen mode."); return; }
      if (!queue.length) build();
      ensureBar();
      barEl.classList.add("show");
      // resume position
      var pos = J.getListenPos(slug);
      if (pos && pos.idx != null && pos.idx < queue.length && idx === 0) idx = pos.idx;
      render();
    }
    function toggle() {
      if (!playing) { play(); }
      else if (paused) { synth.resume(); paused = false; setPlayIcon(); }
      else { synth.pause(); paused = true; setPlayIcon(); }
    }
    function play() { playing = true; paused = false; setPlayIcon(); speakCurrent(); }
    function stop() { playing = false; paused = false; if (synth) synth.cancel(); setPlayIcon(); }

    function speakCurrent() {
      if (!synth) return;
      synth.cancel();
      if (idx >= queue.length) { playing = false; setPlayIcon(); toast("Finished ✓"); J.setListenPos(slug, { idx: 0 }); idx = 0; render(); return; }
      var item = queue[idx];
      var u = new SpeechSynthesisUtterance(item.text);
      u.rate = J.getPref("rate", 1);
      var v = currentVoice(); if (v) u.voice = v;
      u.onend = function () {
        if (!playing || paused) return;
        idx++; J.setListenPos(slug, { idx: idx });
        speakCurrent();
      };
      render();
      synth.speak(u);
    }
    function skipSection(dir) {
      if (!queue.length) return;
      var curSec = queue[Math.min(idx, queue.length - 1)].sec;
      var target = curSec + dir;
      // find first queue item of target section
      var found = -1;
      for (var i = 0; i < queue.length; i++) { if (queue[i].sec === target) { found = i; break; } }
      if (found < 0) { found = dir > 0 ? queue.length : 0; }
      idx = Math.max(0, Math.min(queue.length, found));
      if (playing) { synth.cancel(); speakCurrent(); } else render();
    }
    function setPlayIcon() {
      if (!barEl) return;
      barEl.querySelector("#lb-play").textContent = (playing && !paused) ? "⏸" : "▶";
    }
    function render() {
      if (!barEl) return;
      var item = queue[Math.min(idx, queue.length - 1)] || { sec: 0, text: "" };
      var sec = sections[item.sec] || { title: "", sentences: [] };
      titleEl.textContent = sec.title;
      barEl.querySelector("#lb-count").textContent = "(" + Math.min(idx + 1, queue.length) + "/" + queue.length + ")";
      // transcript: show the section with the current sentence highlighted
      transcriptEl.innerHTML = sec.sentences.map(function (s) {
        var isCur = queue[idx] && queue[idx].sec === item.sec && s === queue[idx].text;
        return isCur ? '<span class="j-speaking">' + esc(s) + '</span>' : esc(s);
      }).join(" ");
      progEl.style.width = Math.round((idx / Math.max(1, queue.length)) * 100) + "%";
      setPlayIcon();
      // scroll the matching heading into view on the page
      scrollToSection(sec.title);
    }
    function scrollToSection(title) {
      if (!title) return;
      var hs = document.querySelectorAll("#content h2");
      for (var i = 0; i < hs.length; i++) {
        if (hs[i].textContent.toLowerCase().indexOf(title.toLowerCase()) >= 0) {
          // only auto-scroll when playing to avoid hijacking manual reading
          if (playing) hs[i].scrollIntoView({ behavior: "smooth", block: "center" });
          break;
        }
      }
    }
    // pause synthesis if the tab is hidden (browsers can be flaky otherwise)
    document.addEventListener("visibilitychange", function () {
      if (document.hidden && playing && !paused && synth) { synth.pause(); paused = true; setPlayIcon(); }
    });
    return { open: open, stop: stop };
  })();

  /* =================================================================== */
  /* QUICK REVISION DRAWER                                                */
  /* =================================================================== */
  var Quick = (function () {
    var drawer;
    function decisionTree(p) {
      // A tiny generic decision aid keyed by category.
      var t = {
        "Sliding Window": "Contiguous subarray/substring?\n├─ Fixed length k? → Fixed Window\n└─ Constraint (≤k distinct, sum≥t)? → Variable Window\n     ├─ maximise length → grow, shrink when invalid\n     └─ minimise length → shrink while valid",
        "Two Pointers": "Sorted / symmetric input?\n├─ Pair/triplet to target? → opposite ends, converge\n└─ In-place filter/compact? → slow/fast, same direction",
        "Binary Search": "Monotonic search space?\n├─ Search a value in sorted array → classic / bounds\n└─ Minimise/maximise a feasible answer → binary search on answer",
        "Dynamic Programming": "Optimal substructure + overlap?\n├─ 1D state (index) → linear DP\n├─ 2D (two sequences/grid) → table DP\n└─ Subset/state → bitmask DP",
        "Graphs": "Graph problem?\n├─ Shortest unweighted → BFS\n├─ Connectivity / cycle → DFS / Union-Find\n└─ Ordering with deps → Topological sort",
        "Heaps": "Need k-best / streaming order?\n├─ Top-k → size-k heap\n└─ Running median → two heaps"
      };
      return t[p.category] || ("Is this a " + p.category + " problem?\n├─ Match the recognition signals →\n└─ Apply the template, then verify complexity.");
    }
    function build() {
      var c = J.revisionCard(slug);
      drawer = document.createElement("div");
      drawer.className = "j-drawer";
      drawer.innerHTML =
        '<button class="j-drawer-close" id="qr-close">×</button>' +
        '<h3>⚡ Quick Revision</h3>' +
        '<div class="j-muted" style="margin-bottom:12px">' + esc(c.name) + ' · ' + esc(c.category) + '</div>' +
        field("Recognition signals", list(c.recognition)) +
        field("Template reminder", esc(c.template)) +
        field("Complexities", esc(c.complexity)) +
        field("Common pitfalls", c.mistakes.length ? list(c.mistakes) : '<span class="j-muted">See §7 on the page.</span>') +
        field("Key formula", esc(c.formula)) +
        field("Mental model", esc(J.keyFormula(pattern))) +
        field("Decision tree", '<div class="j-tree">' + esc(decisionTree(pattern)) + '</div>') +
        field("One-minute review", c.oneMinute.length ? list(c.oneMinute) : esc(c.oneLiner)) +
        '<a class="j-btn primary" style="width:100%;justify-content:center;margin-top:6px" href="pattern.html?p=' + slug + '#15-revision-notes">Open full revision notes</a>';
      document.body.appendChild(drawer);
      drawer.querySelector("#qr-close").onclick = close;
    }
    function field(k, v) { return '<div class="j-rev-field"><span class="k">' + k + '</span>' + v + '</div>'; }
    function list(arr) { return '<ul>' + arr.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join("") + '</ul>'; }
    function open() { if (!drawer) build(); drawer.classList.add("open"); }
    function close() { if (drawer) drawer.classList.remove("open"); }
    return { open: open, close: close };
  })();

  /* =================================================================== */
  /* FLOATING BUTTONS + PAGE ACTION BUTTONS                               */
  /* =================================================================== */
  function addFloatingButtons() {
    var fab = document.createElement("button");
    fab.className = "j-fab"; fab.title = "Quick Revision (press Q)"; fab.innerHTML = "⚡";
    fab.onclick = Quick.open;
    document.body.appendChild(fab);

    // Listen + Quick buttons inside the existing page-actions row
    var actions = document.getElementById("page-actions");
    if (actions) {
      var listenBtn = document.createElement("button");
      listenBtn.className = "btn"; listenBtn.id = "b-listen"; listenBtn.innerHTML = "🎧 Listen";
      listenBtn.onclick = Listen.open;
      actions.appendChild(listenBtn);
    }
  }

  /* =================================================================== */
  /* VIDEOS + RESOURCES + SMART RECOMMENDATIONS (appended to page)        */
  /* =================================================================== */
  function levelPill(l) { return '<span class="j-pill ghost">' + esc(l) + '</span>'; }

  function buildVideoSection() {
    var vids = J.videosFor(pattern);
    return '<h2 class="section-title" id="resources"><span class="bar"></span>🎥 Free Video Recommendations</h2>' +
      '<p class="muted">Hand-picked free explainers. Beginner → Advanced. Marking one watched earns XP.</p>' +
      vids.map(function (v, i) {
        var initials = v.channel.split(" ").map(function (w) { return w[0]; }).join("").slice(0, 2).toUpperCase();
        return '<a class="j-video" href="' + v.url + '" target="_blank" rel="noopener" data-watch="1">' +
          '<div class="thumb" style="background:' + v.color + '">' + initials +
          '<span class="dur">' + v.duration + '</span></div>' +
          '<div class="v-body"><div class="v-title">' + esc(v.title) + '</div>' +
          '<div class="v-chan">' + esc(v.channel) + ' &nbsp; ' + levelPill(v.level) + '</div>' +
          '<div class="v-why">Why watch: ' + esc(v.why) + '</div></div></a>';
      }).join("") +
      '<button class="j-btn small" id="mark-watched" style="margin-top:6px">' +
      (J.isWatched(slug) ? "✓ Marked watched" : "Mark a video watched (+5 XP)") + '</button>';
  }

  function buildResourceSection() {
    var res = J.resourcesFor(pattern);
    return '<h2 class="section-title"><span class="bar"></span>📚 More Free Resources</h2>' +
      '<div class="j-card"><ul class="j-res-list">' +
      res.map(function (r) {
        return '<li><span class="r-ico">' + r.icon + '</span>' +
          '<div style="flex:1"><strong>' + esc(r.label) + '</strong> — <a href="' + r.url + '" ' +
          (/^https?:/.test(r.url) ? 'target="_blank" rel="noopener"' : '') + '>' + esc(r.detail) + '</a></div></li>';
      }).join("") + '</ul></div>';
  }

  function buildRecommendations() {
    var all = window.DSA_PATTERNS;
    var idx = all.findIndex(function (p) { return p.slug === slug; });
    var next = all[idx + 1];
    var related = all.filter(function (p) { return p.category === pattern.category && p.slug !== slug; }).slice(0, 4);
    // weak areas: lowest-completion categories
    var cats = J.categoryInsights();
    var weak = cats.slice(-3).reverse();
    // revision due for THIS pattern
    var studyDay = J.studyDayOf(slug);
    // frequently asked together: next few patterns in the same level bucket
    var together = all.filter(function (p) { return p.level === pattern.level && p.slug !== slug; }).slice(0, 4);

    function chip(p) { return '<a class="chip" href="pattern.html?p=' + p.slug + '">' + esc(p.name) + '</a>'; }

    var followUps = deriveFollowUps();

    return '<h2 class="section-title"><span class="bar"></span>🧭 Smart Recommendations</h2>' +
      '<div class="j-grid cols-2">' +
      '<div class="j-card"><strong>➡️ Next pattern</strong><div class="chips" style="margin-top:8px">' +
      (next ? chip(next) : '<span class="j-muted">You\'re at the end 🎉</span>') + '</div></div>' +
      '<div class="j-card"><strong>🔗 Related patterns</strong><div class="chips" style="margin-top:8px">' +
      (related.length ? related.map(chip).join("") : '<span class="j-muted">—</span>') + '</div></div>' +
      '<div class="j-card"><strong>⚠️ Your weak areas</strong><div class="chips" style="margin-top:8px">' +
      weak.map(function (c) { return '<span class="chip">' + esc(c.name) + ' · ' + c.pct + '%</span>'; }).join("") + '</div></div>' +
      '<div class="j-card"><strong>🔁 Revision schedule</strong><div class="j-muted" style="margin-top:8px">Studied on day ' + (studyDay || "—") +
      ' → revisions on days ' + J.REVISION_OFFSETS.map(function (o) { return (studyDay || 0) + o; }).join(", ") + '.</div></div>' +
      '<div class="j-card"><strong>💬 Common interview follow-ups</strong><ul class="j-muted" style="margin:8px 0 0;padding-left:18px">' +
      followUps.map(function (f) { return '<li>' + esc(f) + '</li>'; }).join("") + '</ul></div>' +
      '<div class="j-card"><strong>🤝 Frequently asked together</strong><div class="chips" style="margin-top:8px">' +
      together.map(chip).join("") + '</div></div>' +
      '</div>';
  }

  function deriveFollowUps() {
    var md = (window.DSA_CONTENT && window.DSA_CONTENT[slug]) || "";
    // pull questions from the "Interview Follow-Up" section if present
    var lines = md.split("\n");
    var cap = false, out = [];
    for (var i = 0; i < lines.length; i++) {
      if (/^##\s.*Follow-?Up/i.test(lines[i])) { cap = true; continue; }
      if (cap && /^##\s/.test(lines[i])) break;
      if (cap) {
        var m = lines[i].match(/^\s*(?:[-*]|\d+\.)\s+(.*?\?)/);
        if (m) out.push(m[1].replace(/[*`]/g, "").trim());
      }
    }
    if (out.length) return out.slice(0, 4);
    return [
      "Can you do it in one pass / O(1) extra space?",
      "How does the approach change for streaming / very large input?",
      "What if the input is not sorted — does the pattern still apply?",
      "How would you handle duplicates or edge cases (empty, single element)?"
    ];
  }

  function appendSections() {
    var main = document.querySelector("main.main");
    var pager = document.getElementById("pager");
    if (!main) return;
    var wrap = document.createElement("div");
    wrap.id = "pattern-extras";
    wrap.innerHTML = buildVideoSection() + buildResourceSection() + buildRecommendations();
    if (pager) main.insertBefore(wrap, pager); else main.appendChild(wrap);

    // wire watch tracking
    var markBtn = document.getElementById("mark-watched");
    wrap.querySelectorAll('[data-watch]').forEach(function (a) {
      a.addEventListener("click", function () {
        if (!J.isWatched(slug)) { J.toggleWatched(slug); if (markBtn) markBtn.textContent = "✓ Marked watched"; toast("+5 XP"); }
      });
    });
    if (markBtn) markBtn.onclick = function () {
      var on = J.toggleWatched(slug);
      markBtn.textContent = on ? "✓ Marked watched" : "Mark a video watched (+5 XP)";
      if (on) toast("+5 XP");
    };
  }

  /* =================================================================== */
  /* Toast + keyboard                                                     */
  /* =================================================================== */
  var toastEl, toastTimer;
  window.toast = function (msg) {
    if (!toastEl) { toastEl = document.createElement("div"); toastEl.className = "j-toast"; document.body.appendChild(toastEl); }
    toastEl.textContent = msg; toastEl.classList.add("show");
    clearTimeout(toastTimer); toastTimer = setTimeout(function () { toastEl.classList.remove("show"); }, 1600);
  };
  document.addEventListener("keydown", function (e) {
    if (/input|textarea|select/i.test((e.target.tagName || ""))) return;
    if (e.key === "q" || e.key === "Q") Quick.open();
    if (e.key === "l" || e.key === "L") Listen.open();
  });

  /* =================================================================== */
  /* Bootstrap — wait for the async-rendered markdown content, then wire. */
  /* =================================================================== */
  function boot() {
    addFloatingButtons();
    appendSections();
    // deep links
    if (location.hash === "#listen") Listen.open();
    if (location.hash === "#resources") {
      var r = document.getElementById("resources"); if (r) r.scrollIntoView();
    }
  }

  // #content is filled asynchronously by pattern.html. Observe until an <h1>
  // (or the fallback error block) appears, then boot exactly once.
  function waitForContent(cb) {
    var content = document.getElementById("content");
    if (!content) { window.addEventListener("DOMContentLoaded", function () { waitForContent(cb); }); return; }
    if (content.querySelector("h1")) { cb(); return; }
    var obs = new MutationObserver(function () {
      if (content.querySelector("h1")) { obs.disconnect(); cb(); }
    });
    obs.observe(content, { childList: true, subtree: true });
    // safety timeout
    setTimeout(function () { try { obs.disconnect(); } catch (e) {} cb(); }, 4000);
  }
  waitForContent(function () { if (!document.getElementById("pattern-extras")) boot(); });
})();
