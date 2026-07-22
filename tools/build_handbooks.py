#!/usr/bin/env python3
"""build_handbooks.py — generate all handbook subfolders + the zariya.in portal.
Run from the project root: python3 tools/build_handbooks.py"""
import os, sys, json

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # project root
sys.path.insert(0, os.path.join(ROOT, "tools"))
sys.path.insert(0, os.path.join(ROOT, "tools", "src"))
import hb_lib

import (sql_hb, go_hb, django_hb, docker_hb, k8s_hb, numpy_pandas_hb, system_design_hb,
        ai_engineering_hb, cassandra_hb, rest_api_hb)
SPECS = [django_hb.SPEC, go_hb.SPEC, system_design_hb.SPEC, docker_hb.SPEC,
         k8s_hb.SPEC, numpy_pandas_hb.SPEC, sql_hb.SPEC, ai_engineering_hb.SPEC,
         cassandra_hb.SPEC, rest_api_hb.SPEC]

cards = []
# DSA handbook is self-contained at the root with its own engine — link to dsa.html
cards.append({"id": "dsa", "name": "DSA Patterns Handbook", "icon": "🧠",
              "tagline": "100 algorithm & data-structure patterns for FAANG interviews and competitive programming.",
              "count": 100, "categories": 15, "href": "dsa.html",
              "tags": ["algorithms", "data structures", "leetcode", "interview"]})

for spec in SPECS:
    summary = hb_lib.build(spec, ROOT)
    summary["href"] = spec["id"] + "/index.html"
    summary["tags"] = sorted({kw for it in spec["items"] for kw in it.get("keywords", [])})[:8]
    cards.append(summary)
    print("built:", spec["id"], "(%d topics)" % summary["count"])

# ----- Portal index.html -----
THEME = ('<script>(function(){var m=localStorage.getItem("dsa-theme")||"auto";'
         'var d=m==="auto"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):m;'
         'document.documentElement.setAttribute("data-theme",d);})();</script>')

cards_json = json.dumps(cards, ensure_ascii=False)
total_topics = sum(c["count"] for c in cards)

portal = """<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>zariya.in — Engineering Handbooks</title>
<meta name="description" content="zariya.in — comprehensive, interview-focused engineering handbooks: DSA Patterns, Django, Go, System Design, Docker, Kubernetes, NumPy/Pandas, and SQL.">
<link rel="stylesheet" href="assets/css/style.css">
<link rel="icon" type="image/png" href="assets/images/03_favicon.png">
<link rel="apple-touch-icon" href="assets/images/02_app_icon.png">
__THEME__
<style>
  .portal-hero{background:linear-gradient(135deg,var(--accent-soft),transparent);border:1px solid var(--border-soft);border-radius:20px;padding:44px 36px;margin:24px auto;max-width:1100px;text-align:center}
  .portal-hero .hero-logo{display:inline-block;background:#fff;border-radius:18px;padding:18px 26px;box-shadow:var(--shadow-lg);margin-bottom:18px}
  .portal-hero .hero-logo img{display:block;width:min(380px,72vw);height:auto}
  .portal-hero p{color:var(--text-soft);font-size:17px;max-width:680px;margin:0 auto}
  .portal-top .brand-logo{height:30px;width:auto;background:#fff;border-radius:7px;padding:3px 7px;box-shadow:var(--shadow);display:block}
  .portal-wrap{max-width:1100px;margin:0 auto;padding:0 24px 80px}
  .portal-search{max-width:560px;margin:22px auto 0;position:relative}
  .portal-search input{width:100%;padding:13px 18px 13px 44px;border:1px solid var(--border);border-radius:999px;background:var(--bg-alt);color:var(--text);font-size:15px;outline:none}
  .portal-search input:focus{border-color:var(--accent);box-shadow:0 0 0 3px var(--accent-soft)}
  .portal-search .si{position:absolute;left:16px;top:50%;transform:translateY(-50%);color:var(--text-faint)}
  .hb-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(300px,1fr));gap:18px;margin-top:26px}
  .hb-card{background:var(--bg-elev);border:1px solid var(--border);border-radius:16px;padding:24px;display:block;color:var(--text);transition:transform .12s,box-shadow .12s,border-color .12s;position:relative;overflow:hidden}
  .hb-card:hover{transform:translateY(-3px);box-shadow:var(--shadow-lg);border-color:var(--accent);text-decoration:none}
  .hb-card .hb-icon{font-size:34px}
  .hb-card h3{margin:12px 0 6px;font-size:19px}
  .hb-card p{margin:0;color:var(--text-soft);font-size:13.5px;line-height:1.5}
  .hb-card .hb-meta{margin-top:14px;font-size:12px;color:var(--accent);font-weight:700}
  .hb-card .hb-tags{margin-top:10px;display:flex;flex-wrap:wrap;gap:5px}
  .portal-top{display:flex;align-items:center;justify-content:space-between;max-width:1100px;margin:0 auto;padding:16px 24px}
  .portal-foot{text-align:center;color:var(--text-faint);font-size:13px;padding:30px 0}
</style>
</head>
<body>
<div class="portal-top">
  <a href="index.html" style="display:flex;align-items:center"><img class="brand-logo" src="assets/images/01_horizontal_logo.png" alt="Zariya"></a>
  <div class="theme-switch" id="theme-switch"></div>
</div>

<div class="portal-hero">
  <div class="hero-logo"><img src="assets/images/01_horizontal_logo.png" alt="Zariya — The Pathway to Engineering Mastery"></div>
  <p>Comprehensive, interview-focused engineering handbooks. __TOTAL__+ deep-dive topics across __NHB__ subjects — patterns, recognition signals, production-grade code, and practice. Pick a handbook to begin.</p>
  <div class="portal-search">
    <span class="si">🔍</span>
    <input id="hb-search" type="text" placeholder="Search handbooks (e.g. docker, sql, dijkstra, caching)…" autocomplete="off">
  </div>
</div>

<div class="portal-wrap">
  <div class="hb-grid" id="hb-grid"></div>
  <div class="portal-foot">zariya.in · built for engineers preparing for Software / Senior / Staff / FAANG interviews · open <code>index.html</code> to start</div>
</div>

<script src="assets/js/theme.js"></script>
<script>
var CARDS = __CARDS__;
function render(filter){
  filter = (filter||"").toLowerCase();
  var grid = document.getElementById("hb-grid");
  var list = CARDS.filter(function(c){
    if(!filter) return true;
    return (c.name+" "+c.tagline+" "+(c.tags||[]).join(" ")).toLowerCase().indexOf(filter)!==-1;
  });
  if(!list.length){ grid.innerHTML = '<p class="muted">No handbook matches “'+filter+'”.</p>'; return; }
  grid.innerHTML = list.map(function(c){
    return '<a class="hb-card" href="'+c.href+'">'+
      '<div class="hb-icon">'+c.icon+'</div>'+
      '<h3>'+c.name+'</h3>'+
      '<p>'+c.tagline+'</p>'+
      '<div class="hb-meta">'+c.count+' topics · '+c.categories+' categories</div>'+
      '<div class="hb-tags">'+(c.tags||[]).slice(0,5).map(function(t){return '<span class="tag">'+t+'</span>';}).join("")+'</div>'+
      '</a>';
  }).join("");
}
render("");
document.getElementById("hb-search").addEventListener("input", function(e){ render(e.target.value); });
</script>
</body>
</html>
"""
portal = (portal.replace("__THEME__", THEME).replace("__CARDS__", cards_json)
          .replace("__TOTAL__", str(total_topics)).replace("__NHB__", str(len(cards))))
with open(os.path.join(ROOT, "index.html"), "w", encoding="utf-8") as f:
    f.write(portal)

print("\nportal written: index.html")
print("total handbooks:", len(cards), "| total topics:", total_topics)
