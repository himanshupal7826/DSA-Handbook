/* hb-search.js — generic search over window.HANDBOOK.items. */
(function () {
  function items() { return (window.HANDBOOK && window.HANDBOOK.items) || []; }
  function scoreMatch(p, q) {
    q = q.toLowerCase(); var score = 0, hits = []; var name = p.name.toLowerCase();
    if (name === q) score += 100;
    if (name.indexOf(q) === 0) score += 60;
    if (name.indexOf(q) !== -1) { score += 40; hits.push("name"); }
    if (String(p.id) === q) score += 30;
    if (p.category.toLowerCase().indexOf(q) !== -1) { score += 25; hits.push("category:" + p.category); }
    (p.keywords || []).forEach(function (k) { if (k.toLowerCase().indexOf(q) !== -1) { score += 15; hits.push("keyword:" + k); } });
    (p.refs || []).forEach(function (r) { if (r.toLowerCase().indexOf(q) !== -1) { score += 18; hits.push(r); } });
    if ((p.summary || "").toLowerCase().indexOf(q) !== -1) score += 10;
    return { score: score, hits: hits };
  }
  function search(q) {
    q = (q || "").trim(); if (!q) return [];
    var terms = q.split(/\s+/);
    var res = items().map(function (p) {
      var total = 0, hits = [];
      terms.forEach(function (t) { var r = scoreMatch(p, t); total += r.score; hits = hits.concat(r.hits); });
      return { p: p, score: total, hits: hits };
    }).filter(function (r) { return r.score > 0; });
    res.sort(function (a, b) { return b.score - a.score || a.p.id - b.p.id; });
    return res.slice(0, 12);
  }
  function hl(t, q) { if (!q) return t; try { return t.replace(new RegExp("(" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig"), "<mark>$1</mark>"); } catch (e) { return t; } }
  function attach(inputId, resultsId) {
    var input = document.getElementById(inputId), box = document.getElementById(resultsId);
    if (!input || !box) return;
    var active = -1, current = [];
    function close() { box.classList.remove("open"); box.innerHTML = ""; active = -1; }
    function go(slug) { window.location.href = "topic.html?p=" + slug; }
    function render(q) {
      current = search(q);
      if (!q) { close(); return; }
      if (!current.length) { box.innerHTML = '<div class="sr-empty">No matches for “' + q + '”.</div>'; box.classList.add("open"); return; }
      box.innerHTML = current.map(function (r) {
        var h = r.hits[0] ? " · " + r.hits[0] : "";
        return '<a class="sr-item" data-slug="' + r.p.slug + '"><div class="sr-title">' + String(r.p.id).padStart(2, "0") + ". " + hl(r.p.name, q) + '</div><div class="sr-meta">' + r.p.category + " · " + r.p.level + h + "</div></a>";
      }).join("");
      box.classList.add("open");
      box.querySelectorAll(".sr-item").forEach(function (el) { el.addEventListener("click", function () { go(el.dataset.slug); }); });
    }
    input.addEventListener("input", function () { active = -1; render(input.value); });
    input.addEventListener("focus", function () { if (input.value) render(input.value); });
    input.addEventListener("keydown", function (e) {
      var its = box.querySelectorAll(".sr-item");
      if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, its.length - 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); }
      else if (e.key === "Enter") { if (active >= 0 && its[active]) go(its[active].dataset.slug); else if (current[0]) go(current[0].p.slug); return; }
      else if (e.key === "Escape") { close(); input.blur(); return; }
      its.forEach(function (it, i) { it.classList.toggle("active", i === active); });
      if (its[active]) its[active].scrollIntoView({ block: "nearest" });
    });
    document.addEventListener("click", function (e) { if (!box.contains(e.target) && e.target !== input) close(); });
    document.addEventListener("keydown", function (e) { if (e.key === "/" && document.activeElement !== input && !/input|textarea/i.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); } });
  }
  window.DSASearch = { search: search, attach: attach };
})();
