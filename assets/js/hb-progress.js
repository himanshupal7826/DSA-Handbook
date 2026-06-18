/* hb-progress.js — per-handbook LocalStorage progress (generic engine).
 * Namespaced by window.HANDBOOK.id so each handbook tracks independently. */
(function () {
  function hb() { return window.HANDBOOK || { id: "default", items: [], levels: [] }; }
  function KEY() { return "zariya-progress-" + hb().id; }
  function load() { try { return JSON.parse(localStorage.getItem(KEY())) || {}; } catch (e) { return {}; } }
  function save(s) { localStorage.setItem(KEY(), JSON.stringify(s)); fire(); }
  function bucket(s, n) { if (!s[n]) s[n] = {}; return s[n]; }
  var listeners = [];
  function fire() { listeners.forEach(function (fn) { try { fn(); } catch (e) {} }); }
  var P = {
    onChange: function (fn) { listeners.push(fn); },
    isComplete: function (slug) { return !!(load().completed || {})[slug]; },
    toggleComplete: function (slug) { var s = load(), b = bucket(s, "completed"); b[slug] ? delete b[slug] : b[slug] = true; save(s); return !!b[slug]; },
    isBookmarked: function (slug) { return !!(load().bookmarked || {})[slug]; },
    toggleBookmark: function (slug) { var s = load(), b = bucket(s, "bookmarked"); b[slug] ? delete b[slug] : b[slug] = true; save(s); return !!b[slug]; },
    getRevision: function (slug) { return (load().revision || {})[slug] || "new"; },
    cycleRevision: function (slug) { var o = ["new", "learning", "mastered"], c = P.getRevision(slug), n = o[(o.indexOf(c) + 1) % 3]; var s = load(); bucket(s, "revision")[slug] = n; save(s); return n; },
    stats: function () {
      var s = load(), total = (hb().items || []).length || 1, completed = Object.keys(s.completed || {}).length;
      return { completed: completed, bookmarked: Object.keys(s.bookmarked || {}).length,
        mastered: Object.values(s.revision || {}).filter(function (v) { return v === "mastered"; }).length,
        total: total, pct: Math.round(completed / total * 100) };
    },
    byLevel: function () {
      var s = load(), out = {};
      (hb().levels || []).forEach(function (lv) { out[lv] = { done: 0, total: 0 }; });
      (hb().items || []).forEach(function (p) { if (!out[p.level]) out[p.level] = { done: 0, total: 0 }; out[p.level].total++; if ((s.completed || {})[p.slug]) out[p.level].done++; });
      return out;
    },
    reset: function () { localStorage.removeItem(KEY()); fire(); }
  };
  window.DSAProgress = P;
})();
