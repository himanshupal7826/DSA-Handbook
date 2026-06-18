#!/usr/bin/env python3
"""Build assets/js/content.js — the offline content registry.

Embeds every markdown/*.md (keyed by slug) plus roadmap/*.md and
resources/*.md (keyed by their relative path) so pattern.html and view.html
render under file:// without fetch(). Run from the project root."""
import json, os, glob

reg = {}

# Pattern files keyed by slug.
for f in sorted(glob.glob("markdown/*.md")):
    slug = os.path.basename(f)[:-3]
    with open(f, encoding="utf-8") as fh:
        reg[slug] = fh.read()

# Roadmap + resource docs keyed by relative path (for view.html).
for folder in ("roadmap", "resources"):
    for f in sorted(glob.glob(folder + "/*.md")):
        key = f.replace(os.sep, "/")
        with open(f, encoding="utf-8") as fh:
            reg[key] = fh.read()

out = ("/* AUTO-GENERATED offline content registry. Built from markdown/, roadmap/, resources/.\n"
       "   Lets pattern.html and view.html render under file:// without fetch().\n"
       "   Rebuild via: python3 tools/build_content.py */\n"
       "window.DSA_CONTENT = " + json.dumps(reg, ensure_ascii=False) + ";\n")

with open("assets/js/content.js", "w", encoding="utf-8") as fh:
    fh.write(out)

print("content.js bytes:", os.path.getsize("assets/js/content.js"))
print("entries embedded:", len(reg))
