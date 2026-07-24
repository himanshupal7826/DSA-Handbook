# 🌐 zariya.in — Engineering Handbooks

This folder is the **zariya.in** portal: a set of comprehensive, interview-focused engineering handbooks sharing one offline, dark-mode documentation engine.

**Open `index.html`** — the portal landing page — and pick a handbook:

| Handbook | Topics | Path |
|----------|--------|------|
| 🧠 DSA Patterns | 100 | `dsa.html` |
| 🎸 Django | 10 | `django/` |
| 🐹 Go | 129 | `go/` |
| 🏛️ System Design | 40 | `system-design/` |
| 🐳 Docker | 30 | `docker/` |
| ☸️ Kubernetes | 30 | `kubernetes/` |
| 🐼 NumPy & Pandas | 31 | `numpy-pandas/` |
| 🗄️ SQL | 36 | `sql/` |
| 🤖 AI Engineering | 46 | `ai-engineering/` |
| 💠 Apache Cassandra | 46 | `cassandra/` |
| 🔌 REST API | 46 | `rest-api/` |
| 🔗 gRPC with Go | 30 | `grpc-golang/` |

Each new handbook has its own `index.html` (home), `topic.html` (renderer), `data.js` (manifest), `content.js` (offline content), and `markdown/`. They share the engine in `assets/js/hb-*.js` + `markdown.js`/`theme.js` and `assets/css/style.css`. Regenerate them with `python3 tools/build_handbooks.py` (handbook specs live in `tools/src/*_hb.py`).

---

# 📘 DSA Patterns Handbook (the flagship)

The most comprehensive **pattern-first** DSA knowledge base for Software / Senior / Staff / FAANG interviews and competitive programming. **100 patterns**, each with 15 exhaustive sections, rendered as a fast, offline, dark-mode documentation site. Its home is **`dsa.html`**.

> **Stop memorizing problems. Learn the patterns behind them.**

---

## 🚀 Quick Start

### Option A — open directly (offline)
Open **`index.html`** (the zariya.in portal) in any modern browser; click into any handbook. All content is embedded in each handbook's `content.js`, so everything works under `file://` with no server.

### Option B — local server (recommended for editing)
```bash
cd DSA-Patterns-Handbook
python3 -m http.server 8000
# then visit http://localhost:8000
```
Served over HTTP, pattern pages fetch the raw `markdown/*.md` files live — handy while authoring.

---

## 🗂️ Project Structure

```
DSA-Patterns-Handbook/
├── index.html              # Homepage: search, categories, dashboard, roadmaps
├── pattern.html            # Single template that renders any pattern (?p=<slug>)
├── pattern-selector.html   # Interactive decision tree → recommended pattern
├── view.html               # Styled viewer for roadmap & resource markdown
├── README.md
├── assets/
│   ├── css/style.css       # Theming (light/dark/auto) via CSS variables
│   └── js/
│       ├── patterns-data.js  # ★ Single source of truth: all 100 patterns
│       ├── markdown.js       # Self-contained MD renderer + highlight + tabs + copy
│       ├── app.js            # Shared chrome: top bar, sidebar, nav, content loader
│       ├── search.js         # Search by name / LeetCode # / keyword / concept
│       ├── progress.js       # LocalStorage: completed / bookmarked / revision
│       ├── theme.js          # Light / Dark / Auto theme manager
│       ├── content.js        # AUTO-GENERATED offline content registry
│       └── content/          # (reserved for per-pattern splits if desired)
├── markdown/               # 100 pattern files (01-…md … 100-…md) — the SOURCE
├── roadmap/                # 10 roadmap & study-plan files
├── resources/              # Cheat sheets & references
└── patterns/               # (architecture note — see patterns/README.md)
```

---

## 🧩 Architecture: One Template + Markdown

Instead of 100 hand-built HTML files, a **single `pattern.html`** renders any pattern from its Markdown:

1. `patterns-data.js` is the **manifest** — it drives the sidebar, search index, homepage cards, prev/next navigation, and the selector. Add/edit a pattern here once.
2. Content lives in **`markdown/<slug>.md`** (one file per pattern, plus a `.md` per the spec).
3. `markdown.js` renders MD → styled HTML with **language tabs** (consecutive Go/Python/Java/C++ blocks auto-group), **syntax highlighting**, **copy buttons**, tables, callouts, and an auto **table of contents**.
4. `content.js` embeds every `.md` as a string so the site works **offline** (`file://`), where browsers block `fetch()`.

### Editing content
1. Edit the relevant `markdown/<slug>.md`.
2. Rebuild the offline registry:
   ```bash
   python3 tools/build_content.py
   ```
3. Refresh the browser.

### Adding a new pattern
1. Append an entry to `window.DSA_PATTERNS` in `assets/js/patterns-data.js`.
2. Create `markdown/<slug>.md`.
3. Run `python3 tools/build_content.py`.

---

## ✨ Features

- **100 patterns** across 15 categories (Foundations → Expert).
- **15 sections each:** Overview · Recognition Signals · Brute Force · Optimal · Templates (Go/Python/Java/C++) · Complexity · Common Mistakes · Follow-Ups · 3 Solved Examples · LeetCode Set · Variations · Production Applications · Revision Notes.
- 🔎 **Instant search** by pattern name, LeetCode number/name, keyword, or concept (press `/`).
- 🧭 **Pattern Selector** — answer a few questions, get the right pattern + related ones + practice problems.
- 📊 **Progress dashboard** — completed / bookmarked / mastered, persisted in LocalStorage.
- 🌗 **Light / Dark / Auto** theme, persisted.
- 🧱 **Language tabs**, syntax highlighting, and one-click **copy** on every code block.
- 🗺️ **10 roadmaps**: beginner/intermediate/advanced paths, FAANG guide, Top-150 & Top-75, and 30/60/90-day plans.
- 📴 **Fully offline** — no CDNs, no build step required to read.

---

## 🎯 Who it's for
SWE / Senior / Staff / FAANG interview candidates and competitive programmers who want **systematic pattern mastery** — the ability to recognize and solve *unseen* problems.

Start at **[Pattern 01 · Frequency Counter](pattern.html?p=01-frequency-counter)** or the **[Master Roadmap](roadmap/000-ROADMAP.md)**.

---

## 🛠️ Maintenance scripts
- `tools/build_content.py` — rebuild `assets/js/content.js` from `markdown/*.md`.
- `tools/gen_patterns.py` — regenerate family-templated pattern scaffolds from the manifest.

*Hand-authored patterns are protected from regeneration via the `PROTECT` set in `gen_patterns.py`.*
