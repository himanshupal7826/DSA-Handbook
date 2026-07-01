/* =====================================================================
 * journey.js — 30-Day DSA Journey engine.
 *
 * Pure client-side, offline-first. No backend, no database — only
 * LocalStorage. Everything is DERIVED deterministically from the existing
 * window.DSA_PATTERNS manifest and (where available) window.DSA_CONTENT
 * markdown, so the planner scales to all 100 patterns with zero hardcoded
 * daily plans.
 *
 * Public API: window.DSAJourney
 *
 * State shape (LocalStorage key "dsa-journey"):
 *   {
 *     startDate:   "YYYY-MM-DD" | null,   // when the user began the journey
 *     days:        { "3": true },         // completed day numbers
 *     tasks:       { "3": { warmup:true, must0:true, ... } }, // per-day checklist
 *     solved:      { "242": true },        // solved problems by LeetCode number
 *     savedProblems:{ "242": true },       // bookmarked problems
 *     revised:     { "13-fixed-window@1": true }, // slug@stage completed revisions
 *     notes:       { "13-fixed-window": "text" },  // per-pattern quick notes
 *     reflections: { "3": {learned,confused,revise} }, // per-day reflection
 *     listen:      { "13-fixed-window": {section:2, char:140} }, // last audio pos
 *     watched:     { "13-fixed-window": true }, // video marked watched
 *     xp:          0,
 *     xpLog:       { "day3:complete": true }, // idempotency guard for XP events
 *     history:     { "2026-07-01": {xp:55} }, // per-day XP for streak/heatmap
 *     prefs:       { rate:1, voice:null, nothalloweenModeetc }
 *   }
 * ===================================================================== */
(function () {
  "use strict";

  var KEY = "dsa-journey";
  var TOTAL_DAYS = 30;
  var REVISION_OFFSETS = [1, 3, 7, 14, 30]; // spaced-repetition schedule (days)

  var P = window.DSA_PATTERNS || [];

  /* ------------------------------------------------------------------ */
  /* State load/save                                                    */
  /* ------------------------------------------------------------------ */
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
    catch (e) { return {}; }
  }
  var listeners = [];
  function fire() { listeners.forEach(function (fn) { try { fn(); } catch (e) {} }); }
  function save(s) { localStorage.setItem(KEY, JSON.stringify(s)); fire(); }
  function bucket(s, name) { if (!s[name]) s[name] = {}; return s[name]; }

  /* ------------------------------------------------------------------ */
  /* Date helpers (local-date, no time component to keep streaks stable) */
  /* ------------------------------------------------------------------ */
  function isoDate(d) {
    // Local YYYY-MM-DD (avoids UTC off-by-one from toISOString()).
    var y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    return y + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }
  function today() { return isoDate(new Date()); }
  function parseIso(s) { var p = String(s).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function daysBetween(a, b) {
    // whole days from a -> b (both ISO strings)
    return Math.round((parseIso(b) - parseIso(a)) / 86400000);
  }
  function addDays(iso, n) { var d = parseIso(iso); d.setDate(d.getDate() + n); return isoDate(d); }

  /* ------------------------------------------------------------------ */
  /* 30-day plan generation — distributes ALL patterns deterministically */
  /*                                                                    */
  /* Patterns in the manifest are already ordered pedagogically         */
  /* (easy foundations -> expert). We front-load slightly bigger batches */
  /* while material is easier, and taper to smaller batches as patterns  */
  /* get harder. The split always covers exactly every pattern.          */
  /* ------------------------------------------------------------------ */
  var _planCache = null;
  function buildPlan() {
    if (_planCache) return _planCache;

    var n = P.length || 100;
    // Give each day a batch size. We want sum(sizes) == n across 30 days,
    // with larger batches early (easier patterns) and smaller batches late.
    var base = Math.floor(n / TOTAL_DAYS);       // e.g. 3 for 100
    var extra = n - base * TOTAL_DAYS;           // e.g. 10 leftover -> first 10 days get +1
    var sizes = [];
    for (var d = 0; d < TOTAL_DAYS; d++) sizes.push(base + (d < extra ? 1 : 0));

    var plan = [];
    var cursor = 0;
    for (var day = 1; day <= TOTAL_DAYS; day++) {
      var size = sizes[day - 1];
      var slice = P.slice(cursor, cursor + size);
      cursor += size;
      if (!slice.length) continue;

      var primary = slice[0];
      var secondary = slice.slice(1);
      plan.push({
        day: day,
        primary: primary,
        secondary: secondary,
        patterns: slice,
        quote: QUOTES[(day - 1) % QUOTES.length]
      });
    }
    _planCache = plan;
    return plan;
  }

  // Map slug -> the day number on which it is first studied (its "study day").
  var _studyDayCache = null;
  function studyDayOf(slug) {
    if (!_studyDayCache) {
      _studyDayCache = {};
      buildPlan().forEach(function (d) {
        d.patterns.forEach(function (p) {
          if (_studyDayCache[p.slug] == null) _studyDayCache[p.slug] = d.day;
        });
      });
    }
    return _studyDayCache[slug];
  }

  /* ------------------------------------------------------------------ */
  /* Spaced repetition — which patterns are due for revision on day N   */
  /*                                                                    */
  /* A pattern studied on day S is scheduled again on S+1, S+3, S+7,    */
  /* S+14 and S+30. On any given day we surface every pattern whose     */
  /* study-day + an offset lands on that day.                           */
  /* ------------------------------------------------------------------ */
  function revisionsForDay(dayNum) {
    var out = [];
    buildPlan().forEach(function (d) {
      d.patterns.forEach(function (p) {
        var s = d.day;
        for (var i = 0; i < REVISION_OFFSETS.length; i++) {
          if (s + REVISION_OFFSETS[i] === dayNum) {
            out.push({ pattern: p, stage: i + 1, interval: REVISION_OFFSETS[i], studiedDay: s });
          }
        }
      });
    });
    return out;
  }

  /* ------------------------------------------------------------------ */
  /* Problem / question derivation                                      */
  /*                                                                    */
  /* Each pattern already lists representative LeetCode problems as      */
  /* strings like "242 Valid Anagram". We parse those, attach a         */
  /* deterministic (seeded) difficulty / acceptance / time / company    */
  /* profile, and pick 2 mandatory + 1 stretch problem for the day.     */
  /* Values are deterministic functions of the problem number so they   */
  /* never change between reloads.                                      */
  /* ------------------------------------------------------------------ */
  var HARD_HINTS = { // well-known Hard problems that show up in the manifest
    "42": 1, "84": 1, "76": 1, "239": 1, "295": 1, "23": 1, "51": 1, "37": 1,
    "212": 1, "218": 1, "10": 1, "72": 1, "188": 1, "297": 1, "315": 1, "410": 1,
    "480": 1, "1755": 1, "847": 1, "1192": 1, "128": 1, "4": 1, "146": 1
  };
  var EASY_HINTS = {
    "1": 1, "242": 1, "217": 1, "383": 1, "387": 1, "125": 1, "344": 1, "26": 1,
    "27": 1, "283": 1, "141": 1, "876": 1, "202": 1, "704": 1, "35": 1, "69": 1,
    "252": 1, "102": 1, "78": 1, "121": 1, "55": 1
  };
  var COMPANY_POOL = ["Google", "Amazon", "Meta", "Microsoft", "Apple", "Netflix",
    "Uber", "Bloomberg", "Adobe", "LinkedIn", "Airbnb", "TikTok", "Stripe", "Atlassian"];

  function seededInt(seed, mod) {
    // small deterministic hash -> [0, mod)
    var x = (seed * 2654435761) % 4294967296;
    x = Math.abs(x ^ (x >> 15));
    return x % mod;
  }

  function parseProblem(str, pattern) {
    var m = String(str).match(/^(\d+)\s+(.*)$/);
    var num = m ? m[1] : null;
    var title = m ? m[2] : str;
    var seed = num ? parseInt(num, 10) : (title.length + 7);

    var difficulty;
    if (num && HARD_HINTS[num]) difficulty = "Hard";
    else if (num && EASY_HINTS[num]) difficulty = "Easy";
    else {
      // fall back to the pattern's level to bias difficulty
      var lvl = pattern ? pattern.level : "Intermediate";
      var roll = seededInt(seed, 100);
      if (lvl === "Beginner") difficulty = roll < 55 ? "Easy" : roll < 90 ? "Medium" : "Hard";
      else if (lvl === "Expert") difficulty = roll < 20 ? "Medium" : "Hard";
      else difficulty = roll < 20 ? "Easy" : roll < 78 ? "Medium" : "Hard";
    }

    var accBase = difficulty === "Easy" ? 55 : difficulty === "Medium" ? 42 : 33;
    var acceptance = accBase + seededInt(seed + 3, 18) - 6; // +/- spread, deterministic
    var estTime = difficulty === "Easy" ? 12 + seededInt(seed, 8)
      : difficulty === "Medium" ? 22 + seededInt(seed, 13)
        : 35 + seededInt(seed, 20);

    var companies = [];
    var c1 = seededInt(seed, COMPANY_POOL.length);
    var c2 = (c1 + 3 + seededInt(seed + 1, 5)) % COMPANY_POOL.length;
    var c3 = (c2 + 2 + seededInt(seed + 2, 4)) % COMPANY_POOL.length;
    companies = [COMPANY_POOL[c1], COMPANY_POOL[c2], COMPANY_POOL[c3]];

    return {
      id: num || title.replace(/\s+/g, "-").toLowerCase(),
      num: num,
      title: title,
      url: num ? ("https://leetcode.com/problemset/all/?search=" + num) : ("https://leetcode.com/problemset/all/?search=" + encodeURIComponent(title)),
      difficulty: difficulty,
      acceptance: acceptance + "%",
      estTime: estTime,               // minutes
      companies: companies,
      pattern: pattern ? pattern.name : "",
      patternSlug: pattern ? pattern.slug : "",
      tags: pattern ? (pattern.keywords || []).slice(0, 4) : [],
      why: pattern
        ? "Canonical application of the " + pattern.name + " pattern — " + pattern.summary
        : "High-frequency interview problem.",
      complexity: difficulty === "Hard" ? "Aim for better than brute force; often O(n log n) or O(n)."
        : "Target O(n) time, O(n) or O(1) extra space.",
      revisit: difficulty === "Hard" ? "Revisit in 3 days, then 7 days." : "Revisit in 7 days if it took > estimate."
    };
  }

  // Return the full derived problem list for a pattern.
  function problemsFor(pattern) {
    if (!pattern || !pattern.leetcode) return [];
    return pattern.leetcode.map(function (s) { return parseProblem(s, pattern); });
  }

  // For a day: 2 mandatory (prefer Easy/Medium) + 1 stretch (prefer Hard).
  function dailyQuestions(pattern) {
    var all = problemsFor(pattern);
    if (!all.length) return { must: [], stretch: null };
    var easyMed = all.filter(function (q) { return q.difficulty !== "Hard"; });
    var hard = all.filter(function (q) { return q.difficulty === "Hard"; });
    var must = (easyMed.length >= 2 ? easyMed : all).slice(0, 2);
    // ensure 2 distinct
    if (must.length < 2 && all.length >= 2) must = all.slice(0, 2);
    var stretch = hard[0] || all[all.length - 1] || null;
    if (stretch && must.some(function (m) { return m.id === stretch.id; }) && all.length > 2) {
      stretch = all.filter(function (q) { return !must.some(function (m) { return m.id === q.id; }); })[0] || stretch;
    }
    return { must: must, stretch: stretch };
  }

  /* ------------------------------------------------------------------ */
  /* Curated "Must Solve" master list — ~300 problems across patterns.  */
  /* Derived: every pattern contributes its representative problems,     */
  /* tagged with importance + revision frequency. No hardcoded catalog.  */
  /* ------------------------------------------------------------------ */
  function mustSolveList() {
    var list = [];
    P.forEach(function (p) {
      problemsFor(p).forEach(function (q, i) {
        var importance = 100 - p.id - i * 3; // earlier patterns / first problems weigh more
        importance = Math.max(20, Math.min(99, importance + (EASY_HINTS[q.num] ? 8 : 0) + (q.difficulty === "Medium" ? 5 : 0)));
        list.push({
          problem: q,
          pattern: p,
          concepts: (p.keywords || []).slice(0, 3),
          importance: importance,
          faang: q.companies.some(function (c) { return ["Google", "Amazon", "Meta", "Microsoft", "Apple", "Netflix"].indexOf(c) >= 0; }),
          mustKnow: importance >= 70,
          revisionFrequency: q.difficulty === "Hard" ? "High" : q.difficulty === "Medium" ? "Medium" : "Low"
        });
      });
    });
    return list;
  }

  /* ------------------------------------------------------------------ */
  /* Revision card — pull concise fields from the pattern's markdown.    */
  /* Falls back to manifest data when markdown isn't loaded.             */
  /* ------------------------------------------------------------------ */
  function sectionText(md, headingRegex) {
    if (!md) return "";
    var lines = md.split("\n");
    var out = [], capturing = false;
    for (var i = 0; i < lines.length; i++) {
      var ln = lines[i];
      if (/^##\s/.test(ln)) {
        if (capturing) break;
        capturing = headingRegex.test(ln);
        continue;
      }
      if (capturing) out.push(ln);
    }
    return out.join("\n").trim();
  }
  function firstBullets(text, max) {
    var bullets = (text.match(/^\s*[-*]\s+.*/gm) || []).map(function (b) {
      return b.replace(/^\s*[-*]\s+/, "").replace(/[*`]/g, "").trim();
    });
    return bullets.slice(0, max || 5);
  }
  function complexityLine(md) {
    var sec = sectionText(md, /Complexity/i);
    var m = sec.match(/O\([^)]*\)/g);
    if (m && m.length) return "Time " + m[0] + (m[1] ? " · Space " + m[1] : "");
    return "";
  }

  function revisionCard(slug) {
    var p = P.filter(function (x) { return x.slug === slug; })[0];
    var md = (window.DSA_CONTENT && window.DSA_CONTENT[slug]) || "";
    var recog = firstBullets(sectionText(md, /Recognition/i), 4);
    var mistakes = firstBullets(sectionText(md, /Common Mistakes/i), 3);
    var revNotes = sectionText(md, /Revision Notes/i);
    var oneLine = "";
    var mm = md.match(/\*\*One-liner:\*\*\s*(.+)/);
    if (mm) oneLine = mm[1].replace(/[*`]/g, "").trim();

    return {
      slug: slug,
      name: p ? p.name : slug,
      category: p ? p.category : "",
      level: p ? p.level : "",
      oneLiner: oneLine || (p ? p.summary : ""),
      recognition: recog.length ? recog : (p ? (p.keywords || []).slice(0, 4) : []),
      complexity: complexityLine(md) || "See pattern page for full complexity table.",
      template: "See §5 Generic Templates on the pattern page for the reusable skeleton.",
      mistakes: mistakes,
      formula: keyFormula(p),
      oneMinute: firstBullets(revNotes, 5),
      keywords: p ? p.keywords : []
    };
  }

  // A tiny curated "key formula / mental hook" per category.
  var CATEGORY_FORMULA = {
    "Foundations": "Trade space for time — a hash map turns O(n²) scans into O(n).",
    "Two Pointers": "Sorted or symmetric input? Converge/advance pointers, never rescan.",
    "Sliding Window": "windowSum ±= a[r]/a[l]; shrink while invalid, record while valid.",
    "Binary Search": "while (lo<hi) mid=(lo+hi)/2; move the boundary that stays feasible.",
    "Intervals": "Sort by start; overlap iff cur.start ≤ prev.end.",
    "Stacks": "Push indices; pop while the monotonic invariant breaks.",
    "Queues": "Deque keeps candidates monotone → O(1) window min/max.",
    "Heaps": "Size-k heap = k best in O(n log k); two heaps = running median.",
    "Linked Lists": "Dummy head + slow/fast pointers handle edges cleanly.",
    "Trees": "Recurse: combine(left, right); pick pre/in/post by when you need the node.",
    "Graphs": "BFS = shortest unweighted; DFS = connectivity/cycles; toposort = ordering.",
    "Backtracking": "choose → explore → un-choose; prune early, dedupe with start index.",
    "Dynamic Programming": "Define state, transition, base case; memoize or tabulate.",
    "Greedy": "Prove the exchange argument; take the locally best, never look back.",
    "Advanced": "Preprocess once (tree/table), answer many queries in O(log n) or O(1)."
  };
  function keyFormula(p) {
    if (!p) return "";
    return CATEGORY_FORMULA[p.category] || p.summary;
  }

  /* ------------------------------------------------------------------ */
  /* Audio summary script (Feature 15) — a ~2 minute spoken narration    */
  /* generated from the pattern's markdown + manifest.                   */
  /* ------------------------------------------------------------------ */
  function audioScript(slug) {
    var p = P.filter(function (x) { return x.slug === slug; })[0];
    var c = revisionCard(slug);
    if (!p) return [];
    var sections = [];
    sections.push({ title: "Intro", text: "Pattern " + p.id + ": " + p.name + ". " + p.summary });
    sections.push({ title: "Intuition", text: "The core idea. " + (c.oneLiner || p.summary) });
    if (c.recognition.length) sections.push({ title: "Recognition", text: "Reach for this pattern when you see: " + c.recognition.join("; ") + "." });
    sections.push({ title: "Approach", text: "The optimal approach. " + keyFormula(p) });
    if (c.complexity) sections.push({ title: "Complexity", text: c.complexity + "." });
    if (c.mistakes.length) sections.push({ title: "Pitfalls", text: "Watch out for: " + c.mistakes.join("; ") + "." });
    sections.push({ title: "Interview Tip", text: "Interview tip: state the pattern out loud, write the brute force first, then optimise to " + (keyFormula(p)) });
    return sections;
  }

  /* ------------------------------------------------------------------ */
  /* Longer read-aloud sections for full Listen Mode (Feature 6).        */
  /* Pulls Overview / Recognition / Optimal / Complexity / Revision.     */
  /* ------------------------------------------------------------------ */
  function listenSections(slug) {
    var md = (window.DSA_CONTENT && window.DSA_CONTENT[slug]) || "";
    var p = P.filter(function (x) { return x.slug === slug; })[0];
    function clean(t) {
      return t.replace(/```[\s\S]*?```/g, " (code sample omitted) ")
        .replace(/`([^`]+)`/g, "$1")
        .replace(/[#>*_]/g, "")
        .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
        .replace(/\|/g, " ")
        .replace(/\n{2,}/g, ". ")
        .replace(/\s+/g, " ")
        .trim();
    }
    var secs = [
      { title: "Overview", text: clean(sectionText(md, /Overview/i)) },
      { title: "Recognition Signals", text: clean(sectionText(md, /Recognition/i)) },
      { title: "Optimal Approach", text: clean(sectionText(md, /Optimal Approach/i)) },
      { title: "Complexity", text: clean(sectionText(md, /Complexity/i)) },
      { title: "Revision Notes", text: clean(sectionText(md, /Revision Notes/i)) }
    ].filter(function (s) { return s.text && s.text.length > 4; });

    if (!secs.length && p) {
      // fallback when markdown isn't embedded
      secs = [{ title: "Summary", text: p.name + ". " + p.summary }];
    }
    return secs;
  }

  /* ------------------------------------------------------------------ */
  /* XP + levels + streak (Features 8, 9)                                */
  /* ------------------------------------------------------------------ */
  var LEVELS = [
    { name: "Beginner", min: 0, icon: "🌱" },
    { name: "Explorer", min: 150, icon: "🧭" },
    { name: "Solver", min: 400, icon: "⚙️" },
    { name: "Advanced", min: 800, icon: "🚀" },
    { name: "Master", min: 1400, icon: "🎯" },
    { name: "Grandmaster", min: 2200, icon: "👑" },
    { name: "Legend", min: 3200, icon: "🏆" }
  ];
  function levelForXp(xp) {
    var cur = LEVELS[0], next = null;
    for (var i = 0; i < LEVELS.length; i++) {
      if (xp >= LEVELS[i].min) { cur = LEVELS[i]; next = LEVELS[i + 1] || null; }
    }
    var floor = cur.min, ceil = next ? next.min : cur.min;
    var pct = next ? Math.round(((xp - floor) / (ceil - floor)) * 100) : 100;
    return { level: cur, next: next, pct: pct, toNext: next ? next.min - xp : 0 };
  }

  // Award XP once per unique eventId (idempotent). amount>0.
  function awardXP(eventId, amount, reason) {
    var s = load();
    var log = bucket(s, "xpLog");
    if (log[eventId]) return false;       // already awarded
    log[eventId] = true;
    s.xp = (s.xp || 0) + amount;
    var h = bucket(s, "history");
    var t = today();
    h[t] = h[t] || { xp: 0, events: 0 };
    h[t].xp += amount; h[t].events += 1;
    save(s);
    return true;
  }
  // Revoke XP if an event is undone (e.g. un-completing a day).
  function revokeXP(eventId, amount) {
    var s = load();
    var log = bucket(s, "xpLog");
    if (!log[eventId]) return false;
    delete log[eventId];
    s.xp = Math.max(0, (s.xp || 0) - amount);
    save(s);
    return true;
  }

  function streak() {
    var s = load();
    var h = s.history || {};
    var dates = Object.keys(h).filter(function (d) { return h[d] && h[d].xp > 0; }).sort();
    if (!dates.length) return { current: 0, longest: 0, active: false };

    // longest run of consecutive active days
    var longest = 1, run = 1;
    for (var i = 1; i < dates.length; i++) {
      if (daysBetween(dates[i - 1], dates[i]) === 1) { run++; longest = Math.max(longest, run); }
      else run = 1;
    }
    // current streak counting back from today (or yesterday, to be forgiving)
    var t = today();
    var current = 0, active = false;
    var last = dates[dates.length - 1];
    var gap = daysBetween(last, t);
    if (gap <= 1) {
      active = gap === 0;
      current = 1;
      for (var j = dates.length - 1; j > 0; j--) {
        if (daysBetween(dates[j - 1], dates[j]) === 1) current++; else break;
      }
    }
    return { current: current, longest: longest, active: active, lastActive: last };
  }

  function xpInRange(days) {
    var s = load(), h = s.history || {}, sum = 0, t = today();
    Object.keys(h).forEach(function (d) {
      if (daysBetween(d, t) < days) sum += (h[d].xp || 0);
    });
    return sum;
  }

  /* ------------------------------------------------------------------ */
  /* Journey progress + today                                            */
  /* ------------------------------------------------------------------ */
  function isStarted() { return !!load().startDate; }
  function startJourney() {
    var s = load();
    if (!s.startDate) { s.startDate = today(); save(s); }
    awardXP("first-open", 5, "Opened the handbook");
    return s.startDate;
  }
  function resetJourney() {
    var s = load();
    // keep XP/history/streak; only reset the schedule anchor + day completions
    s.startDate = null; s.days = {}; s.tasks = {}; s.reflections = {};
    save(s);
  }

  // Which day number is "today" relative to startDate (1..30). If not
  // started, returns 1 (a previewable day). Clamped to 30.
  function currentDayNumber() {
    var s = load();
    if (!s.startDate) return 1;
    var n = daysBetween(s.startDate, today()) + 1;
    return Math.max(1, Math.min(TOTAL_DAYS, n));
  }

  function isDayComplete(n) { return !!(load().days || {})[n]; }
  function completeDay(n, done) {
    var s = load();
    var b = bucket(s, "days");
    if (done === undefined) done = !b[n];
    if (done) { b[n] = true; } else { delete b[n]; }
    save(s);
    if (done) awardXP("day" + n + ":complete", 40, "Completed day " + n);
    else revokeXP("day" + n + ":complete", 40);
    return done;
  }

  // Per-day checklist tasks (warmup, must0, must1, stretch, watch, listen, reflect)
  function taskState(day) { return (load().tasks || {})[day] || {}; }
  function toggleTask(day, key, xp) {
    var s = load();
    var t = bucket(s, "tasks");
    if (!t[day]) t[day] = {};
    t[day][key] = !t[day][key];
    save(s);
    var ev = "day" + day + ":" + key;
    if (t[day][key] && xp) awardXP(ev, xp, key);
    else if (!t[day][key] && xp) revokeXP(ev, xp);
    return t[day][key];
  }

  /* ------------------------------------------------------------------ */
  /* Solved problems / notes / reflections / listen position            */
  /* ------------------------------------------------------------------ */
  function isSolved(id) { return !!(load().solved || {})[id]; }
  function toggleSolved(id) {
    var s = load(), b = bucket(s, "solved");
    if (b[id]) { delete b[id]; revokeXP("solve:" + id, 30); }
    else { b[id] = true; awardXP("solve:" + id, 30, "Solved problem " + id); }
    save(s); return !!b[id];
  }
  function isSavedProblem(id) { return !!(load().savedProblems || {})[id]; }
  function toggleSavedProblem(id) {
    var s = load(), b = bucket(s, "savedProblems");
    if (b[id]) delete b[id]; else b[id] = true;
    save(s); return !!b[id];
  }

  function isRevised(slug, stage) { return !!(load().revised || {})[slug + "@" + stage]; }
  function markRevised(slug, stage, done) {
    var s = load(), b = bucket(s, "revised");
    var k = slug + "@" + stage;
    if (done === undefined) done = !b[k];
    if (done) { b[k] = true; awardXP("rev:" + k, 10, "Revised " + slug); }
    else { delete b[k]; revokeXP("rev:" + k, 10); }
    save(s); return done;
  }

  function getNote(slug) { return (load().notes || {})[slug] || ""; }
  function setNote(slug, text) { var s = load(); bucket(s, "notes")[slug] = text; save(s); }

  function getReflection(day) { return (load().reflections || {})[day] || {}; }
  function setReflection(day, obj) {
    var s = load(); bucket(s, "reflections")[day] = obj; save(s);
    if (obj && (obj.learned || obj.confused || obj.revise)) awardXP("reflect:" + day, 10, "Reflected day " + day);
  }

  function getListenPos(slug) { return (load().listen || {})[slug] || null; }
  function setListenPos(slug, pos) { var s = load(); bucket(s, "listen")[slug] = pos; save(s); }

  function isWatched(slug) { return !!(load().watched || {})[slug]; }
  function toggleWatched(slug) {
    var s = load(), b = bucket(s, "watched");
    if (b[slug]) { delete b[slug]; revokeXP("watch:" + slug, 5); }
    else { b[slug] = true; awardXP("watch:" + slug, 5, "Watched video"); }
    save(s); return !!b[slug];
  }

  function getPref(k, def) { var p = load().prefs || {}; return p[k] === undefined ? def : p[k]; }
  function setPref(k, v) { var s = load(); bucket(s, "prefs")[k] = v; save(s); }

  /* ------------------------------------------------------------------ */
  /* Aggregate stats + insights (Features 8, 12, 14)                     */
  /* ------------------------------------------------------------------ */
  function stats() {
    var s = load();
    var solved = Object.keys(s.solved || {}).length;
    var daysDone = Object.keys(s.days || {}).length;
    var xp = s.xp || 0;
    var lv = levelForXp(xp);
    var st = streak();
    // patterns completed piggy-backs on the existing DSAProgress store
    var patternsDone = window.DSAProgress ? window.DSAProgress.stats().completed : 0;
    var revisionDue = revisionsForDay(currentDayNumber()).filter(function (r) {
      return !isRevised(r.pattern.slug, r.stage);
    }).length;

    // consistency = active days / days since start
    var consistency = 100;
    if (s.startDate) {
      var span = daysBetween(s.startDate, today()) + 1;
      var activeDays = Object.keys(s.history || {}).filter(function (d) {
        return (s.history[d].xp || 0) > 0 && daysBetween(s.startDate, d) >= 0;
      }).length;
      consistency = span ? Math.round((activeDays / Math.min(span, TOTAL_DAYS)) * 100) : 100;
    }

    return {
      xp: xp, level: lv, streak: st,
      weeklyXp: xpInRange(7), monthlyXp: xpInRange(30),
      solved: solved, daysDone: daysDone, patternsDone: patternsDone,
      revisionDue: revisionDue, consistency: Math.min(100, consistency),
      currentDay: currentDayNumber(), started: !!s.startDate
    };
  }

  // Category-level mastery for insights + weekly review.
  function categoryInsights() {
    var byCat = {};
    P.forEach(function (p) {
      if (!byCat[p.category]) byCat[p.category] = { total: 0, done: 0, revised: 0, name: p.category };
      byCat[p.category].total++;
      if (window.DSAProgress && window.DSAProgress.isComplete(p.slug)) byCat[p.category].done++;
      if (window.DSAProgress && window.DSAProgress.getRevision(p.slug) === "mastered") byCat[p.category].revised++;
    });
    var arr = Object.keys(byCat).map(function (k) {
      var c = byCat[k];
      c.pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
      return c;
    });
    arr.sort(function (a, b) { return b.pct - a.pct; });
    return arr;
  }

  // Interview readiness = weighted blend of completion, revision, solving.
  function interviewReadiness() {
    var totalPatterns = P.length || 100;
    var done = window.DSAProgress ? window.DSAProgress.stats().completed : 0;
    var mastered = window.DSAProgress ? window.DSAProgress.stats().mastered : 0;
    var solved = Object.keys(load().solved || {}).length;
    var solveTarget = totalPatterns * 2; // ~2 problems/pattern is "ready"
    var score = 0.45 * (done / totalPatterns)
      + 0.30 * (mastered / totalPatterns)
      + 0.25 * Math.min(1, solved / solveTarget);
    return Math.round(score * 100);
  }

  function weeklyReview() {
    var n = currentDayNumber();
    var weekStart = Math.max(1, n - 6);
    var plan = buildPlan();
    var learned = [], solvedThisWeek = 0;
    for (var d = weekStart; d <= n; d++) {
      var pd = plan[d - 1];
      if (pd) pd.patterns.forEach(function (p) { learned.push(p); });
    }
    var cats = categoryInsights();
    return {
      fromDay: weekStart, toDay: n,
      patternsLearned: learned,
      weeklyXp: xpInRange(7),
      strong: cats.slice(0, 3),
      weak: cats.slice(-3).reverse(),
      readiness: interviewReadiness()
    };
  }

  /* ------------------------------------------------------------------ */
  /* Free learning resources (Features 5 & 16)                           */
  /*                                                                    */
  /* We map each category to the best FREE channels/creators that cover  */
  /* it, then build deep-link searches (offline-safe: they are plain     */
  /* URLs, nothing is fetched). Every resource is free.                  */
  /* ------------------------------------------------------------------ */
  var CHANNELS = {
    neetcode: { name: "NeetCode", color: "#22c55e", yt: "https://www.youtube.com/@NeetCode/search?query=" },
    tuf: { name: "take U forward", color: "#3b82f6", yt: "https://www.youtube.com/@takeUforward/search?query=" },
    abdul: { name: "Abdul Bari", color: "#f97316", yt: "https://www.youtube.com/@abdul_bari/search?query=" },
    fiset: { name: "WilliamFiset", color: "#8b5cf6", yt: "https://www.youtube.com/@WilliamFiset-videos/search?query=" },
    errichto: { name: "Errichto", color: "#ef4444", yt: "https://www.youtube.com/@Errichto/search?query=" },
    b2b: { name: "Back To Back SWE", color: "#0ea5e9", yt: "https://www.youtube.com/@BackToBackSWE/search?query=" },
    techdose: { name: "Tech Dose", color: "#14b8a6", yt: "https://www.youtube.com/@techdose4u/search?query=" },
    csdojo: { name: "CS Dojo", color: "#eab308", yt: "https://www.youtube.com/@CSDojo/search?query=" },
    fcc: { name: "freeCodeCamp", color: "#16a34a", yt: "https://www.youtube.com/@freecodecamp/search?query=" },
    jenny: { name: "Jenny's Lectures", color: "#db2777", yt: "https://www.youtube.com/@JennyslecturesCSIT/search?query=" }
  };
  // Which creators best cover each category (order = recommendation order).
  var CAT_CHANNELS = {
    "Foundations": ["csdojo", "neetcode", "fcc"],
    "Two Pointers": ["neetcode", "tuf", "b2b"],
    "Sliding Window": ["neetcode", "tuf", "techdose"],
    "Binary Search": ["neetcode", "tuf", "errichto"],
    "Intervals": ["neetcode", "b2b", "techdose"],
    "Stacks": ["neetcode", "tuf", "techdose"],
    "Queues": ["neetcode", "techdose", "tuf"],
    "Heaps": ["neetcode", "tuf", "b2b"],
    "Linked Lists": ["csdojo", "neetcode", "jenny"],
    "Trees": ["neetcode", "tuf", "abdul"],
    "Graphs": ["fiset", "neetcode", "tuf"],
    "Backtracking": ["neetcode", "tuf", "errichto"],
    "Dynamic Programming": ["neetcode", "tuf", "abdul"],
    "Greedy": ["abdul", "neetcode", "techdose"],
    "Advanced": ["fiset", "errichto", "abdul"]
  };
  var LEVEL_TAG = { "Beginner": "Beginner", "Intermediate": "Intermediate", "Advanced": "Advanced", "Expert": "Advanced" };

  function videosFor(pattern) {
    if (!pattern) return [];
    var chans = CAT_CHANNELS[pattern.category] || ["neetcode", "tuf", "abdul"];
    var q = encodeURIComponent(pattern.name);
    var levels = ["Beginner", "Intermediate", "Advanced"];
    return chans.map(function (id, i) {
      var c = CHANNELS[id];
      var seed = pattern.id + i;
      return {
        channel: c.name,
        color: c.color,
        title: pattern.name + (i === 0 ? " — visual explanation" : i === 1 ? " — patterns & template walkthrough" : " — deep dive & edge cases"),
        url: c.yt + q,
        duration: (8 + seededInt(seed, 20)) + ":" + (10 + seededInt(seed + 1, 49)),
        level: i === 0 ? (LEVEL_TAG[pattern.level] || "Intermediate") : levels[Math.min(2, i)],
        why: i === 0 ? "Clear, beginner-friendly intuition for " + pattern.name + "."
          : i === 1 ? "Reusable template you can carry into any variant."
            : "Handles the tricky edge cases interviewers probe."
      };
    });
  }

  function resourcesFor(pattern) {
    if (!pattern) return [];
    var q = encodeURIComponent(pattern.name + " algorithm");
    var lc = (pattern.leetcode && pattern.leetcode[0]) ? (pattern.leetcode[0].match(/^\d+/) || [""])[0] : "";
    var v = videosFor(pattern)[0];
    return [
      { icon: "🎥", label: "Best free video", detail: v ? v.channel : "YouTube", url: v ? v.url : ("https://www.youtube.com/results?search_query=" + q) },
      { icon: "📄", label: "Best article", detail: "GeeksforGeeks", url: "https://www.geeksforgeeks.org/?s=" + q },
      { icon: "🖼️", label: "Visualization", detail: "VisuAlgo / interactive", url: "https://visualgo.net/en" },
      { icon: "🧪", label: "Interactive demo", detail: "USFCA Algorithm Visualizations", url: "https://www.cs.usfca.edu/~galles/visualization/Algorithms.html" },
      { icon: "📝", label: "Cheat sheet", detail: "Big-O & template cheat sheet", url: "view.html?f=resources/big-o-cheatsheet.md" },
      { icon: "💬", label: "LeetCode Discuss", detail: lc ? ("Problem " + lc + " solutions") : "Community solutions", url: lc ? ("https://leetcode.com/problemset/all/?search=" + lc) : "https://leetcode.com/discuss/" },
      { icon: "📚", label: "Reference", detail: "CP-Algorithms", url: "https://cp-algorithms.com/" }
    ];
  }

  /* ------------------------------------------------------------------ */
  /* Motivational quotes                                                 */
  /* ------------------------------------------------------------------ */
  var QUOTES = [
    "Consistency beats intensity. Two problems today > twenty next week.",
    "You don't rise to the level of the interview; you fall to the level of your patterns.",
    "The expert has failed more times than the beginner has even tried.",
    "Master the pattern once, recognise it a thousand times.",
    "Slow is smooth, smooth is fast. Understand before you optimise.",
    "Every hard problem is an easy problem plus one insight.",
    "Don't memorise solutions. Internalise the moves that generate them.",
    "Small daily gains compound into interview-day confidence.",
    "Confusion is the sweat of learning. Sit with it, then break through.",
    "Revisit yesterday's pattern so tomorrow's problem feels familiar.",
    "The best time to revise was 3 days ago. The second best time is now.",
    "Write the brute force. Name the bottleneck. Reach for the pattern.",
    "Recognition speed is the real interview skill — train it daily.",
    "You are 30 days of focused reps away from a different candidate.",
    "Progress, not perfection. Close the loop on today.",
    "A pattern understood deeply is worth ten memorised.",
    "Show up for the streak; the skill takes care of itself.",
    "Optimal is a habit, not a flash of genius.",
    "Teach the pattern to your rubber duck. Gaps will surface.",
    "The map is the manifest; the territory is your fingertips.",
    "Hard today, muscle memory next week.",
    "Spaced repetition is compound interest for your brain.",
    "Solve it twice: once to learn, once to own.",
    "Your future self at the whiteboard is thanking you right now.",
    "Patterns are the vocabulary; problems are the sentences.",
    "Trust the schedule. Just do today's three.",
    "The interview rewards calm recognition, not frantic recall.",
    "You can't cram intuition. You can only accrue it.",
    "One clean template beats five half-remembered hacks.",
    "Finish strong: reflect, revise, repeat."
  ];

  /* ------------------------------------------------------------------ */
  /* Notifications (Feature 17)                                           */
  /*                                                                    */
  /* Offline-honest: with no backend/service-worker, notifications can   */
  /* only fire while a handbook tab is open. We surface the day's        */
  /* reminders on load and schedule a gentle in-session nudge.           */
  /* ------------------------------------------------------------------ */
  function notifySupported() { return typeof Notification !== "undefined"; }
  function notifyEnabled() { return notifySupported() && Notification.permission === "granted" && getPref("notify", false); }
  function requestNotify() {
    if (!notifySupported()) return Promise.resolve(false);
    return Notification.requestPermission().then(function (perm) {
      var ok = perm === "granted";
      setPref("notify", ok);
      if (ok) push("You're set!", "We'll nudge you about revisions and streaks while the handbook is open.");
      return ok;
    });
  }
  function push(title, body) {
    if (!notifyEnabled()) return;
    try { new Notification(title, { body: body, icon: "assets/images/03_favicon.png" }); } catch (e) {}
  }
  // Fire the relevant reminders for right now (called on page load).
  function runReminders() {
    if (!notifyEnabled()) return;
    var s = stats();
    if (s.revisionDue > 0) push("🔁 " + s.revisionDue + " revisions due", "Spend 5 minutes on today's flash cards to lock them in.");
    else if (!isDayComplete(s.currentDay)) push("🎯 Time to study", "Day " + s.currentDay + ": " + (getDayPrimaryName(s.currentDay)) + " awaits.");
    if (!s.streak.active && s.streak.current > 0) push("🔥 Keep your streak alive", "You have a " + s.streak.current + "-day streak — don't break it today!");
  }
  function getDayPrimaryName(n) { var d = buildPlan()[n - 1]; return d ? d.primary.name : "today's pattern"; }

  /* ------------------------------------------------------------------ */
  /* Export / import (Feature 18)                                        */
  /* ------------------------------------------------------------------ */
  function exportData() { return JSON.stringify(load(), null, 2); }
  function importData(json) {
    try { localStorage.setItem(KEY, JSON.stringify(JSON.parse(json))); fire(); return true; }
    catch (e) { return false; }
  }

  /* ------------------------------------------------------------------ */
  /* Public API                                                          */
  /* ------------------------------------------------------------------ */
  window.DSAJourney = {
    TOTAL_DAYS: TOTAL_DAYS,
    REVISION_OFFSETS: REVISION_OFFSETS,
    LEVELS: LEVELS,

    // scheduling
    getPlan: buildPlan,
    getDay: function (n) {
      var plan = buildPlan();
      var pd = plan[n - 1];
      if (!pd) return null;
      var q = dailyQuestions(pd.primary);
      var revs = revisionsForDay(n);
      // rough duration estimate (minutes), clamped to the 60–120 window
      var mins = 35 + pd.secondary.length * 8
        + q.must.reduce(function (a, m) { return a + m.estTime; }, 0)
        + (q.stretch ? Math.round(q.stretch.estTime * 0.5) : 0)
        + revs.length * 4;
      mins = Math.max(60, Math.min(120, mins));
      return {
        day: n,
        quote: pd.quote,
        primary: pd.primary,
        secondary: pd.secondary,
        patterns: pd.patterns,
        revisions: revs,
        questions: q,
        estimatedMinutes: mins
      };
    },
    currentDayNumber: currentDayNumber,
    revisionsForDay: revisionsForDay,
    studyDayOf: studyDayOf,

    // problems
    problemsFor: problemsFor,
    dailyQuestions: dailyQuestions,
    mustSolveList: mustSolveList,

    // revision + audio
    revisionCard: revisionCard,
    audioScript: audioScript,
    listenSections: listenSections,
    keyFormula: keyFormula,

    // resources
    videosFor: videosFor,
    resourcesFor: resourcesFor,

    // xp/level/streak
    awardXP: awardXP,
    levelForXp: levelForXp,
    streak: streak,
    stats: stats,
    categoryInsights: categoryInsights,
    interviewReadiness: interviewReadiness,
    weeklyReview: weeklyReview,

    // journey lifecycle
    isStarted: isStarted,
    startJourney: startJourney,
    resetJourney: resetJourney,
    isDayComplete: isDayComplete,
    completeDay: completeDay,
    taskState: taskState,
    toggleTask: toggleTask,

    // per-item progress
    isSolved: isSolved,
    toggleSolved: toggleSolved,
    isSavedProblem: isSavedProblem,
    toggleSavedProblem: toggleSavedProblem,
    isRevised: isRevised,
    markRevised: markRevised,
    getNote: getNote,
    setNote: setNote,
    getReflection: getReflection,
    setReflection: setReflection,
    getListenPos: getListenPos,
    setListenPos: setListenPos,
    isWatched: isWatched,
    toggleWatched: toggleWatched,
    getPref: getPref,
    setPref: setPref,

    // notifications
    notifySupported: notifySupported,
    notifyEnabled: notifyEnabled,
    requestNotify: requestNotify,
    runReminders: runReminders,

    // misc
    quotes: QUOTES,
    onChange: function (fn) { listeners.push(fn); },
    exportData: exportData,
    importData: importData
  };
})();
