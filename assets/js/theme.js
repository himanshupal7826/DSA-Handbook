/* =====================================================================
 * theme.js — Light / Dark / Auto theme manager (persisted in LocalStorage)
 * ===================================================================== */
(function () {
  var KEY = "dsa-theme"; // values: light | dark | auto
  var mql = window.matchMedia("(prefers-color-scheme: dark)");

  function stored() { return localStorage.getItem(KEY) || "auto"; }

  function resolve(mode) {
    if (mode === "auto") return mql.matches ? "dark" : "light";
    return mode;
  }

  function apply(mode) {
    document.documentElement.setAttribute("data-theme", resolve(mode));
    document.documentElement.setAttribute("data-theme-mode", mode);
  }

  // Apply ASAP to avoid flash (also called inline in <head>).
  apply(stored());

  mql.addEventListener("change", function () {
    if (stored() === "auto") apply("auto");
  });

  window.DSATheme = {
    set: function (mode) {
      localStorage.setItem(KEY, mode);
      apply(mode);
      renderSwitch();
    },
    get: stored,
    cycle: function () {
      var order = ["light", "dark", "auto"];
      var next = order[(order.indexOf(stored()) + 1) % 3];
      this.set(next);
    }
  };

  function renderSwitch() {
    var el = document.getElementById("theme-switch");
    if (!el) return;
    var mode = stored();
    var opts = [
      { m: "light", icon: "☀", title: "Light" },
      { m: "dark", icon: "☾", title: "Dark" },
      { m: "auto", icon: "◐", title: "Auto" }
    ];
    el.innerHTML = opts.map(function (o) {
      return '<button class="' + (mode === o.m ? "active" : "") +
        '" title="' + o.title + '" data-mode="' + o.m + '">' + o.icon + "</button>";
    }).join("");
    el.querySelectorAll("button").forEach(function (b) {
      b.addEventListener("click", function () { window.DSATheme.set(b.dataset.mode); });
    });
  }

  document.addEventListener("DOMContentLoaded", renderSwitch);
})();
