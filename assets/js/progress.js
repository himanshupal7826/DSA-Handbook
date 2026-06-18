/* =====================================================================
 * progress.js — LocalStorage-backed progress, bookmarks, favorites, revision
 * State shape (under key "dsa-progress"):
 *   { completed: {slug:true}, bookmarked: {slug:true},
 *     revision: {slug:"new"|"learning"|"mastered"}, favProblems: {id:true} }
 * ===================================================================== */
(function () {
  var KEY = "dsa-progress";

  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
    catch (e) { return {}; }
  }
  function save(s) { localStorage.setItem(KEY, JSON.stringify(s)); fire(); }
  function bucket(s, name) { if (!s[name]) s[name] = {}; return s[name]; }

  var listeners = [];
  function fire() { listeners.forEach(function (fn) { try { fn(); } catch (e) {} }); }

  var P = {
    onChange: function (fn) { listeners.push(fn); },

    isComplete: function (slug) { return !!(load().completed || {})[slug]; },
    toggleComplete: function (slug) {
      var s = load(), b = bucket(s, "completed");
      if (b[slug]) delete b[slug]; else b[slug] = true;
      save(s); return !!b[slug];
    },

    isBookmarked: function (slug) { return !!(load().bookmarked || {})[slug]; },
    toggleBookmark: function (slug) {
      var s = load(), b = bucket(s, "bookmarked");
      if (b[slug]) delete b[slug]; else b[slug] = true;
      save(s); return !!b[slug];
    },

    getRevision: function (slug) { return (load().revision || {})[slug] || "new"; },
    setRevision: function (slug, status) {
      var s = load(); bucket(s, "revision")[slug] = status; save(s);
    },
    cycleRevision: function (slug) {
      var order = ["new", "learning", "mastered"];
      var cur = P.getRevision(slug);
      var next = order[(order.indexOf(cur) + 1) % order.length];
      P.setRevision(slug, next); return next;
    },

    isFavProblem: function (id) { return !!(load().favProblems || {})[id]; },
    toggleFavProblem: function (id) {
      var s = load(), b = bucket(s, "favProblems");
      if (b[id]) delete b[id]; else b[id] = true;
      save(s); return !!b[id];
    },

    stats: function () {
      var s = load();
      var completed = Object.keys(s.completed || {}).length;
      var bookmarked = Object.keys(s.bookmarked || {}).length;
      var mastered = Object.values(s.revision || {}).filter(function (v) { return v === "mastered"; }).length;
      var total = (window.DSA_PATTERNS || []).length || 100;
      return {
        completed: completed, bookmarked: bookmarked, mastered: mastered,
        total: total, pct: total ? Math.round((completed / total) * 100) : 0
      };
    },

    byLevel: function () {
      var s = load(), out = {};
      (window.DSA_LEVELS || []).forEach(function (lv) { out[lv] = { done: 0, total: 0 }; });
      (window.DSA_PATTERNS || []).forEach(function (p) {
        if (!out[p.level]) out[p.level] = { done: 0, total: 0 };
        out[p.level].total++;
        if ((s.completed || {})[p.slug]) out[p.level].done++;
      });
      return out;
    },

    reset: function () { localStorage.removeItem(KEY); fire(); },

    export: function () { return JSON.stringify(load(), null, 2); },
    import: function (json) {
      try { localStorage.setItem(KEY, JSON.stringify(JSON.parse(json))); fire(); return true; }
      catch (e) { return false; }
    }
  };

  window.DSAProgress = P;
})();
