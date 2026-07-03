#!/usr/bin/env python3
"""hb_lib.py — build a handbook subfolder (index.html, topic.html, view.html,
data.js, content.js, markdown/*.md) from a SPEC dict. Generic engine shared
from ../assets. Run via build_handbooks.py at the project root."""
import json, os

THEME_INLINE = ('<script>(function(){var m=localStorage.getItem("dsa-theme")||"auto";'
                'var d=m==="auto"?(window.matchMedia("(prefers-color-scheme: dark)").matches?"dark":"light"):m;'
                'document.documentElement.setAttribute("data-theme",d);})();</script>')

ENGINE_SCRIPTS = ("\n".join([
    '<script src="../assets/js/theme.js"></script>',
    '<script src="data.js"></script>',
    '<script src="../assets/js/hb-progress.js"></script>',
    '<script src="../assets/js/hb-search.js"></script>',
    '<script src="../assets/js/markdown.js"></script>',
    '<script src="../assets/js/hb-listen.js"></script>',
    '<script src="content.js" onerror="window.HANDBOOK_CONTENT=window.HANDBOOK_CONTENT||{}"></script>',
    '<script src="../assets/js/hb-engine.js"></script>',
]))

def diff_badge(level):
    return level

def md_code_blocks(code):
    """code = list of (lang, src). Consecutive blocks auto-tab in the renderer."""
    return "\n\n".join("```%s\n%s\n```" % (lang, src.strip("\n")) for lang, src in code)

def build_markdown(it):
    num = "%02d" % it["id"]
    L = []
    L.append("# %s · %s\n" % (num, it["name"]))
    L.append("> **In one line:** %s\n" % it["summary"])
    L.append("---\n")

    L.append("## 1. Overview\n")
    L.append(it["overview"].strip() + "\n")

    if it.get("concepts"):
        L.append("## 2. Key Concepts\n")
        for c in it["concepts"]:
            L.append("- %s" % c)
        L.append("")

    if it.get("code"):
        L.append("## 3. Syntax & Code\n")
        if it.get("code_intro"):
            L.append(it["code_intro"].strip() + "\n")
        L.append(md_code_blocks(it["code"]) + "\n")

    if it.get("example"):
        ex = it["example"]
        L.append("## 4. Worked Example\n")
        if ex.get("title"):
            L.append("**%s**\n" % ex["title"])
        if ex.get("text"):
            L.append(ex["text"].strip() + "\n")
        if ex.get("code"):
            L.append(md_code_blocks(ex["code"]) + "\n")

    if it.get("best"):
        L.append("## 5. Best Practices\n")
        for b in it["best"]:
            L.append("- ✅ %s" % b)
        L.append("")

    if it.get("pitfalls"):
        L.append("## 6. Common Pitfalls\n")
        for i, p in enumerate(it["pitfalls"], 1):
            L.append("%d. ⚠️ %s" % (i, p))
        L.append("")

    if it.get("interview"):
        L.append("## 7. Interview Questions\n")
        for i, (q, a) in enumerate(it["interview"], 1):
            L.append("%d. **Q: %s**\n   A: %s\n" % (i, q, a))

    if it.get("practice"):
        L.append("## 8. Practice\n")
        for p in it["practice"]:
            L.append("- [ ] %s" % p)
        L.append("")

    L.append("## 9. Quick Revision\n")
    L.append(it.get("revision", it["summary"]).strip() + "\n")
    if it.get("refs"):
        L.append("**References:** " + " · ".join(it["refs"]) + "\n")

    L.append("---\n")
    L.append("*%s — topic %s.*\n" % (it["_hbname"], num))
    return "\n".join(L)


INDEX_TMPL = """<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>__NAME__ — zariya.in</title>
<link rel="stylesheet" href="../assets/css/style.css">
<link rel="icon" type="image/png" href="../assets/images/03_favicon.png">
__THEME__
</head>
<body>
<header class="topbar" id="topbar"></header>
<div class="scrim" id="scrim"></div>
<div class="layout">
<nav class="sidebar" id="sidebar"></nav>
<main class="main">
  <section class="hero">
    <h1>__ICON__ __NAME__</h1>
    <p>__TAGLINE__</p>
    <div class="stats">
      <div class="stat"><div class="n" id="s-total">__COUNT__</div><div class="l">Topics</div></div>
      <div class="stat"><div class="n" id="s-done">0</div><div class="l">Completed</div></div>
      <div class="stat"><div class="n" id="s-cat">__CATS__</div><div class="l">Categories</div></div>
    </div>
    <div style="margin-top:20px;display:flex;gap:10px;flex-wrap:wrap">
      <a class="btn primary" id="start-btn" href="#">▶ Start learning</a>
      __EXTRANAV__
      <a class="btn" href="../index.html">⌂ All handbooks</a>
    </div>
  </section>
  <h2 class="section-title" id="dashboard"><span class="bar"></span>Your Progress</h2>
  <div class="progress-bar"><span id="pbar" style="width:0%"></span></div>
  <div class="muted" id="pmsg" style="font-size:13px;margin:6px 0 10px"></div>
  <h2 class="section-title"><span class="bar"></span>Topics by Category</h2>
  <div id="cat-sections"></div>
</main>
</div>
__ENGINE__
<script>
DSAApp.initChrome(null);
(function(){
  var items = HANDBOOK.items;
  document.getElementById("start-btn").href = "topic.html?p=" + items[0].slug;
  // group by category preserving order
  var cats = [];
  items.forEach(function(p){ if(cats.indexOf(p.category)===-1) cats.push(p.category); });
  var html = "";
  cats.forEach(function(cat){
    var inCat = items.filter(function(p){return p.category===cat;});
    html += '<h3 style="margin:22px 0 10px">'+cat+'</h3><div class="card-grid">';
    inCat.forEach(function(p){
      html += '<a class="card" href="topic.html?p='+p.slug+'">'+
        '<span class="badge lvl-'+p.level+'">'+p.level+'</span>'+
        '<h3>'+String(p.id).padStart(2,"0")+'. '+p.name+'</h3>'+
        '<p>'+p.summary+'</p></a>';
    });
    html += '</div>';
  });
  document.getElementById("cat-sections").innerHTML = html;
  function refresh(){
    var s = DSAProgress.stats();
    document.getElementById("s-done").textContent = s.completed;
    document.getElementById("pbar").style.width = s.pct+"%";
    document.getElementById("pmsg").textContent = s.completed+" of "+s.total+" topics complete ("+s.pct+"%)";
  }
  refresh(); DSAProgress.onChange(refresh);
})();
</script>
</body>
</html>
"""

TOPIC_TMPL = """<!DOCTYPE html>
<html lang="en" data-theme="light">
<head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Topic — __NAME__</title>
<link rel="stylesheet" href="../assets/css/style.css">
<link rel="icon" type="image/png" href="../assets/images/03_favicon.png">
__THEME__
</head>
<body>
<header class="topbar" id="topbar"></header>
<div class="scrim" id="scrim"></div>
<div class="layout">
<nav class="sidebar" id="sidebar"></nav>
<main class="main">
  <div class="breadcrumb" id="breadcrumb"></div>
  <div class="pattern-head">
    <div><span class="badge" id="level-badge"></span> <span class="tag" id="cat-tag"></span></div>
    <div class="page-actions" id="page-actions"></div>
  </div>
  <div class="content md" id="content"><div class="spinner"></div></div>
  <div class="pager" id="pager"></div>
</main>
</div>
__ENGINE__
<script>
var slug = DSAApp.qparam("p") || HANDBOOK.items[0].slug;
var topic = DSAApp.bySlug(slug);
DSAApp.initChrome(slug);
if(!topic){
  document.getElementById("content").innerHTML = '<h1>Topic not found</h1><p><a href="index.html">Back</a></p>';
} else {
  document.title = DSAApp.pad(topic.id)+" "+topic.name+" — "+HANDBOOK.name;
  document.getElementById("breadcrumb").innerHTML = '<a href="../index.html">zariya.in</a> › <a href="index.html">'+HANDBOOK.name+'</a> › '+topic.category;
  var lb=document.getElementById("level-badge"); lb.textContent=topic.level; lb.className="badge lvl-"+topic.level;
  document.getElementById("cat-tag").textContent=topic.category;
  (function(){
    var el=document.getElementById("page-actions");
    var vq=encodeURIComponent(topic.name+" "+(HANDBOOK.videoTag||HANDBOOK.name)+" tutorial");
    var vurl="https://www.youtube.com/results?search_query="+vq;
    function r(){
      var d=DSAProgress.isComplete(slug), m=DSAProgress.isBookmarked(slug), rv=DSAProgress.getRevision(slug);
      var rl={"new":"🔲 New",learning:"📖 Learning",mastered:"✅ Mastered"}[rv];
      el.innerHTML='<button class="btn '+(d?"done":"")+'" id="bd">'+(d?"✓ Completed":"Mark Complete")+'</button>'+
        '<button class="btn" id="bm">'+(m?"★ Bookmarked":"☆ Bookmark")+'</button>'+
        '<button class="btn" id="br">'+rl+'</button>'+
        '<a class="btn watch" href="'+vurl+'" target="_blank" rel="noopener" title="Free videos for this topic on YouTube">📺 Watch</a>';
      document.getElementById("bd").onclick=function(){DSAProgress.toggleComplete(slug);r();};
      document.getElementById("bm").onclick=function(){DSAProgress.toggleBookmark(slug);r();};
      document.getElementById("br").onclick=function(){DSAProgress.cycleRevision(slug);r();};
    } r();
  })();
  DSAApp.loadContent(slug).then(function(md){
    var c=document.getElementById("content"); c.innerHTML=DSAMarkdown.render(md);
    var toc=DSAMarkdown.buildTOC(c); if(toc){var h1=c.querySelector("h1"); if(h1) h1.insertAdjacentHTML("afterend",toc);}
    var _h1=c.querySelector("h1"); if(_h1){var _vq=encodeURIComponent(topic.name+" "+(HANDBOOK.videoTag||HANDBOOK.name)+" tutorial");
      _h1.insertAdjacentHTML("afterend",'<a class="video-cta" href="https://www.youtube.com/results?search_query='+_vq+'" target="_blank" rel="noopener">🎥 Learn this chapter from free videos on YouTube →</a>');}
    DSAMarkdown.wire(c);
    if(window.DSAListen) DSAListen.attach(c);
    if(location.hash){var t=document.getElementById(location.hash.slice(1)); if(t) setTimeout(function(){t.scrollIntoView();},60);}
  }).catch(function(){
    document.getElementById("content").innerHTML='<h1>'+DSAApp.pad(topic.id)+". "+topic.name+'</h1>'+
      '<div class="callout warn"><strong>Content not loaded.</strong> Open via a local server or ensure content.js is built.</div>'+
      '<p>'+topic.summary+'</p>';
  });
  (function(){
    var nb=DSAApp.neighbors(slug), el=document.getElementById("pager");
    var prev=nb.prev?'<a class="prev" href="topic.html?p='+nb.prev.slug+'"><div class="dir">← Previous</div><div class="ttl">'+DSAApp.pad(nb.prev.id)+". "+nb.prev.name+'</div></a>':'<span></span>';
    var next=nb.next?'<a class="next" href="topic.html?p='+nb.next.slug+'"><div class="dir">Next →</div><div class="ttl">'+DSAApp.pad(nb.next.id)+". "+nb.next.name+'</div></a>':'<span></span>';
    el.innerHTML=prev+'<a href="index.html" style="flex:0 0 auto;text-align:center"><div class="dir">&nbsp;</div><div class="ttl">🏠 Home</div></a>'+next;
  })();
}
</script>
</body>
</html>
"""

def build(spec, root):
    hb_dir = os.path.join(root, spec["id"])
    md_dir = os.path.join(hb_dir, "markdown")
    os.makedirs(md_dir, exist_ok=True)

    # tag items with handbook name (for footer) and write markdown + collect content.
    # When spec["preserve_markdown"] is set, an existing hand/agent-authored
    # markdown/<slug>.md is used verbatim (rich multi-section content) instead of
    # being regenerated from the compact SPEC template; build_markdown() is only
    # used as a fallback stub when no file exists yet.
    preserve = spec.get("preserve_markdown", False)
    content = {}
    for it in spec["items"]:
        it["_hbname"] = spec["name"]
        md_path = os.path.join(md_dir, it["slug"] + ".md")
        if preserve and os.path.exists(md_path):
            with open(md_path, encoding="utf-8") as f:
                md = f.read()
        else:
            md = build_markdown(it)
            with open(md_path, "w", encoding="utf-8") as f:
                f.write(md)
        content[it["slug"]] = md

    # data.js — meta only (no heavy content)
    meta_items = [{k: it[k] for k in ("id", "slug", "name", "category", "level", "summary", "keywords", "refs")}
                  for it in spec["items"]]
    data = {
        "id": spec["id"], "name": spec["name"], "icon": spec.get("icon", "📘"),
        "tagline": spec.get("tagline", ""), "itemNoun": spec.get("itemNoun", "Topic"),
        "videoTag": spec.get("videoTag", spec["name"].replace(" Handbook", "").strip()),
        "levels": spec["levels"], "categories": spec["categories"], "items": meta_items,
    }
    with open(os.path.join(hb_dir, "data.js"), "w", encoding="utf-8") as f:
        f.write("/* AUTO-GENERATED handbook manifest. */\nwindow.HANDBOOK = " +
                json.dumps(data, ensure_ascii=False) + ";\n")

    # content.js — offline registry
    with open(os.path.join(hb_dir, "content.js"), "w", encoding="utf-8") as f:
        f.write("/* AUTO-GENERATED offline content. */\nwindow.HANDBOOK_CONTENT = " +
                json.dumps(content, ensure_ascii=False) + ";\n")

    cats = len({it["category"] for it in spec["items"]})
    extranav = "\n      ".join(
        '<a class="btn" href="%s">%s</a>' % (n["href"], n["label"]) for n in spec.get("extraNav", []))
    def fill(t):
        return (t.replace("__NAME__", spec["name"]).replace("__ICON__", spec.get("icon", "📘"))
                 .replace("__TAGLINE__", spec.get("tagline", "")).replace("__COUNT__", str(len(spec["items"])))
                 .replace("__CATS__", str(cats)).replace("__THEME__", THEME_INLINE)
                 .replace("__EXTRANAV__", extranav).replace("__ENGINE__", ENGINE_SCRIPTS))
    with open(os.path.join(hb_dir, "index.html"), "w", encoding="utf-8") as f:
        f.write(fill(INDEX_TMPL))
    with open(os.path.join(hb_dir, "topic.html"), "w", encoding="utf-8") as f:
        f.write(fill(TOPIC_TMPL))

    return {"id": spec["id"], "name": spec["name"], "icon": spec.get("icon", "📘"),
            "tagline": spec.get("tagline", ""), "count": len(spec["items"]), "categories": cats,
            "levels": spec["levels"]}
