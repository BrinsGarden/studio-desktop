# Studio Desktop

A lightweight, Photoshop-style poster editor that runs in the browser. Built for compositing real photo cutouts onto backdrops without AI touching faces or hands.

**Open it:** https://brinsgarden.github.io/studio-desktop/ (after GitHub Pages is turned on — see below)

## What it does

- **Layers** — image, text, gradient/fill, and color-adjustment layers; drag to reorder, show/hide, rename, duplicate
- **Blend modes & opacity** — Normal, Multiply, Screen, Overlay, Soft Light, Color, Luminosity and more
- **Selections** — Lasso, Polygon, Ellipse and Rectangle with feather, Shift to add, Alt to subtract, invert. Copy or cut the selection to a new layer (Ctrl+J / Ctrl+Shift+J), delete pixels, or turn it into a mask. Painting stays inside the selection.
- **Magic swirl** — draw a path and get glowing, multi-strand colorful ribbons with sparkles; presets (Witchy, Rainbow, Fire, Toxic, Ice, Blood moon), editable strands, twists, spread, thickness, glow, depth and taper
- **Fog** — wispy ground fog layer with thickness, height, wispiness and color; only covers the bottom, so it can sit between any layers
- **Masks** — paint black to hide, white to reveal (press `X` to swap); invert, toggle, view as black & white (`\`)
- **Color tools** (non-destructive, per layer)
  - **Match color** — pulls a cutout's colors toward the backdrop; the fastest way to blend people into a scene
  - Brightness/Contrast, Levels, Curves (RGB + per channel), Hue/Saturation/Lightness, Color Balance (shadows/mids/highlights), Tint
  - Adjustment layers recolor everything below them
- **Effects** — rim light (glowing edge facing the light), outer glow, outline, color overlay, drop shadow, blur
- **Edge cleanup** — shrink and soften cutout edges to kill halos
- **Text** — spooky Google Fonts (Creepster, Nosifer, Butcherman…), gradient fill, outline
- **Print export** — full-resolution PNG/JPG with DPI embedded; poster presets (18×24, 24×36, 11×17…)
- **Projects** — save/open `.sdproj` files to keep editing later
- Undo/redo for everything

## Shortcuts

| Key | Action |
| --- | --- |
| V / L / B / E / S / I / H | Move, Select, Brush, Eraser, Swirl, Eyedropper, Hand |
| Ctrl+D / Ctrl+A / Ctrl+Shift+I | Deselect / Select all / Invert |
| Ctrl+Shift+J | Cut selection to new layer |
| Del (with selection) | Delete selected pixels |
| Enter / Esc | Finish / cancel polygon selection |
| Space (hold) | Pan |
| Scroll | Zoom · Shift+scroll pans |
| [ / ] | Brush size |
| X | Swap mask hide/reveal |
| \ | Show mask |
| Ctrl+Z / Ctrl+Y | Undo / Redo |
| Ctrl+J | Copy selection to new layer (or duplicate layer) |
| Ctrl+S | Save project |
| Ctrl+Shift+E | Export PNG |
| Ctrl+0 / Ctrl+1 | Fit / 100% |
| Arrows (Shift = 10px) | Nudge layer |

## Workflow for photo posters

1. **File › New** → Poster 18×24 @ 150 DPI.
2. Drop in the backdrop, click **Fill** in the Layer tab.
3. Drop in each cutout PNG. On each: **Color › Match to** the backdrop (~60–80%), lower Brightness a bit.
4. **Effects › Rim light** with the moon color and angle; **Layer › Edges** shrink 1–2px if there's a halo.
5. Add a **Gradient** layer for darkness behind or a vignette, a **Color Adjust** layer on top for a final grade.
6. **Export PNG** and print that file.

## Development

```bash
npm install
npm run dev      # http://localhost:5173
npx vitest run   # unit tests
npm run build    # static site in dist/
```

Stack: Vite + React + TypeScript, Canvas 2D rendering engine in `src/engine/` (no backend).
The editor previews at reduced resolution for speed (View › High-quality preview raises it); export always renders at full resolution.

## Hosting on GitHub Pages

Repo **Settings › Pages › Source: GitHub Actions**. Every push to `main` builds and deploys via `.github/workflows/deploy.yml`.
