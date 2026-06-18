/* =====================================================================
 * app.js — Shared chrome: top bar, sidebar navigation, content loading.
 * Depends on patterns-data.js, theme.js, progress.js, search.js, markdown.js,
 * and (for offline content) content.js (window.DSA_CONTENT).
 * ===================================================================== */
(function () {
  "use strict";

  var P = window.DSA_PATTERNS || [];
  var LEVELS = window.DSA_LEVELS || ["Beginner", "Intermediate", "Advanced", "Expert"];

  function pad(n) { return String(n).padStart(2, "0"); }
  function bySlug(slug) { return P.filter(function (p) { return p.slug === slug; })[0]; }
  function qparam(name) { return new URLSearchParams(location.search).get(name); }

  /* ---------------- Top bar ---------------- */
  function buildTopbar(activeSlug) {
    var bar = document.getElementById("topbar");
    if (!bar) return;
    bar.innerHTML =
      '<button class="menu-toggle" id="menu-toggle" aria-label="Menu">☰</button>' +
      '<a class="brand" href="dsa.html"><span class="logo">DSA</span>' +
      '<span class="full">Patterns Handbook</span></a>' +
      '<div class="grow"></div>' +
      '<div class="search-wrap">' +
      '<span class="icon">🔍</span>' +
      '<input id="global-search" type="text" placeholder="Search patterns, LeetCode #, keywords…  (press /)" autocomplete="off">' +
      '<div class="search-results" id="search-results"></div>' +
      '</div>' +
      '<div class="grow"></div>' +
      '<a class="btn" href="pattern-selector.html" title="Pattern Selector">🧭 Selector</a>' +
      '<a class="btn" href="index.html" title="All handbooks">⌂ zariya.in</a>' +
      '<div class="theme-switch" id="theme-switch"></div>';

    if (window.DSASearch) window.DSASearch.attach("global-search", "search-results");

    var toggle = document.getElementById("menu-toggle");
    if (toggle) toggle.addEventListener("click", function () {
      var sb = document.getElementById("sidebar");
      var scrim = document.getElementById("scrim");
      if (sb) sb.classList.toggle("open");
      if (scrim) scrim.classList.toggle("show");
    });
  }

  /* ---------------- Sidebar ---------------- */
  function buildSidebar(activeSlug) {
    var sb = document.getElementById("sidebar");
    if (!sb) return;
    var html = '<h4>All 100 Patterns</h4>';

    LEVELS.forEach(function (level) {
      var inLevel = P.filter(function (p) { return p.level === level; });
      if (!inLevel.length) return;
      var collapsed = activeSlug && !inLevel.some(function (p) { return p.slug === activeSlug; });
      var done = inLevel.filter(function (p) { return window.DSAProgress && window.DSAProgress.isComplete(p.slug); }).length;

      html += '<div class="nav-group ' + (collapsed ? "collapsed" : "") + '" data-level="' + level + '">';
      html += '<div class="nav-group-head"><span>' + level + ' <span class="muted" style="font-weight:400">(' + done + "/" + inLevel.length + ')</span></span><span class="caret">▾</span></div>';
      html += '<div class="nav-items">';

      // group by category within level, preserving manifest order
      var cats = [];
      inLevel.forEach(function (p) { if (cats.indexOf(p.category) === -1) cats.push(p.category); });
      cats.forEach(function (cat) {
        html += '<div class="nav-cat">' + cat + "</div>";
        inLevel.filter(function (p) { return p.category === cat; }).forEach(function (p) {
          var active = p.slug === activeSlug ? " active" : "";
          var isDone = window.DSAProgress && window.DSAProgress.isComplete(p.slug);
          html += '<a class="nav-link' + active + '" href="pattern.html?p=' + p.slug + '">' +
            '<span class="num">' + pad(p.id) + "</span><span>" + p.name + "</span>" +
            (isDone ? '<span class="done">✓</span>' : "") + "</a>";
        });
      });
      html += "</div></div>";
    });

    html += '<div style="margin-top:18px;padding:0 8px">' +
      '<a class="nav-link" href="view.html?f=roadmap/000-ROADMAP.md">🗺️ Full Roadmap</a>' +
      '<a class="nav-link" href="pattern-selector.html">🧭 Pattern Selector</a>' +
      '<a class="nav-link" href="dsa.html#dashboard">📊 Progress Dashboard</a>' +
      '<a class="nav-link" href="view.html?f=resources/big-o-cheatsheet.md">⏱️ Big-O Cheat Sheet</a>' +
      '<a class="nav-link" href="view.html?f=resources/pattern-decision-guide.md">🧭 Decision Guide</a>' +
      "</div>";

    sb.innerHTML = html;

    sb.querySelectorAll(".nav-group-head").forEach(function (head) {
      head.addEventListener("click", function () { head.parentElement.classList.toggle("collapsed"); });
    });

    // close mobile sidebar on link click
    sb.querySelectorAll(".nav-link").forEach(function (a) {
      a.addEventListener("click", function () {
        if (window.innerWidth <= 1000) {
          sb.classList.remove("open");
          var scrim = document.getElementById("scrim"); if (scrim) scrim.classList.remove("show");
        }
      });
    });
  }

  /* ---------------- Back to top ---------------- */
  function backToTop() {
    var btn = document.createElement("button");
    btn.className = "back-to-top"; btn.innerHTML = "↑"; btn.title = "Back to top";
    btn.addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });
    document.body.appendChild(btn);
    window.addEventListener("scroll", function () { btn.classList.toggle("show", window.scrollY > 500); });
  }

  /* ---------------- Content loading (offline-first) ---------------- */
  function loadContent(slug) {
    // 1) embedded registry (works under file://)
    if (window.DSA_CONTENT && window.DSA_CONTENT[slug]) {
      return Promise.resolve(window.DSA_CONTENT[slug]);
    }
    // 2) fetch the markdown file (works when served over http)
    return fetch("markdown/" + slug + ".md").then(function (r) {
      if (!r.ok) throw new Error("not found");
      return r.text();
    });
  }

  /* ---------------- Public API ---------------- */
  window.DSAApp = {
    pad: pad,
    bySlug: bySlug,
    qparam: qparam,
    initChrome: function (activeSlug) {
      buildTopbar(activeSlug);
      buildSidebar(activeSlug);
      backToTop();
      if (window.DSAProgress) window.DSAProgress.onChange(function () { buildSidebar(activeSlug); });
    },
    loadContent: loadContent,
    neighbors: function (slug) {
      var idx = P.findIndex(function (p) { return p.slug === slug; });
      return { prev: idx > 0 ? P[idx - 1] : null, next: idx < P.length - 1 ? P[idx + 1] : null };
    }
  };
})();
