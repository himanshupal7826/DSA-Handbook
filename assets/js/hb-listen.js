/* hb-listen.js — offline "Listen mode" for handbook topic pages.
 * Uses the browser SpeechSynthesis API (no network). Reads the rendered
 * content aloud with play/pause/resume, voice + speed selection, and live
 * highlighting. You can listen to:
 *   • the WHOLE chapter        — the ▶ Listen button
 *   • a SPECIFIC section       — the ▶ that appears on each heading
 *   • a SELECTED passage       — select text, press 🔊 Selection
 * Public API: DSAListen.attach(contentEl) — inserts a player above contentEl.
 * Degrades to nothing if the browser lacks speech synthesis. */
(function () {
  "use strict";
  var synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
    window.DSAListen = { attach: function () {} };
    return;
  }

  var READ_SEL = "h1,h2,h3,h4,p,li,blockquote,th,td";
  var SKIP_CLOSEST = ".code-block,.code-tabs,.diagram,.toc";

  function headingLevel(el) { var m = /^H([1-6])$/.exec(el.tagName); return m ? +m[1] : 0; }

  // text of an element, ignoring any controls we injected into it
  function readText(el) {
    var c = el.cloneNode(true);
    c.querySelectorAll(".listen-seg").forEach(function (b) { b.remove(); });
    return (c.textContent || "").replace(/\s+/g, " ").trim();
  }

  function collectSegments(root) {
    var out = [];
    root.querySelectorAll(READ_SEL).forEach(function (el) {
      if (el.closest(SKIP_CLOSEST)) return;
      var p = el.parentElement;
      while (p && p !== root) {
        if (p.matches && p.matches("p,li,blockquote,h1,h2,h3,h4")) return;
        p = p.parentElement;
      }
      var text = readText(el);
      if (text.length < 2) return;
      out.push({ el: el, text: text });
    });
    return out;
  }

  function loadVoices() {
    return new Promise(function (resolve) {
      var v = synth.getVoices();
      if (v && v.length) return resolve(v);
      var done = false;
      function grab() { if (done) return; var vv = synth.getVoices(); if (vv && vv.length) { done = true; resolve(vv); } }
      synth.onvoiceschanged = grab;
      setTimeout(function () { done = true; resolve(synth.getVoices() || []); }, 700);
    });
  }

  // split a free-text passage into short utterance-sized chunks
  function chunkText(t) {
    var parts = (t.replace(/\s+/g, " ").match(/[^.!?\n]+[.!?]*/g) || [t]);
    return parts.map(function (s) { return s.trim(); }).filter(function (s) { return s.length > 1; });
  }

  function attach(contentEl) {
    if (!contentEl || contentEl.dataset.listenAttached) return;
    contentEl.dataset.listenAttached = "1";

    var bar = document.createElement("div");
    bar.className = "listen-bar";
    bar.innerHTML =
      '<button class="listen-play btn primary" type="button" aria-label="Play"><span class="i">▶</span><span class="t">Listen</span></button>' +
      '<button class="listen-stop btn" type="button" aria-label="Stop" disabled>■ Stop</button>' +
      '<button class="listen-sel btn" type="button" title="Select text in the chapter, then read just that" disabled>🔊 Selection</button>' +
      '<div class="listen-prog"><span class="listen-prog-fill"></span></div>' +
      '<label class="listen-ctl">🗣️<select class="listen-voice" aria-label="Voice"></select></label>' +
      '<label class="listen-ctl">⚡<select class="listen-rate" aria-label="Speed">' +
      '<option value="0.75">0.75×</option><option value="1" selected>1×</option>' +
      '<option value="1.25">1.25×</option><option value="1.5">1.5×</option>' +
      '<option value="1.75">1.75×</option><option value="2">2×</option></select></label>';
    contentEl.parentNode.insertBefore(bar, contentEl);

    var playBtn = bar.querySelector(".listen-play");
    var stopBtn = bar.querySelector(".listen-stop");
    var selBtn = bar.querySelector(".listen-sel");
    var voiceSel = bar.querySelector(".listen-voice");
    var rateSel = bar.querySelector(".listen-rate");
    var progFill = bar.querySelector(".listen-prog-fill");
    var playI = playBtn.querySelector(".i");
    var playT = playBtn.querySelector(".t");

    var LS_VOICE = "zariya-listen-voice", LS_RATE = "zariya-listen-rate";
    var segments = collectSegments(contentEl);
    var queue = [], qi = 0, playing = false, paused = false, voices = [], activeSegBtn = null;

    // inject a "listen from here" ▶ on each H2/H3 section heading
    segments.forEach(function (s, i) {
      var lvl = headingLevel(s.el);
      if (lvl < 2 || lvl > 3) return;
      var b = document.createElement("button");
      b.className = "listen-seg"; b.type = "button"; b.textContent = "▶";
      b.title = "Listen to this section"; b.setAttribute("aria-label", "Listen to this section");
      b.addEventListener("click", function (e) {
        e.preventDefault(); e.stopPropagation();
        playSection(i, b);
      });
      s.el.appendChild(b);
    });

    loadVoices().then(function (v) {
      voices = (v || []).filter(function (x) { return /^en(-|_|$)/i.test(x.lang) || x.default; });
      if (!voices.length) voices = v || [];
      var saved = localStorage.getItem(LS_VOICE);
      voiceSel.innerHTML = voices.map(function (x, i) {
        return '<option value="' + i + '"' + (x.name === saved ? " selected" : "") + ">" +
          x.name.replace(/\s*\(.*\)/, "") + " · " + x.lang + "</option>";
      }).join("");
      if (!voices.length) voiceSel.disabled = true;
    });
    var savedRate = localStorage.getItem(LS_RATE);
    if (savedRate) rateSel.value = savedRate;

    function currentVoice() { return voices[+voiceSel.value] || null; }

    function clearHL() {
      contentEl.querySelectorAll(".listen-active").forEach(function (e) { e.classList.remove("listen-active"); });
    }
    function highlight(item, i) {
      clearHL();
      if (item && item.el) {
        item.el.classList.add("listen-active");
        var r = item.el.getBoundingClientRect();
        if (r.top < 80 || r.bottom > window.innerHeight - 60)
          item.el.scrollIntoView({ behavior: "smooth", block: "center" });
      }
      progFill.style.width = Math.round(((i + 1) / queue.length) * 100) + "%";
    }

    function speak(i) {
      if (i >= queue.length) { finish(); return; }
      qi = i;
      var u = new SpeechSynthesisUtterance(queue[i].text);
      var v = currentVoice(); if (v) u.voice = v;
      u.rate = parseFloat(rateSel.value) || 1;
      u.onstart = function () { highlight(queue[i], i); };
      u.onend = function () { if (playing && !paused) speak(i + 1); };
      u.onerror = function () { if (playing && !paused) speak(i + 1); };
      synth.speak(u);
    }

    function setPlayingUI(on) {
      playI.textContent = on ? (paused ? "▶" : "❚❚") : "▶";
      playT.textContent = on ? (paused ? "Resume" : "Pause") : "Listen";
      playBtn.classList.toggle("is-playing", on && !paused);
      stopBtn.disabled = !on;
    }
    function markSegBtn(b) {
      if (activeSegBtn) activeSegBtn.classList.remove("playing");
      activeSegBtn = b || null;
      if (activeSegBtn) activeSegBtn.classList.add("playing");
    }

    function playQueue(items, segBtn) {
      synth.cancel();
      queue = items; if (!queue.length) return;
      playing = true; paused = false;
      markSegBtn(segBtn || null);
      setPlayingUI(true);
      speak(0);
    }
    function asItems(a, b) { return segments.slice(a, b).map(function (s) { return { text: s.text, el: s.el }; }); }

    function playWhole() { playQueue(asItems(0, segments.length)); }
    function endOfSection(start) {
      var L = headingLevel(segments[start].el);
      for (var j = start + 1; j < segments.length; j++) {
        var l = headingLevel(segments[j].el);
        if (l > 0 && l <= L) return j;
      }
      return segments.length;
    }
    function playSection(i, btn) { playQueue(asItems(i, endOfSection(i)), btn); }
    function playSelection() {
      var txt = selectionText();
      if (!txt) return;
      playQueue(chunkText(txt).map(function (t) { return { text: t, el: null }; }));
    }

    function finish() {
      playing = false; paused = false;
      synth.cancel(); clearHL(); markSegBtn(null);
      progFill.style.width = "0%";
      setPlayingUI(false);
    }

    function selectionText() {
      var sel = window.getSelection && window.getSelection();
      if (!sel || sel.isCollapsed || !sel.rangeCount) return "";
      var node = sel.anchorNode;
      if (!node || !contentEl.contains(node)) return "";
      return (sel.toString() || "").trim();
    }

    playBtn.addEventListener("click", function () {
      if (!playing) { playWhole(); return; }
      if (!paused) { synth.pause(); paused = true; setPlayingUI(true); }
      else { synth.resume(); paused = false; setPlayingUI(true); }
    });
    stopBtn.addEventListener("click", finish);
    selBtn.addEventListener("click", playSelection);
    document.addEventListener("selectionchange", function () { selBtn.disabled = !selectionText(); });

    rateSel.addEventListener("change", function () {
      localStorage.setItem(LS_RATE, rateSel.value);
      if (playing && !paused) { synth.cancel(); speak(qi); }
    });
    voiceSel.addEventListener("change", function () {
      var v = currentVoice(); if (v) localStorage.setItem(LS_VOICE, v.name);
      if (playing && !paused) { synth.cancel(); speak(qi); }
    });

    window.addEventListener("beforeunload", function () { synth.cancel(); });
    window.addEventListener("pagehide", function () { synth.cancel(); });
  }

  window.DSAListen = { attach: attach };
})();
