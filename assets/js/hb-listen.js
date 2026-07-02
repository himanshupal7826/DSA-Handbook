/* hb-listen.js — offline "Listen mode" for handbook topic pages.
 * Uses the browser SpeechSynthesis API (no network). Reads the rendered
 * content element aloud paragraph-by-paragraph with play/pause/resume,
 * voice selection, playback speed, and live paragraph highlighting.
 * Public API: DSAListen.attach(contentEl)  — inserts a player above contentEl.
 * Degrades to nothing if the browser lacks speech synthesis. */
(function () {
  "use strict";
  var synth = window.speechSynthesis;
  if (!synth || typeof SpeechSynthesisUtterance === "undefined") {
    window.DSAListen = { attach: function () {} };
    return;
  }

  // Elements whose text we read, in document order. Code/diagrams are skipped.
  var READ_SEL = "h1,h2,h3,h4,p,li,blockquote,th,td";
  var SKIP_CLOSEST = ".code-block,.code-tabs,.diagram,.toc";

  function collectSegments(root) {
    var out = [];
    root.querySelectorAll(READ_SEL).forEach(function (el) {
      if (el.closest(SKIP_CLOSEST)) return;
      // avoid double-reading nested (e.g. blockquote containing p): skip if an
      // ancestor within root is itself a readable block that we'll read.
      var p = el.parentElement;
      while (p && p !== root) {
        if (p.matches && p.matches("p,li,blockquote,h1,h2,h3,h4")) return;
        p = p.parentElement;
      }
      var text = (el.textContent || "").replace(/\s+/g, " ").trim();
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

  function attach(contentEl) {
    if (!contentEl || contentEl.dataset.listenAttached) return;
    contentEl.dataset.listenAttached = "1";

    var bar = document.createElement("div");
    bar.className = "listen-bar";
    bar.innerHTML =
      '<button class="listen-play btn primary" type="button" aria-label="Play"><span class="i">▶</span><span class="t">Listen</span></button>' +
      '<button class="listen-stop btn" type="button" aria-label="Stop" disabled>■ Stop</button>' +
      '<div class="listen-prog"><span class="listen-prog-fill"></span></div>' +
      '<label class="listen-ctl">🗣️<select class="listen-voice" aria-label="Voice"></select></label>' +
      '<label class="listen-ctl">⚡<select class="listen-rate" aria-label="Speed">' +
      '<option value="0.75">0.75×</option><option value="1" selected>1×</option>' +
      '<option value="1.25">1.25×</option><option value="1.5">1.5×</option>' +
      '<option value="1.75">1.75×</option><option value="2">2×</option></select></label>';
    contentEl.parentNode.insertBefore(bar, contentEl);

    var playBtn = bar.querySelector(".listen-play");
    var stopBtn = bar.querySelector(".listen-stop");
    var voiceSel = bar.querySelector(".listen-voice");
    var rateSel = bar.querySelector(".listen-rate");
    var progFill = bar.querySelector(".listen-prog-fill");
    var playI = playBtn.querySelector(".i");
    var playT = playBtn.querySelector(".t");

    var segments = [];
    var idx = 0, playing = false, paused = false, voices = [];

    var LS_VOICE = "zariya-listen-voice", LS_RATE = "zariya-listen-rate";

    loadVoices().then(function (v) {
      voices = (v || []).filter(function (x) { return /^en(-|_|$)/i.test(x.lang) || x.default; });
      if (!voices.length) voices = v || [];
      var saved = localStorage.getItem(LS_VOICE);
      voiceSel.innerHTML = voices.map(function (x, i) {
        return '<option value="' + i + '"' + (x.name === saved ? " selected" : "") + ">" +
          x.name.replace(/\s*\(.*\)/, "") + " · " + x.lang + "</option>";
      }).join("");
      if (!voices.length) { voiceSel.disabled = true; }
    });
    var savedRate = localStorage.getItem(LS_RATE);
    if (savedRate) rateSel.value = savedRate;

    function currentVoice() { return voices[+voiceSel.value] || null; }

    function clearHL() {
      contentEl.querySelectorAll(".listen-active").forEach(function (e) { e.classList.remove("listen-active"); });
    }
    function highlight(i) {
      clearHL();
      var s = segments[i]; if (!s) return;
      s.el.classList.add("listen-active");
      var r = s.el.getBoundingClientRect();
      if (r.top < 80 || r.bottom > window.innerHeight - 60)
        s.el.scrollIntoView({ behavior: "smooth", block: "center" });
      progFill.style.width = Math.round((i / segments.length) * 100) + "%";
    }

    function speakFrom(i) {
      if (i >= segments.length) { finish(); return; }
      idx = i;
      var u = new SpeechSynthesisUtterance(segments[i].text);
      var v = currentVoice(); if (v) u.voice = v;
      u.rate = parseFloat(rateSel.value) || 1;
      u.onstart = function () { highlight(i); };
      u.onend = function () { if (playing && !paused) speakFrom(i + 1); };
      u.onerror = function () { if (playing && !paused) speakFrom(i + 1); };
      synth.speak(u);
    }

    function setPlayingUI(on) {
      playI.textContent = on ? (paused ? "▶" : "❚❚") : "▶";
      playT.textContent = on ? (paused ? "Resume" : "Pause") : "Listen";
      playBtn.classList.toggle("is-playing", on && !paused);
      stopBtn.disabled = !on;
    }

    function start() {
      synth.cancel();
      segments = collectSegments(contentEl);
      if (!segments.length) return;
      playing = true; paused = false;
      setPlayingUI(true);
      speakFrom(0);
    }
    function finish() {
      playing = false; paused = false;
      synth.cancel(); clearHL();
      progFill.style.width = "0%";
      setPlayingUI(false);
    }

    playBtn.addEventListener("click", function () {
      if (!playing) { start(); return; }
      if (!paused) { synth.pause(); paused = true; setPlayingUI(true); }
      else { synth.resume(); paused = false; setPlayingUI(true); }
    });
    stopBtn.addEventListener("click", finish);

    rateSel.addEventListener("change", function () {
      localStorage.setItem(LS_RATE, rateSel.value);
      // apply new rate immediately by restarting current segment
      if (playing && !paused) { synth.cancel(); speakFrom(idx); }
    });
    voiceSel.addEventListener("change", function () {
      var v = currentVoice(); if (v) localStorage.setItem(LS_VOICE, v.name);
      if (playing && !paused) { synth.cancel(); speakFrom(idx); }
    });

    // Stop speech when leaving the page (avoids voice bleeding across navigation).
    window.addEventListener("beforeunload", function () { synth.cancel(); });
    window.addEventListener("pagehide", function () { synth.cancel(); });
  }

  window.DSAListen = { attach: attach };
})();
