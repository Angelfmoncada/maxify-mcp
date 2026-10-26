# Brand asset generator

Regenerates every SVG in `assets/brand/` from the color tokens and hand-built glyph outlines.
Pure Python 3.10+ standard library.

```bash
python scripts/brand/build.py assets/brand
```

`shot.py` renders `social-preview.png` from `social-preview.svg` with headless Chrome
(edit the `CHROME` path at the top of the file for your machine).
