/* =====================================================================
 * daily.js — Daily LeetCode Practice engine.
 *
 * "Give me N LeetCode questions every day." The user picks N (and an
 * optional difficulty mix / focus); the engine picks a fresh, stable set
 * of N problems for today from the ~400 problems referenced across the
 * 100 patterns. Sets are deterministic per date (reload-safe), skip
 * problems already solved, avoid repeats from the last week, and spread
 * across patterns so each day exercises different techniques. Unsolved
 * questions are never skipped: they carry over to the next day until the
 * user submits a solution for them.
 *
 * Pure client-side, LocalStorage only. Reuses:
 *   window.DSA_PATTERNS  (manifest)         — problem pool
 *   window.DSAJourney    (journey.js)        — problem parsing, solved state, XP
 *   window.DSAProgress   (progress.js)       — bookmarked patterns (focus mode)
 *
 * Public API: window.DSADaily
 *
 * State shape (LocalStorage key "dsa-daily"):
 *   {
 *     n:     3,                          // questions per day (the input)
 *     mix:   "balanced"|"easy"|"medium"|"hard"|"any",
 *     focus: "all"|"journey"|"bookmarked"|"<Category name>",
 *     salt:  0,                          // reserved (seed offset)
 *     days:  { "2026-09-06": { ids: ["242","1","76"], carried: ["76"], n: 3 } },
 *     bonus: { "2026-09-06": true }      // idempotency guard for daily-complete XP
 *   }
 *
 * Submissions live under their own key ("dsa-submissions") so resetting
 * daily-practice settings never deletes your code:
 *   { "242": { lang:"python", code:"...", note:"...", at:"2026-09-06T14:02:11.000Z",
 *              date:"2026-09-06", minutes: 18, history:[{lang,code,at}] } }
 * A problem counts as DONE only when a submission is stored for it.
 * ===================================================================== */
(function () {
  "use strict";

  var KEY = "dsa-daily";
  var SUB_KEY = "dsa-submissions";
  var MIN_CODE_CHARS = 20;
  var LANGS = [
    { id: "python", name: "Python" }, { id: "go", name: "Go" }, { id: "java", name: "Java" },
    { id: "cpp", name: "C++" }, { id: "javascript", name: "JavaScript" }, { id: "typescript", name: "TypeScript" },
    { id: "rust", name: "Rust" }, { id: "other", name: "Other" }
  ];
  var DEFAULT_N = 3;
  var MIN_N = 1, MAX_N = 20;
  var NO_REPEAT_DAYS = 7;
  var COMPLETE_XP = 50;

  var P = window.DSA_PATTERNS || [];
  var J = window.DSAJourney;
  var PR = window.DSAProgress;

  /* ------------------------------------------------------------------ */
  /* State                                                              */
  /* ------------------------------------------------------------------ */
  function load() {
    try { return JSON.parse(localStorage.getItem(KEY)) || {}; }
    catch (e) { return {}; }
  }
  var listeners = [];
  function fire() { listeners.forEach(function (fn) { try { fn(); } catch (e) {} }); }
  function save(s) { localStorage.setItem(KEY, JSON.stringify(s)); fire(); }
  function bucket(s, name) { if (!s[name]) s[name] = {}; return s[name]; }

  function clampN(n) {
    n = parseInt(n, 10);
    if (isNaN(n)) return DEFAULT_N;
    return Math.max(MIN_N, Math.min(MAX_N, n));
  }
  function getN() { var s = load(); return s.n ? clampN(s.n) : DEFAULT_N; }
  function getMix() { return load().mix || "balanced"; }
  function getFocus() { return load().focus || "all"; }

  /* ------------------------------------------------------------------ */
  /* Dates                                                              */
  /* ------------------------------------------------------------------ */
  function isoDate(d) {
    var y = d.getFullYear(), m = d.getMonth() + 1, day = d.getDate();
    return y + "-" + (m < 10 ? "0" : "") + m + "-" + (day < 10 ? "0" : "") + day;
  }
  function today() { return isoDate(new Date()); }
  function parseIso(s) { var p = String(s).split("-"); return new Date(+p[0], +p[1] - 1, +p[2]); }
  function addDays(iso, n) { var d = parseIso(iso); d.setDate(d.getDate() + n); return isoDate(d); }
  function daysBetween(a, b) { return Math.round((parseIso(b) - parseIso(a)) / 86400000); }

  /* ------------------------------------------------------------------ */
  /* Deterministic hashing / shuffling                                  */
  /* ------------------------------------------------------------------ */
  function hashStr(str) {
    // FNV-1a 32-bit
    var h = 2166136261;
    for (var i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 16777619) >>> 0;
    }
    return h >>> 0;
  }
  function rng(seed) {
    // mulberry32
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      var t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function shuffle(arr, seed) {
    var out = arr.slice(), r = rng(seed);
    for (var i = out.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var tmp = out[i]; out[i] = out[j]; out[j] = tmp;
    }
    return out;
  }


  /* ------------------------------------------------------------------ */
  /* Real LeetCode difficulties for every problem referenced in the     */
  /* manifest (journey.js only guesses for the ones outside its hint    */
  /* tables). Keeps the Easy/Medium/Hard quota honest.                  */
  /* ------------------------------------------------------------------ */
  var E = "Easy", M = "Medium", H = "Hard";
  var DIFFICULTY = {
    1:E,2:M,3:M,5:M,10:H,11:M,15:M,16:M,18:M,19:M,21:E,23:H,24:M,25:H,26:E,27:E,30:H,31:M,33:M,34:M,35:E,36:M,37:H,
    39:M,40:M,42:H,45:M,46:M,47:M,49:M,51:H,52:H,55:M,56:M,57:M,60:H,62:M,64:M,69:E,72:M,75:M,76:H,77:M,78:M,79:M,
    80:M,81:M,82:M,84:H,85:H,90:M,92:M,94:E,102:M,103:M,104:E,108:E,110:E,111:E,112:E,113:M,115:H,120:M,121:E,124:H,
    125:E,127:H,129:M,133:M,134:M,141:E,142:M,144:E,145:E,148:M,153:M,154:H,159:M,162:M,167:M,179:M,188:H,199:M,200:M,
    202:E,203:E,206:E,207:M,208:M,209:M,210:M,211:M,212:H,215:M,216:M,217:E,218:H,221:M,233:H,234:E,235:M,236:M,238:M,
    239:H,242:E,252:E,253:M,259:M,269:H,278:E,279:M,283:E,287:M,295:H,300:M,303:E,307:M,309:M,310:M,315:H,322:M,327:H,
    337:M,340:M,344:E,346:E,347:M,352:H,354:H,367:E,370:M,373:M,374:E,377:M,378:M,383:E,387:E,399:M,407:H,410:H,416:M,
    417:M,424:M,435:M,437:M,438:M,452:M,454:M,474:M,480:H,493:H,494:M,496:E,502:H,503:M,508:M,515:M,518:M,540:M,542:M,
    543:E,547:M,556:M,559:E,560:M,567:M,583:M,600:H,630:H,632:H,643:E,646:M,648:M,658:M,663:M,673:M,684:M,687:M,692:M,
    698:M,699:H,703:E,704:E,713:M,714:M,715:H,724:E,739:M,743:M,744:E,759:H,774:H,778:H,785:M,787:M,802:M,805:H,834:H,
    847:H,850:H,852:M,862:H,871:H,875:M,876:E,901:M,902:H,905:E,912:M,928:H,930:M,943:H,956:H,968:H,973:M,981:M,983:M,
    986:M,992:H,994:M,1004:M,1011:M,1012:H,1046:E,1049:M,1066:M,1091:M,1092:H,1094:M,1095:H,1109:M,1135:M,1143:M,
    1167:M,1192:H,1234:M,1235:H,1306:M,1319:M,1326:H,1334:M,1349:H,1351:E,1353:M,1382:M,1425:H,1438:M,1456:M,1471:M,
    1482:M,1489:H,1504:M,1514:M,1519:M,1521:H,1522:M,1539:E,1568:H,1584:M,1626:M,1631:M,1644:M,1650:M,1696:M,1755:H,
    1825:H,1854:E,1916:H,2035:H,2080:M,2104:M,2187:M,2231:E,2300:M,2322:H,2360:H,2402:H,2467:M,2538:H,2642:H
  };
  function applyDifficulty(q) {
    var real = q.num ? DIFFICULTY[+q.num] : null;
    if (!real || real === q.difficulty) return q;
    q.difficulty = real;
    var n = q.num ? +q.num : 0;
    q.estTime = (real === E ? 12 : real === M ? 25 : 40) + (n % 9);
    var accBase = real === E ? 58 : real === M ? 45 : 35;
    q.acceptance = (accBase + (n % 13) - 6) + "%";
    q.complexity = real === H ? "Aim for better than brute force; often O(n log n) or O(n)." : "Target O(n) time, O(n) or O(1) extra space.";
    q.revisit = real === H ? "Revisit in 3 days, then 7 days." : "Revisit in 7 days if it took > estimate.";
    return q;
  }

  /* ------------------------------------------------------------------ */
  /* Problem pool — every unique LeetCode problem across all patterns   */
  /* ------------------------------------------------------------------ */
  var _pool = null, _byId = null;
  function pool() {
    if (_pool) return _pool;
    _pool = []; _byId = {};
    if (!J) return _pool;
    P.forEach(function (p) {
      J.problemsFor(p).forEach(function (q) {
        applyDifficulty(q);
        if (_byId[q.id]) {
          // same problem referenced by several patterns — remember all of them
          if (_byId[q.id].patterns.indexOf(p) === -1) _byId[q.id].patterns.push(p);
          return;
        }
        q.patterns = [p];
        q.category = p.category;
        q.level = p.level;
        q.patternId = p.id;
        _byId[q.id] = q;
        _pool.push(q);
      });
    });
    return _pool;
  }
  function byId(id) { pool(); return _byId[id] || null; }
  function categories() {
    var cats = [];
    P.forEach(function (p) { if (cats.indexOf(p.category) === -1) cats.push(p.category); });
    return cats;
  }

  /* ------------------------------------------------------------------ */
  /* Candidate filtering                                                */
  /* ------------------------------------------------------------------ */
  function isSolved(id) { return !!(J && J.isSolved(id)); }

  function recentIds(date, days) {
    var s = load(), d = s.days || {}, seen = {};
    for (var i = 1; i <= days; i++) {
      var rec = d[addDays(date, -i)];
      if (rec && rec.ids) rec.ids.forEach(function (id) { seen[id] = true; });
    }
    return seen;
  }

  function focusFilter(focus) {
    if (focus === "journey" && J) {
      var cur = J.isStarted() ? J.currentDayNumber() : 30;
      return function (q) { return q.patterns.some(function (p) { return (J.studyDayOf(p.slug) || 99) <= cur; }); };
    }
    if (focus === "bookmarked" && PR) {
      var anyBookmarked = P.some(function (p) { return PR.isBookmarked(p.slug); });
      if (!anyBookmarked) return function () { return true; };
      return function (q) { return q.patterns.some(function (p) { return PR.isBookmarked(p.slug); }); };
    }
    if (focus && focus !== "all" && categories().indexOf(focus) >= 0) {
      return function (q) { return q.patterns.some(function (p) { return p.category === focus; }); };
    }
    return function () { return true; };
  }

  // Target difficulty counts for N questions under a given mix.
  function difficultyQuota(n, mix) {
    if (mix === "easy") return { Easy: n, Medium: 0, Hard: 0 };
    if (mix === "medium") return { Easy: 0, Medium: n, Hard: 0 };
    if (mix === "hard") return { Easy: 0, Medium: 0, Hard: n };
    if (mix === "any") return null;
    // balanced: ~35% easy, ~45% medium, ~20% hard; N=1 -> medium, N=2 -> easy+medium
    if (n === 1) return { Easy: 0, Medium: 1, Hard: 0 };
    if (n === 2) return { Easy: 1, Medium: 1, Hard: 0 };
    var hard = Math.max(1, Math.round(n * 0.2));
    var easy = Math.max(1, Math.round(n * 0.35));
    var medium = n - hard - easy;
    if (medium < 1) { medium = 1; easy = Math.max(0, n - hard - medium); }
    return { Easy: easy, Medium: medium, Hard: hard };
  }

  /* ------------------------------------------------------------------ */
  /* Selection                                                          */
  /*                                                                    */
  /* pick(date, n, exclude) -> array of problem ids                     */
  /*  1. drop solved, recently-shown, and out-of-focus problems         */
  /*  2. seeded shuffle (seed = date + salt) for day-to-day variety      */
  /*  3. bias toward easier patterns first (pedagogical manifest order)  */
  /*     by sorting into "tiers" and shuffling within tiers             */
  /*  4. fill difficulty quota, preferring a new pattern for each slot   */
  /*  5. relax constraints (repeat window, quota, pattern diversity)     */
  /*     progressively if the pool runs dry                             */
  /* ------------------------------------------------------------------ */
  function pick(date, n, exclude, opts) {
    opts = opts || {};
    var s = load();
    var salt = opts.salt != null ? opts.salt : (s.salt || 0);
    var mix = opts.mix || getMix();
    var focus = opts.focus || getFocus();
    var seed = hashStr(date + "|" + salt);
    var inFocus = focusFilter(focus);
    var recent = recentIds(date, NO_REPEAT_DAYS);
    var excluded = {};
    (exclude || []).forEach(function (id) { excluded[id] = true; });

    var all = pool();
    function candidates(relaxRecent, relaxFocus) {
      return all.filter(function (q) {
        if (excluded[q.id] || isSolved(q.id)) return false;
        if (!relaxRecent && recent[q.id]) return false;
        if (!relaxFocus && !inFocus(q)) return false;
        return true;
      });
    }

    var cands = candidates(false, false);
    if (cands.length < n) cands = candidates(true, false);
    if (cands.length < n) cands = candidates(true, true);

    // tiered shuffle: patterns 1-25, 26-50, 51-75, 76-100 -> stable-ish progression
    // but randomised within each tier so consecutive days differ.
    var shuffled = shuffle(cands, seed);
    shuffled.sort(function (a, b) {
      var ta = Math.floor((a.patternId - 1) / 25), tb = Math.floor((b.patternId - 1) / 25);
      return ta - tb;
    });
    // Interleave tiers so every day touches a range of difficulty rather than
    // grinding only the earliest patterns: take from tiers round-robin.
    var tiers = [[], [], [], []];
    shuffled.forEach(function (q) { tiers[Math.min(3, Math.floor((q.patternId - 1) / 25))].push(q); });
    var ordered = [];
    var weights = [3, 2, 2, 1]; // still favour earlier tiers
    var idx = [0, 0, 0, 0];
    while (ordered.length < shuffled.length) {
      for (var t = 0; t < 4; t++) {
        for (var w = 0; w < weights[t]; w++) {
          if (idx[t] < tiers[t].length) ordered.push(tiers[t][idx[t]++]);
        }
      }
    }

    var quota = difficultyQuota(n, mix);
    var chosen = [], usedPattern = {}, usedId = {};
    function take(q) { chosen.push(q); usedId[q.id] = true; usedPattern[q.patternSlug] = true; }
    function fits(q, needQuota, needDiversity) {
      if (usedId[q.id]) return false;
      if (needQuota && quota && quota[q.difficulty] <= 0) return false;
      if (needDiversity && usedPattern[q.patternSlug]) return false;
      return true;
    }
    var passes = [[true, true], [true, false], [false, true], [false, false]];
    for (var pi = 0; pi < passes.length && chosen.length < n; pi++) {
      for (var i = 0; i < ordered.length && chosen.length < n; i++) {
        var q = ordered[i];
        if (!fits(q, passes[pi][0], passes[pi][1])) continue;
        take(q);
        if (quota && quota[q.difficulty] > 0) quota[q.difficulty]--;
      }
    }
    // order the day's list Easy -> Medium -> Hard
    var rank = { Easy: 0, Medium: 1, Hard: 2 };
    chosen.sort(function (a, b) { return rank[a.difficulty] - rank[b.difficulty] || a.patternId - b.patternId; });
    return chosen.map(function (q) { return q.id; });
  }

  /* ------------------------------------------------------------------ */
  /* Day sets — stable once generated for a date                        */
  /* ------------------------------------------------------------------ */
  function carryOver(date, n) {
    var s = load(), days = s.days || {};
    var prevDates = Object.keys(days).filter(function (d) { return d < date && days[d] && days[d].ids; }).sort();
    if (!prevDates.length) return [];
    var last = days[prevDates[prevDates.length - 1]];
    return last.ids.filter(function (id) { return !isSolved(id); }).slice(0, n);
  }

  function ensureDay(date) {
    date = date || today();
    var s = load();
    var days = bucket(s, "days");
    var n = getN();
    var rec = days[date];
    if (!rec || !rec.ids) {
      // Nothing gets skipped: unsolved questions from the most recent set are
      // carried over first, and only the remaining slots get fresh picks.
      var carried = carryOver(date, n);
      rec = { ids: carried.concat(pick(date, n - carried.length, carried)), salt: s.salt || 0, n: n, carried: carried };
      days[date] = rec;
      save(s);
      return rec;
    }
    // N changed after today's set was built: grow (append) or shrink
    // (drop unsolved from the end) without disturbing what's already there.
    // N raised after today's set was built: append fresh picks. Lowering N
    // never removes an assigned question — it takes effect from tomorrow.
    if (date === today() && rec.ids.length < n) {
      rec.ids = rec.ids.concat(pick(date, n - rec.ids.length, rec.ids));
      rec.n = n;
      days[date] = rec;
      save(s);
    }
    return rec;
  }

  function getDay(date) {
    date = date || today();
    var rec = ensureDay(date);
    var rank = { Easy: 0, Medium: 1, Hard: 2 };
    var problems = rec.ids.map(byId).filter(Boolean)
      .sort(function (a, b) { return rank[a.difficulty] - rank[b.difficulty] || a.patternId - b.patternId; });
    var solved = problems.filter(function (q) { return isSolved(q.id); }).length;
    var carried = {};
    (rec.carried || []).forEach(function (id) { carried[id] = true; });
    problems.forEach(function (q) { q.carried = !!carried[q.id]; });
    return {
      date: date,
      ids: rec.ids,
      carriedIds: rec.carried || [],
      problems: problems,
      solved: solved,
      total: problems.length,
      complete: problems.length > 0 && solved === problems.length,
      estimatedMinutes: problems.reduce(function (a, q) { return a + q.estTime; }, 0)
    };
  }

  /* ------------------------------------------------------------------ */
  /* Settings                                                           */
  /* ------------------------------------------------------------------ */
  function setN(n) {
    var s = load(); s.n = clampN(n); save(s);
    ensureDay(today());
    return s.n;
  }
  function setMix(mix) {
    var s = load(); s.mix = mix; save(s);
  }
  function setFocus(focus) {
    var s = load(); s.focus = focus; save(s);
  }

  /* ------------------------------------------------------------------ */
  /* Solving                                                            */
  /* ------------------------------------------------------------------ */
  function toggleSolved(id) {
    if (!J) return false;
    var on = J.toggleSolved(id);          // shares XP + solved state with the Journey
    var d = getDay(today());
    var s = load(), bonus = bucket(s, "bonus");
    if (d.complete && !bonus[d.date]) {
      bonus[d.date] = true;
      save(s);
      J.awardXP("daily:complete:" + d.date, COMPLETE_XP, "Finished daily practice set");
    }
    fire();
    return on;
  }


  /* ------------------------------------------------------------------ */
  /* Submissions — "did I actually do it?"                              */
  /* The user pastes the code they submitted on LeetCode. Storing it    */
  /* is what marks the problem solved; deleting it un-solves it.        */
  /* ------------------------------------------------------------------ */
  function loadSubs() {
    try { return JSON.parse(localStorage.getItem(SUB_KEY)) || {}; }
    catch (e) { return {}; }
  }
  function saveSubs(subs) { localStorage.setItem(SUB_KEY, JSON.stringify(subs)); }

  function getSubmission(id) { return loadSubs()[id] || null; }
  function hasSubmission(id) { return !!loadSubs()[id]; }

  function validateCode(code) {
    var c = String(code || "").trim();
    if (c.length < MIN_CODE_CHARS) return "Paste your actual solution (at least " + MIN_CODE_CHARS + " characters).";
    if (!/[(){};:=]/.test(c)) return "That doesn't look like code — paste the solution you submitted on LeetCode.";
    return null;
  }

  // submit(id, {lang, code, note, minutes}) -> { ok, error, submission, newlySolved, dayComplete }
  function submit(id, payload) {
    payload = payload || {};
    var err = validateCode(payload.code);
    if (err) return { ok: false, error: err };
    var subs = loadSubs();
    var prev = subs[id];
    var now = new Date();
    var rec = {
      lang: payload.lang || (prev && prev.lang) || "python",
      code: String(payload.code).replace(/\r\n/g, "\n"),
      note: String(payload.note || "").trim(),
      minutes: payload.minutes != null && payload.minutes !== "" ? Math.max(0, parseInt(payload.minutes, 10) || 0) : (prev ? prev.minutes : null),
      at: now.toISOString(),
      date: today(),
      attempts: prev ? (prev.attempts || 1) + 1 : 1,
      history: prev ? (prev.history || []).concat([{ lang: prev.lang, code: prev.code, at: prev.at }]).slice(-5) : []
    };
    subs[id] = rec;
    saveSubs(subs);

    var newlySolved = false;
    if (!isSolved(id)) { toggleSolved(id); newlySolved = true; }
    else fire();
    var d = getDay(today());
    return { ok: true, submission: rec, newlySolved: newlySolved, dayComplete: d.complete && d.ids.indexOf(id) >= 0 };
  }

  // Remove the stored code and un-solve the problem.
  function withdraw(id) {
    var subs = loadSubs();
    if (!subs[id]) return false;
    delete subs[id];
    saveSubs(subs);
    if (isSolved(id)) J.toggleSolved(id);
    fire();
    return true;
  }

  function allSubmissions() {
    var subs = loadSubs();
    return Object.keys(subs).map(function (id) {
      var q = byId(id);
      return { id: id, problem: q, submission: subs[id] };
    }).sort(function (a, b) { return a.submission.at < b.submission.at ? 1 : -1; });
  }

  function exportSubmissions() { return JSON.stringify(loadSubs(), null, 2); }
  function importSubmissions(json) {
    try {
      var incoming = JSON.parse(json); if (!incoming || typeof incoming !== "object") return false;
      var subs = loadSubs();
      Object.keys(incoming).forEach(function (id) { subs[id] = incoming[id]; if (!isSolved(id)) J.toggleSolved(id); });
      saveSubs(subs); fire(); return true;
    } catch (e) { return false; }
  }

  /* ------------------------------------------------------------------ */
  /* Stats / history                                                    */
  /* ------------------------------------------------------------------ */
  function dayStatus(date) {
    var s = load(), rec = (s.days || {})[date];
    if (!rec || !rec.ids || !rec.ids.length) return null;
    var solved = rec.ids.filter(isSolved).length;
    return { date: date, total: rec.ids.length, solved: solved, complete: solved === rec.ids.length };
  }

  function streak() {
    var t = today();
    var current = 0, longest = 0, run = 0;
    var s = load(), days = Object.keys(s.days || {}).sort();
    if (!days.length) return { current: 0, longest: 0, active: false };
    // longest run of consecutive complete days
    var prev = null;
    days.forEach(function (d) {
      var st = dayStatus(d);
      if (st && st.complete) {
        run = (prev && daysBetween(prev, d) === 1) ? run + 1 : 1;
        longest = Math.max(longest, run);
        prev = d;
      } else { run = 0; prev = null; }
    });
    // current streak, counting back from today (yesterday still counts if today is unfinished)
    var cursor = t;
    var todaySt = dayStatus(t);
    var active = !!(todaySt && todaySt.complete);
    if (!active) cursor = addDays(t, -1);
    while (true) {
      var st = dayStatus(cursor);
      if (st && st.complete) { current++; cursor = addDays(cursor, -1); }
      else break;
    }
    return { current: current, longest: longest, active: active };
  }

  function history(daysBack) {
    var out = [], t = today();
    for (var i = daysBack - 1; i >= 0; i--) {
      var d = addDays(t, -i);
      out.push(dayStatus(d) || { date: d, total: 0, solved: 0, complete: false });
    }
    return out;
  }

  function stats() {
    var s = load();
    var days = Object.keys(s.days || {});
    var completeDays = 0, assigned = 0, solvedAssigned = 0;
    days.forEach(function (d) {
      var st = dayStatus(d);
      if (!st) return;
      assigned += st.total; solvedAssigned += st.solved;
      if (st.complete) completeDays++;
    });
    var totalSolved = 0;
    try { totalSolved = Object.keys((JSON.parse(localStorage.getItem("dsa-journey")) || {}).solved || {}).length; } catch (e) {}
    var all = pool().length;
    var subs = loadSubs();
    var subCount = Object.keys(subs).length;
    var langCounts = {};
    Object.keys(subs).forEach(function (id) { var l = subs[id].lang || "other"; langCounts[l] = (langCounts[l] || 0) + 1; });
    return {
      submissions: subCount, langCounts: langCounts,
      n: getN(), mix: getMix(), focus: getFocus(),
      daysPracticed: days.length, daysComplete: completeDays,
      assigned: assigned, solvedAssigned: solvedAssigned,
      totalSolved: totalSolved, poolSize: all,
      remaining: Math.max(0, all - totalSolved),
      streak: streak(),
      xp: J ? J.stats().xp : 0,
      level: J ? J.levelForXp(J.stats().xp) : null
    };
  }

  function reset() { localStorage.removeItem(KEY); fire(); }

  window.DSADaily = {
    // settings
    getN: getN, setN: setN, minN: MIN_N, maxN: MAX_N,
    getMix: getMix, setMix: setMix,
    getFocus: getFocus, setFocus: setFocus,
    categories: categories,
    // today
    today: today,
    getDay: getDay,
    toggleSolved: toggleSolved,
    isSolved: isSolved,
    // submissions (proof of work)
    langs: LANGS,
    getSubmission: getSubmission,
    hasSubmission: hasSubmission,
    validateCode: validateCode,
    submit: submit,
    withdraw: withdraw,
    allSubmissions: allSubmissions,
    exportSubmissions: exportSubmissions,
    importSubmissions: importSubmissions,
    // analytics
    stats: stats,
    streak: streak,
    history: history,
    dayStatus: dayStatus,
    pool: pool,
    byId: byId,
    // misc
    onChange: function (fn) { listeners.push(fn); },
    reset: reset
  };
})();
