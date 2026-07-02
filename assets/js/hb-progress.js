/* hb-progress.js — per-handbook LocalStorage progress (generic engine).
 * Namespaced by window.HANDBOOK.id so each handbook tracks independently.
 * Also provides a Leitner-style spaced-repetition review API used by the
 * Journey and Review dashboards. */
(function () {
  function hb() { return window.HANDBOOK || { id: "default", items: [], levels: [] }; }
  function KEY() { return "zariya-progress-" + hb().id; }
  function load() { try { return JSON.parse(localStorage.getItem(KEY())) || {}; } catch (e) { return {}; } }
  function save(s) { localStorage.setItem(KEY(), JSON.stringify(s)); fire(); }
  function bucket(s, n) { if (!s[n]) s[n] = {}; return s[n]; }
  var listeners = [];
  function fire() { listeners.forEach(function (fn) { try { fn(); } catch (e) {} }); }

  // ---- date helpers (local time, no TZ surprises) ----
  function isoDate(d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }
  function todayIso() { return isoDate(new Date()); }
  function parseIso(s) { var p = String(s).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(iso, n) { var d = parseIso(iso); d.setDate(d.getDate() + n); return isoDate(d); }
  function daysBetween(a, b) { return Math.round((parseIso(b) - parseIso(a)) / 86400000); }

  // Spaced-repetition (Leitner) schedule in days for boxes 0..5.
  var INTERVALS = [1, 3, 7, 14, 30, 90];
  function seedReview(s, slug, completedAt) {
    var r = bucket(s, "reviews");
    if (!r[slug]) {
      var t = completedAt || todayIso();
      r[slug] = { box: 0, due: addDays(t, INTERVALS[0]), last: t, completedAt: t };
    }
    return r[slug];
  }
  // Lazily enroll any completed topic that predates the review feature.
  function ensureEnrolled(s) {
    var c = s.completed || {};
    Object.keys(c).forEach(function (slug) {
      if (!(s.reviews || {})[slug]) {
        var when = typeof c[slug] === "string" ? c[slug] : todayIso();
        seedReview(s, slug, when);
        // legacy topics with unknown completion date become due immediately
        if (typeof c[slug] !== "string") s.reviews[slug].due = todayIso();
      }
    });
  }

  var P = {
    onChange: function (fn) { listeners.push(fn); },
    isComplete: function (slug) { return !!(load().completed || {})[slug]; },
    completedAt: function (slug) { var v = (load().completed || {})[slug]; return typeof v === "string" ? v : null; },
    toggleComplete: function (slug) {
      var s = load(), b = bucket(s, "completed");
      if (b[slug]) { delete b[slug]; delete (s.reviews || {})[slug]; }
      else { b[slug] = todayIso(); seedReview(s, slug); }
      save(s); return !!b[slug];
    },
    isBookmarked: function (slug) { return !!(load().bookmarked || {})[slug]; },
    toggleBookmark: function (slug) { var s = load(), b = bucket(s, "bookmarked"); b[slug] ? delete b[slug] : b[slug] = true; save(s); return !!b[slug]; },
    getRevision: function (slug) { return (load().revision || {})[slug] || "new"; },
    cycleRevision: function (slug) { var o = ["new", "learning", "mastered"], c = P.getRevision(slug), n = o[(o.indexOf(c) + 1) % 3]; var s = load(); bucket(s, "revision")[slug] = n; save(s); return n; },

    // ---- spaced repetition ----
    INTERVALS: INTERVALS,
    getReview: function (slug) { var s = load(); ensureEnrolled(s); return (s.reviews || {})[slug] || null; },
    /* Record a review result. remembered=true advances the Leitner box;
       false resets to box 0 (see it again tomorrow). */
    markReviewed: function (slug, remembered) {
      var s = load(); ensureEnrolled(s);
      var r = seedReview(s, slug), t = todayIso();
      if (remembered) r.box = Math.min(r.box + 1, INTERVALS.length - 1);
      else r.box = 0;
      r.last = t; r.due = addDays(t, INTERVALS[r.box]);
      save(s); return r;
    },
    /* Topics due for review today or earlier (only among completed topics). */
    dueReviews: function () {
      var s = load(); ensureEnrolled(s);
      var r = s.reviews || {}, t = todayIso(), out = [];
      Object.keys(r).forEach(function (slug) {
        if ((s.completed || {})[slug] && daysBetween(r[slug].due, t) >= 0) out.push({ slug: slug, review: r[slug] });
      });
      // most overdue first
      out.sort(function (a, b) { return parseIso(a.review.due) - parseIso(b.review.due); });
      return out;
    },
    reviewStats: function () {
      var s = load(); ensureEnrolled(s);
      var r = s.reviews || {}, t = todayIso(), due = 0, scheduled = 0, mastered = 0;
      Object.keys(r).forEach(function (slug) {
        if (!(s.completed || {})[slug]) return;
        scheduled++;
        if (daysBetween(r[slug].due, t) >= 0) due++;
        if (r[slug].box >= INTERVALS.length - 1) mastered++;
      });
      return { due: due, scheduled: scheduled, mastered: mastered };
    },

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
    // date utils exposed for the journey/review UIs
    date: { todayIso: todayIso, addDays: addDays, daysBetween: daysBetween, parseIso: parseIso, isoDate: isoDate },
    reset: function () { localStorage.removeItem(KEY()); fire(); }
  };
  window.DSAProgress = P;
})();
