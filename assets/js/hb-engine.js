/* hb-engine.js — generic handbook chrome (top bar, sidebar, content loader).
 * Handbook pages live one level below the portal root, so:
 *   portal      = ../index.html
 *   shared CSS  = ../assets/...
 *   topics      = topic.html?p=<slug>  (within the handbook folder)
 * Reads window.HANDBOOK (config) and window.HANDBOOK_CONTENT (offline md). */
(function () {
  function HB() { return window.HANDBOOK || { id: "", name: "Handbook", items: [], levels: [], categories: [], itemNoun: "Topic" }; }
  function pad(n) { return String(n).padStart(2, "0"); }
  function bySlug(slug) { return HB().items.filter(function (p) { return p.slug === slug; })[0]; }
  function qparam(n) { return new URLSearchParams(location.search).get(n); }

  function buildTopbar() {
    var bar = document.getElementById("topbar"); if (!bar) return;
    var hb = HB();
    bar.innerHTML =
      '<button class="menu-toggle" id="menu-toggle" aria-label="Menu">☰</button>' +
      '<a class="brand" href="index.html" title="' + hb.name + ' home"><span class="logo">' + (hb.icon || "📘") + '</span><span class="full">' + hb.name + '</span></a>' +
      '<div class="grow"></div>' +
      '<div class="search-wrap"><span class="icon">🔍</span>' +
      '<input id="global-search" type="text" placeholder="Search ' + hb.name + '…  (press /)" autocomplete="off">' +
      '<div class="search-results" id="search-results"></div></div>' +
      '<div class="grow"></div>' +
      '<a class="btn" href="../index.html" title="All handbooks">⌂ zariya.in</a>' +
      '<div class="theme-switch" id="theme-switch"></div>';
    if (window.DSASearch) window.DSASearch.attach("global-search", "search-results");
    var t = document.getElementById("menu-toggle");
    if (t) t.addEventListener("click", function () {
      var sb = document.getElementById("sidebar"), sc = document.getElementById("scrim");
      if (sb) sb.classList.toggle("open"); if (sc) sc.classList.toggle("show");
    });
  }

  function buildSidebar(activeSlug) {
    var sb = document.getElementById("sidebar"); if (!sb) return;
    var hb = HB();
    var html = '<h4>' + hb.items.length + ' ' + (hb.itemNoun || "Topic") + 's</h4>';
    (hb.levels || []).forEach(function (level) {
      var inLevel = hb.items.filter(function (p) { return p.level === level; });
      if (!inLevel.length) return;
      var collapsed = activeSlug && !inLevel.some(function (p) { return p.slug === activeSlug; });
      var done = inLevel.filter(function (p) { return window.DSAProgress && window.DSAProgress.isComplete(p.slug); }).length;
      html += '<div class="nav-group ' + (collapsed ? "collapsed" : "") + '">';
      html += '<div class="nav-group-head"><span>' + level + ' <span class="muted" style="font-weight:400">(' + done + "/" + inLevel.length + ')</span></span><span class="caret">▾</span></div><div class="nav-items">';
      var cats = []; inLevel.forEach(function (p) { if (cats.indexOf(p.category) === -1) cats.push(p.category); });
      cats.forEach(function (cat) {
        html += '<div class="nav-cat">' + cat + "</div>";
        inLevel.filter(function (p) { return p.category === cat; }).forEach(function (p) {
          var isDone = window.DSAProgress && window.DSAProgress.isComplete(p.slug);
          html += '<a class="nav-link' + (p.slug === activeSlug ? " active" : "") + '" href="topic.html?p=' + p.slug + '"><span class="num">' + pad(p.id) + '</span><span>' + p.name + '</span>' + (isDone ? '<span class="done">✓</span>' : "") + "</a>";
        });
      });
      html += "</div></div>";
    });
    html += '<div style="margin-top:18px;padding:0 8px">' +
      '<a class="nav-link" href="index.html">🏠 ' + hb.name + ' Home</a>' +
      '<a class="nav-link" href="../index.html">⌂ All Handbooks (zariya.in)</a></div>';
    sb.innerHTML = html;
    sb.querySelectorAll(".nav-group-head").forEach(function (h) { h.addEventListener("click", function () { h.parentElement.classList.toggle("collapsed"); }); });
    sb.querySelectorAll(".nav-link").forEach(function (a) { a.addEventListener("click", function () { if (window.innerWidth <= 1000) { sb.classList.remove("open"); var sc = document.getElementById("scrim"); if (sc) sc.classList.remove("show"); } }); });
  }

  function backToTop() {
    var b = document.createElement("button"); b.className = "back-to-top"; b.innerHTML = "↑"; b.title = "Top";
    b.addEventListener("click", function () { window.scrollTo({ top: 0, behavior: "smooth" }); });
    document.body.appendChild(b);
    window.addEventListener("scroll", function () { b.classList.toggle("show", window.scrollY > 500); });
  }

  function loadContent(slug) {
    if (window.HANDBOOK_CONTENT && window.HANDBOOK_CONTENT[slug]) return Promise.resolve(window.HANDBOOK_CONTENT[slug]);
    return fetch("markdown/" + slug + ".md").then(function (r) { if (!r.ok) throw new Error("404"); return r.text(); });
  }

  window.DSAApp = {
    pad: pad, bySlug: bySlug, qparam: qparam, loadContent: loadContent,
    initChrome: function (activeSlug) {
      buildTopbar(); buildSidebar(activeSlug); backToTop();
      if (window.DSAProgress) window.DSAProgress.onChange(function () { buildSidebar(activeSlug); });
    },
    neighbors: function (slug) {
      var it = HB().items, idx = it.findIndex(function (p) { return p.slug === slug; });
      return { prev: idx > 0 ? it[idx - 1] : null, next: idx < it.length - 1 ? it[idx + 1] : null };
    }
  };
})();
