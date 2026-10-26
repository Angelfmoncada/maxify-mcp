# Maxify brand

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="logo-wordmark-dark.svg">
  <img alt="Maxify" src="logo-wordmark-light.svg" height="56">
</picture>

## Concept

Maxify compiles context. The mark is a context window: slate lines are indexed source, the
bracket is the token budget, and a slot in the bracket lets exactly one line through,
highlighted in Signal. The lines that do not pass stay where they are, dimmed but intact,
because nothing is cut silently.

The banners and the social preview extend the mark into a supergraphic: the silhouette of real
TypeScript (one bar per run of characters), dim outside the window, brighter where the bracket
holds it, and one exact line running off the edge.

## Files

| File | Use |
| --- | --- |
| `logo-mark.svg` | The mark on its Ink tile. 32-unit grid; use from 32 px up. |
| `favicon.svg` | The mark hinted to a 16 px pixel grid. Use from 16 to 31 px. |
| `logo-wordmark-light.svg` | Mark + wordmark for light backgrounds. |
| `logo-wordmark-dark.svg` | Mark + wordmark for dark backgrounds (adds a hairline rim to the tile). |
| `banner-light.svg`, `banner-dark.svg` | README header, 1280 x 320. |
| `social-preview.svg` | Source for `social-preview.png`, 1280 x 640. |
| `social-preview.png` | GitHub social preview (Settings > General > Social preview). |

All SVGs are viewBox-based, have no embedded rasters, links, or web fonts. The wordmark letters
are constructed outlines, so they render the same everywhere.

## Color

| Token | Hex | Role |
| --- | --- | --- |
| Ink | `#0F1A2A` | Mark tile, wordmark on light, dark surfaces |
| Signal | `#FFB938` | The exact line. The only accent; one per composition |
| Paper | `#F4F6F9` | Light surface, bracket, wordmark on dark |
| Slate 600 | `#4A5970` | Secondary text on light |
| Slate 500 | `#56677F` | Context lines inside the tile (graphic only) |
| Slate 300 | `#9DABBE` | Secondary text on dark |

Supergraphic tints (not for text): light `#E4E9EF` outside the window, `#C3CDD9` inside;
dark `#172436` outside, `#3A4C66` inside.

Contrast (WCAG 2.x):

| Pair | Ratio | Use |
| --- | --- | --- |
| Ink on Paper, Paper on Ink | 16.1:1 | Wordmark |
| Slate 600 on Paper | 6.6:1 (7.1:1 on white) | Tagline, light banner: passes AA |
| Slate 300 on Ink | 7.5:1 | Tagline, dark banner: passes AA |
| Signal on Ink | 10.2:1 | Exact line on the tile and dark surfaces |
| Signal on Paper | 1.6:1 | Graphic only. Never use Signal for text on light |

## Typography

- Wordmark: custom geometric letters on a 140-unit cap height, 104-unit x-height, 20-unit stems,
  flat terminals, and rounded-rectangle bowls. Use the outlines; do not retype it in a font.
- Secondary text (tagline, captions): the platform monospace stack,
  `ui-monospace, 'SF Mono', 'Cascadia Mono', 'Cascadia Code', 'JetBrains Mono', Menlo, Consolas,
  'Liberation Mono', 'DejaVu Sans Mono', monospace`. The banner tagline is live text with
  `textLength` set, so its width stays fixed whichever face renders it.

## Clear space and minimum size

- Keep clear space equal to 25% of the tile height on every side (8 units on the 32-unit grid).
  For the lockup, measure from the tile, not the letters.
- `favicon.svg`: 16 px minimum. `logo-mark.svg`: 32 px minimum; it is pixel-crisp at
  multiples of 32.
- Lockup: 24 px tall minimum on screen. Below that, use the mark alone.

## Do

- Keep the tile Ink on every background. The tile is what lets the mark work anywhere.
- Use the `-light` lockup on light backgrounds and the `-dark` lockup on dark ones.
- Scale proportionally and keep the grid intact.
- Keep Signal for the exact line.

## Don't

- Recolor the tile or the exact line, or add gradients, glows, shadows, or outlines.
- Re-space the wordmark or set it in a font.
- Close the bracket's slot, stop the exact line at the bracket, or add a second highlighted line.
- Rotate, skew, or crop the tile, or use the mark's lines without the tile.
- Animate the exact line as a progress or loading bar.

## README header

```html
<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/brand/banner-dark.svg">
    <source media="(prefers-color-scheme: light)" srcset="assets/brand/banner-light.svg">
    <img alt="Maxify. Exact context. Fewer tokens." src="assets/brand/banner-light.svg" width="100%">
  </picture>
</p>
```

Favicon for a docs site:

```html
<link rel="icon" type="image/svg+xml" href="/favicon.svg">
```

## Regenerating social-preview.png

Render the SVG at 1280 x 640 with a headless Chromium browser (Chrome or Edge), from this folder:

```sh
chrome --headless=new --hide-scrollbars --force-device-scale-factor=1 \
  --window-size=1280,640 --screenshot="$PWD/social-preview.png" "file://$PWD/social-preview.svg"
```

On Windows, call `chrome.exe` or `msedge.exe` by full path and pass a `file:///C:/...` URL.
The tagline uses the renderer's monospace font; the included PNG was rendered on Windows with
Cascadia Mono.
