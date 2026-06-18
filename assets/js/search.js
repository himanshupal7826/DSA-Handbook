/* =====================================================================
 * search.js — Fuzzy-ish search over pattern name, category, keywords,
 *             LeetCode problems and one-line summaries.
 * Renders a dropdown of results; navigates to pattern.html?p=<slug>.
 * ===================================================================== */
(function () {
  "use strict";

  function scoreMatch(p, q) {
    q = q.toLowerCase();
    var score = 0, hits = [];
    var name = p.name.toLowerCase();
    if (name === q) score += 100;
    if (name.indexOf(q) === 0) score += 60;
    if (name.indexOf(q) !== -1) { score += 40; hits.push("name"); }
    if (("pattern " + p.id).indexOf(q) !== -1 || String(p.id) === q) score += 30;
    if (p.category.toLowerCase().indexOf(q) !== -1) { score += 25; hits.push("category:" + p.category); }
    p.keywords.forEach(function (k) { if (k.toLowerCase().indexOf(q) !== -1) { score += 15; hits.push("keyword:" + k); } });
    p.leetcode.forEach(function (lc) { if (lc.toLowerCase().indexOf(q) !== -1) { score += 20; hits.push("LeetCode " + lc); } });
    if (p.summary.toLowerCase().indexOf(q) !== -1) { score += 10; }
    return { score: score, hits: hits };
  }

  function search(q) {
    q = (q || "").trim();
    if (!q) return [];
    var terms = q.split(/\s+/);
    var results = (window.DSA_PATTERNS || []).map(function (p) {
      var total = 0, allHits = [];
      terms.forEach(function (t) {
        var r = scoreMatch(p, t);
        total += r.score; allHits = allHits.concat(r.hits);
      });
      return { p: p, score: total, hits: allHits };
    }).filter(function (r) { return r.score > 0; });
    results.sort(function (a, b) { return b.score - a.score || a.p.id - b.p.id; });
    return results.slice(0, 12);
  }

  function hl(text, q) {
    if (!q) return text;
    try {
      var re = new RegExp("(" + q.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + ")", "ig");
      return text.replace(re, "<mark>$1</mark>");
    } catch (e) { return text; }
  }

  function attach(inputId, resultsId) {
    var input = document.getElementById(inputId);
    var box = document.getElementById(resultsId);
    if (!input || !box) return;
    var active = -1, current = [];

    function close() { box.classList.remove("open"); box.innerHTML = ""; active = -1; }

    function go(slug) { window.location.href = "pattern.html?p=" + slug; }

    function renderResults(q) {
      current = search(q);
      if (!q) { close(); return; }
      if (!current.length) {
        box.innerHTML = '<div class="sr-empty">No matches for “' + q + '”. Try: sliding window, 3sum, dijkstra, dp.</div>';
        box.classList.add("open"); return;
      }
      box.innerHTML = current.map(function (r, idx) {
        var firstHit = r.hits[0] ? " · " + r.hits[0] : "";
        return '<a class="sr-item" data-slug="' + r.p.slug + '" data-idx="' + idx + '">' +
          '<div class="sr-title">' + String(r.p.id).padStart(2, "0") + ". " + hl(r.p.name, q) + "</div>" +
          '<div class="sr-meta">' + r.p.category + " · " + r.p.level + firstHit + "</div></a>";
      }).join("");
      box.classList.add("open");
      box.querySelectorAll(".sr-item").forEach(function (el) {
        el.addEventListener("click", function () { go(el.dataset.slug); });
      });
    }

    input.addEventListener("input", function () { active = -1; renderResults(input.value); });
    input.addEventListener("focus", function () { if (input.value) renderResults(input.value); });
    input.addEventListener("keydown", function (e) {
      var items = box.querySelectorAll(".sr-item");
      if (e.key === "ArrowDown") { e.preventDefault(); active = Math.min(active + 1, items.length - 1); }
      else if (e.key === "ArrowUp") { e.preventDefault(); active = Math.max(active - 1, 0); }
      else if (e.key === "Enter") {
        if (active >= 0 && items[active]) go(items[active].dataset.slug);
        else if (current[0]) go(current[0].p.slug);
        return;
      } else if (e.key === "Escape") { close(); input.blur(); return; }
      items.forEach(function (it, i) { it.classList.toggle("active", i === active); });
      if (items[active]) items[active].scrollIntoView({ block: "nearest" });
    });

    document.addEventListener("click", function (e) {
      if (!box.contains(e.target) && e.target !== input) close();
    });

    // Global "/" to focus search
    document.addEventListener("keydown", function (e) {
      if (e.key === "/" && document.activeElement !== input &&
          !/input|textarea/i.test(document.activeElement.tagName)) {
        e.preventDefault(); input.focus();
      }
    });
  }

  window.DSASearch = { search: search, attach: attach };
})();
