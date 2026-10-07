#!/usr/bin/env python3
"""Regenerate Trikala's token CSS from design/tokens.json.

Writes:
  - the block between `/* @tokens:start` and `/* @tokens:end */` in public/index.html
  - design/tokens.css (same CSS, for other tools and the design-system docs)

Usage: python3 scripts/sync-tokens.py [--check]
  --check  exit 1 if index.html is out of date (used by tests/CI)
"""
import json, pathlib, re, sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
TOKENS = ROOT / "design" / "tokens.json"
PAGE = ROOT / "public" / "index.html"
CSS_OUT = ROOT / "design" / "tokens.css"
START = "/* @tokens:start — GENERATED from tokens.json by sync-tokens.py. Edit tokens.json, not this block. */"
END = "/* @tokens:end */"


def build():
    data = json.loads(TOKENS.read_text(encoding="utf-8"))
    light, dark = [], []
    for group in data["groups"].values():
        for name, tok in group.items():
            if not re.fullmatch(r"[a-z0-9-]+", name):
                sys.exit(f"bad token name: {name}")
            light.append(f"  --{name}:{tok['light']};")
            if "dark" in tok:
                dark.append(f"--{name}:{tok['dark']};")
    d = "".join(dark)
    return "\n".join([
        START,
        ":root{",
        *light,
        "}",
        '@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){' + d + "}}",
        ':root[data-theme="dark"]{' + d + "}",
        END,
    ])


def main():
    css = build()
    html = PAGE.read_text(encoding="utf-8")
    a = html.index("/* @tokens:start")
    b = html.index(END) + len(END)
    new = html[:a] + css + html[b:]
    if "--check" in sys.argv:
        if new != html:
            sys.exit("tokens out of date: run python3 scripts/sync-tokens.py")
        print("tokens in sync")
        return
    PAGE.write_text(new, encoding="utf-8")
    CSS_OUT.write_text(css + "\n", encoding="utf-8")
    print(f"synced {css.count('--') // 1} declarations")


if __name__ == "__main__":
    main()
