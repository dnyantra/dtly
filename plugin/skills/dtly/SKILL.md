---
name: dtly
description: Make motion graphics and videos with DT.ly — After Effects-style compositions, layers, keyframes, text animators, kinetic typography, openers, slideshows and transitions — through the dtly MCP tools. Use when asked to create or edit a promo, ad, reel, opener, title sequence, lyric/kinetic text video, slideshow or lower third, or to change timing, easing or animation of an existing DT.ly project.
---

# DT.ly motion design

DT.ly is a layer-and-keyframe motion engine, modelled on After Effects. A project is a JSON
file; you edit it only through the `dtly` MCP tools, then look at rendered frames to check it.

## Workflow

1. **Plan the beats first.** Write a shot list with times before touching tools: what is on
   screen, for how long, and what moves. Reading time ≈ 0.4 s per word + 0.5 s, minimum 0.8 s.
2. `project_create` (default 1080x1920, 30 fps). Scenes that are edited as a unit → `comp_add`
   and drop them in as `precomp` layers.
3. Build bottom-up: background (video/image/solid) → graphics → text → audio.
   `layer_add` uses index 0 = top, so add the background with a high `index` or first.
4. Reach for presets (`preset_list`) for anything standard, then refine with
   `keyframe_set` / `keyframe_ease` / `layer_update`.
5. **Always look.** `render_sheet` across the key moments (entrances mid-way, holds, exits),
   fix, look again. `render_frame` at scale 0.4 for detail. `project_validate` before export.
6. `render_video` only when the sheet looks right.

**Working with a human:** call `studio_open` early so they can watch the project in DT.ly Studio
(browser preview + timeline). Your edits appear there live, and they can drag keyframes, trim layers
or retype text themselves — those edits save to the same file, so call `project_describe` again
before your next change whenever they say they adjusted something.

## The model (AE vocabulary)

| After Effects | DT.ly |
|---|---|
| Composition / precomp | `comps[]`, layer `type: "precomp"` |
| Layer in/out point | `inPoint` / `outPoint` (comp seconds) |
| Transform | `transform.anchor/position/scale(%)/rotation(°)/opacity(%)/skew` |
| Stopwatch keyframes | any property as `{keyframes:[{t,v,ease}]}`; `ease` shapes the segment *leaving* that key |
| Easy Ease / graph editor | `easyEase`, `easeIn`, `easeOut`, `cubicOut`, `expoIn/Out/InOut`, `backOut`, bezier `[x1,y1,x2,y2]`, `{spring:{stiffness,damping}}`, `hold` |
| wiggle() | `{keyframes:[…], wiggle:{freq, amp, seed}}` |
| Parenting / null | `parent: layerId`, `type: "null"` (transform only, not opacity) |
| Masks | `masks: [{shape: rect|ellipse|path, rect:[x,y,w,h] (animatable), inverted}]` in layer space |
| Track matte | `matte: {layer, mode: alpha|alphaInverted}`; the matte layer is not drawn on its own |
| Trim Paths | shape `trim: {start, end}` in % — draw-on lines, rings, underlines |
| Text Animator + range selector | `animators: [{unit: grapheme|word|line, stagger, duration, delay, order, ease, from:{opacity,x,y,scale,rotation,blur,tracking,color}, clip, mode:"out"}]` |
| Effects | `effects: blur, dropShadow, glow, fill, brightness, saturate, contrast` |
| Motion blur switch | `motionBlur: {samples, shutter}` |
| Blending modes | `blendMode: multiply|screen|overlay|add|…` |

Layer-space origins: solids/images/videos/precomps use their top-left with the anchor at the
centre by default; shapes are centred on the origin; text is anchored at its alignment point,
vertically centred on the block. Position defaults to comp centre.

## Motion design rules of thumb

- **Ease everything.** Entrances: `cubicOut`/`expoOut` (fast in, gentle settle). Exits: `easeIn`/`expoIn`.
  Moves between two rests: `easyEase` or `expoInOut`. Linear only for constant drift (Ken Burns, rotation loops).
- **Timing.** UI-style moves 0.3–0.6 s; titles 0.6–1.2 s; nothing important shorter than 0.25 s.
  Stagger: graphemes 0.02–0.05 s, words 0.06–0.15 s, lines 0.1–0.2 s.
- **Overshoot sparingly** (`backOut`, springs): one bouncy element per beat, the rest calm.
- **Overlap actions.** Start the next element before the previous one settles (≈ 30–50 % overlap); it reads as one gesture.
- **Hierarchy.** One hero element per moment. Size contrast ≥ 1.6× between title and support text.
- **Legibility.** Text on footage needs a plate (`box`), a `dropShadow`, or a darkened background
  (`brightness` 40–60 %). Keep text inside the safe area: for 9:16 keep important content
  between y ≈ 250 and y ≈ 1600 and x 60–1020 (UI covers the edges on Reels/Shorts).
- **Hold.** Let finished text sit still long enough to read before the next thing moves.
- **Kinetic typography.** Vary scale and colour for emphasis words; alternate entrance directions;
  cut on the beat of the music (markers help: `comp_update` with `markers`).

## Indian scripts (Devanagari, etc.)

- Shaping is correct at any unit; per-grapheme animation keeps conjuncts (क्ष, श्र, र्ह) intact.
- Prefer `word` units for Marathi/Hindi body text — readers parse whole words; keep `grapheme`
  effects for short display words.
- Avoid large `tracking` on Devanagari: it breaks the visual headline (शिरोरेखा) between letters.
- Bundled fonts: `Baloo 2` (display, default) and `Mukta` (text). Register others in `project.fonts`.

## Presets

`preset_list` is the source of truth. Highlights:
- `text.*` — fadeUp, popIn, slam, blurIn, maskedLines, cascade, trackingIn, centerOut, typewriter, colorSweep, exits (`fadeOutDown`, `blurOut`, `maskedLinesOut`).
- `kinetic.sequence` — phrase-by-phrase kinetic typography with emphasis words.
- `opener.logoReveal`, `opener.bars` — brand openers.
- `slides.slideshow` — sliders from images/clips with Ken Burns, captions and transitions.
- `transition.between` — push, crossfade, zoom, wipe, whip (motion-blurred), slideUp between two overlapping layers.
- `element.lowerThird`, `element.highlightWord`.

Presets only write ordinary layers and keyframes, so everything they make stays editable.

## Checks before you call it done

- `project_validate` returns no problems.
- A `render_sheet` across the whole timeline shows nothing clipped, overlapping or unreadable,
  and every entrance has finished before the viewer needs to read it.
- Audio: music under voice ≈ 0.15–0.25 volume; fade the end (`fadeOut`) so it doesn't cut.
