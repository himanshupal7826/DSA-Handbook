/* sd-hub.js — shared engine for the System Design Handbook's interactive pages
 * (journey.html, interview.html, review.html). Depends on: data.js (HANDBOOK),
 * content.js (HANDBOOK_CONTENT), hb-progress.js (DSAProgress). No frameworks.
 * Everything derives from the handbook manifest, so it stays in sync as topics
 * are added. Public API: window.SD */
(function () {
  "use strict";
  var HB = window.HANDBOOK || { id: "system-design", items: [] };
  var CONTENT = window.HANDBOOK_CONTENT || {};
  var ITEMS = HB.items || [];
  var TOTAL_DAYS = 30;
  var REVISION_OFFSETS = [1, 3, 7]; // in-plan woven revision (short-term)
  var JKEY = "zariya-journey-" + (HB.id || "system-design");

  /* Per-handbook journey config (set window.HB_JOURNEY before this script to
     customise). Defaults describe the System Design handbook. */
  var CFG = window.HB_JOURNEY || {};
  var PHASES = CFG.phases || [
    { until: 6,  label: "Foundations & Networking" },
    { until: 12, label: "Scaling & Storage" },
    { until: 18, label: "Data & Distributed Systems" },
    { until: 24, label: "Messaging, Resilience & Security" },
    { until: 30, label: "Real-World Architectures" }
  ];
  var PRACTICE_RE = new RegExp(CFG.practicePattern || "^\\d+-design-");
  var PRACTICE_VERB = CFG.practiceVerb || "Whiteboard";
  var PRACTICE_STRIP = new RegExp(CFG.practiceNamePrefix || "^Design:\\s*");
  var CONCEPT_CHALLENGE = CFG.conceptChallenge || "Sketch how you'd apply {name} in a real system, and name one trade-off.";

  var D = (window.DSAProgress && window.DSAProgress.date) || {
    todayIso: function () { var d = new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); },
    parseIso: function (s) { var p = String(s).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); },
    addDays: function (iso, n) { var d = this.parseIso(iso); d.setDate(d.getDate() + n); return this.isoDate(d); },
    isoDate: function (d) { return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); },
    daysBetween: function (a, b) { return Math.round((this.parseIso(b) - this.parseIso(a)) / 86400000); }
  };

  function bySlug(slug) { for (var i = 0; i < ITEMS.length; i++) if (ITEMS[i].slug === slug) return ITEMS[i]; return null; }

  /* ---------- reading time ---------- */
  function words(slug) {
    var c = CONTENT[slug]; if (!c) return 900; // sensible default
    return Math.round(c.length / 5.6);
  }
  function readMinutes(slug) { return Math.max(4, Math.round(words(slug) / 210)); }

  /* ---------- 30-day plan (derived from item order = learning path) ---------- */
  var _plan = null;
  function sizesFor(n, days) {
    // spread the leftover +1s evenly across the month (not front-loaded)
    var base = Math.floor(n / days), extra = n - base * days, sizes = [];
    for (var d = 0; d < days; d++) {
      var inc = Math.floor((d + 1) * extra / days) - Math.floor(d * extra / days);
      sizes.push(base + inc);
    }
    return sizes;
  }
  function buildPlan() {
    if (_plan) return _plan;
    var sizes = sizesFor(ITEMS.length, TOTAL_DAYS), plan = [], idx = 0;
    for (var day = 1; day <= TOTAL_DAYS; day++) {
      var topics = [];
      for (var k = 0; k < sizes[day - 1] && idx < ITEMS.length; k++) topics.push(ITEMS[idx++]);
      plan.push({ day: day, topics: topics, revisions: [] });
    }
    // map slug -> study day
    var studyDay = {};
    plan.forEach(function (pd) { pd.topics.forEach(function (t) { studyDay[t.slug] = pd.day; }); });
    // weave spaced-repetition revisions
    plan.forEach(function (pd) {
      var seen = {};
      REVISION_OFFSETS.forEach(function (off) {
        var src = plan[pd.day - 1 - off];
        if (!src) return;
        src.topics.forEach(function (t) { if (!seen[t.slug]) { seen[t.slug] = 1; pd.revisions.push(t); } });
      });
      pd.revisions = pd.revisions.slice(0, 3);
    });
    // enrich each day
    plan.forEach(function (pd) {
      var first = pd.topics[0] || ITEMS[0];
      pd.theme = first ? first.category : "Review";
      pd.phase = phaseFor(pd.day);
      pd.readingMin = pd.topics.reduce(function (a, t) { return a + readMinutes(t.slug); }, 0);
      // a challenge: the practice topic on this day, else a concept-application prompt
      var cs = pd.topics.filter(function (t) { return PRACTICE_RE.test(t.slug); })[0];
      pd.challenge = cs ? (PRACTICE_VERB + ": " + cs.name.replace(PRACTICE_STRIP, "")) :
        CONCEPT_CHALLENGE.replace("{name}", first.name);
      // a daily interview question, deterministic by day
      var bank = interviewBank(first.slug);
      pd.interviewQ = bank.length ? bank[pd.day % bank.length] : null;
    });
    _plan = plan; return _plan;
  }
  function phaseFor(day) {
    for (var i = 0; i < PHASES.length; i++) if (day <= PHASES[i].until) return { n: i + 1, label: PHASES[i].label };
    var last = PHASES[PHASES.length - 1];
    return { n: PHASES.length, label: last.label };
  }
  function studyDayOf(slug) {
    var plan = buildPlan();
    for (var i = 0; i < plan.length; i++) for (var j = 0; j < plan[i].topics.length; j++)
      if (plan[i].topics[j].slug === slug) return plan[i].day;
    return null;
  }

  /* ---------- journey clock (start date drives "today's" day) ---------- */
  function jload() { try { return JSON.parse(localStorage.getItem(JKEY)) || {}; } catch (e) { return {}; } }
  function jsave(s) { localStorage.setItem(JKEY, JSON.stringify(s)); }
  function started() { return !!jload().start; }
  function startJourney() { var s = jload(); if (!s.start) { s.start = D.todayIso(); jsave(s); } return s.start; }
  function currentDay() {
    var s = jload(); if (!s.start) return 1;
    var n = D.daysBetween(s.start, D.todayIso()) + 1;
    return Math.max(1, Math.min(TOTAL_DAYS, n));
  }
  function restart() { var s = jload(); s.start = D.todayIso(); jsave(s); }

  /* ---------- activity log / streak / XP ---------- */
  function touchToday() {
    var s = jload(); if (!s.activity) s.activity = {}; s.activity[D.todayIso()] = 1; jsave(s);
    return streak();
  }
  function activitySet() { return jload().activity || {}; }
  function streak() {
    var a = activitySet(), t = D.todayIso(), n = 0, cur = t;
    // allow the streak to count if active today or yesterday
    if (!a[cur]) { cur = D.addDays(t, -1); if (!a[cur]) return 0; }
    while (a[cur]) { n++; cur = D.addDays(cur, -1); }
    return n;
  }
  function longestStreak() {
    var days = Object.keys(activitySet()).sort(), best = 0, run = 0, prev = null;
    days.forEach(function (d) { run = (prev && D.daysBetween(prev, d) === 1) ? run + 1 : 1; best = Math.max(best, run); prev = d; });
    return best;
  }
  function xp() {
    var P = window.DSAProgress; if (!P) return 0;
    var st = P.stats(), rv = P.reviewStats();
    return st.completed * 20 + rv.mastered * 30 + rv.scheduled * 5;
  }
  // level curve: each level costs more XP
  function level() {
    var x = xp(), lvl = 1, need = 100, spent = 0;
    while (x >= spent + need) { spent += need; lvl++; need = Math.round(need * 1.35); }
    return { level: lvl, into: x - spent, need: need, xp: x,
      title: ["Novice", "Apprentice", "Practitioner", "Senior", "Staff", "Principal", "Architect", "Distinguished"][Math.min(lvl - 1, 7)] };
  }

  /* ---------- interview bank parsed from content ---------- */
  var _bankAll = null;
  function parseBank(slug) {
    var c = CONTENT[slug]; if (!c) return [];
    var it = bySlug(slug), out = [];
    // matches  **Q: ...**  on one line, then the following A: ... line(s)
    var re = /\*\*Q:\s*([\s\S]*?)\*\*\s*\n\s*(?:A:)\s*([\s\S]*?)(?=\n\s*\n|\n\s*\d+\.\s|\n\s*\*\*Q:|\n#|$)/g, m;
    while ((m = re.exec(c))) {
      var q = m[1].replace(/\s+/g, " ").trim();
      var a = m[2].replace(/\s+/g, " ").trim();
      if (q.length > 4 && a.length > 4)
        out.push({ slug: slug, name: it ? it.name : slug, category: it ? it.category : "", level: it ? it.level : "", q: q, a: a });
    }
    return out;
  }
  function interviewBank(slug) { return parseBank(slug); }
  function allInterview() {
    if (_bankAll) return _bankAll;
    var all = []; ITEMS.forEach(function (t) { all = all.concat(parseBank(t.slug)); });
    _bankAll = all; return all;
  }
  function designPrompts() {
    return ITEMS.filter(function (t) { return PRACTICE_RE.test(t.slug); });
  }

  /* deterministic shuffle by a numeric seed (no Date/random needed for repeatable sets) */
  function seededShuffle(arr, seed) {
    var a = arr.slice(), s = seed || 1;
    for (var i = a.length - 1; i > 0; i--) {
      s = (s * 9301 + 49297) % 233280;
      var j = Math.floor(s / 233280 * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  window.SD = {
    TOTAL_DAYS: TOTAL_DAYS, items: ITEMS, bySlug: bySlug,
    readMinutes: readMinutes, buildPlan: buildPlan, studyDayOf: studyDayOf, phaseFor: phaseFor,
    started: started, startJourney: startJourney, currentDay: currentDay, restart: restart,
    touchToday: touchToday, streak: streak, longestStreak: longestStreak, activitySet: activitySet,
    xp: xp, level: level,
    interviewBank: interviewBank, allInterview: allInterview, designPrompts: designPrompts,
    seededShuffle: seededShuffle, date: D
  };
})();
