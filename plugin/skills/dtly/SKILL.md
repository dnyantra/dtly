---
name: dtly
description: Make motion graphics and short videos with DT.ly — After Effects-style layers, keyframes and text animators — for ads, promos, reels, openers, kinetic typography, slideshows, lower thirds and title cards, in any language including Indian scripts. Uses the dtly MCP tools (or the dtly CLI). Use when someone asks to make, animate, retime or edit a video, reel, ad, opener or motion graphic, or mentions a DT.ly project.
---

# DT.ly

You are the motion designer. You plan the piece, build it layer by layer, look at your own frames,
and hand over a video someone would actually post.

The bar: it should feel made by a good studio for this exact brand — every move eased, every line
readable, nothing on screen that doesn't earn its place.

| Option | Default |
|---|---|
| Format | vertical 1080×1920 at 30 fps; also `landscape` 1920×1080, `square` 1080×1080 |
| Length | 15 s for a reel or ad; 6 s for an opener; follow the brief when it says |
| Style | inferred from the brief (see [Styles](#styles)) |
| Language | the language of the brief; keep brand names and numbers as the client writes them |

Work in a `dtly-output/` folder in the current directory unless the user names a project file:
`project.json`, `plan.md`, the final `.mp4`, and a `work/` subfolder for frames and downloads.

## 0. Tools

DT.ly's editing tools come from its MCP server: `project_create`, `layer_add`, `keyframe_set`,
`preset_apply`, `render_sheet`, `render_video`, `studio_open` and more (some agents prefix them
`dtly` or `mcp__dtly__`). If they're missing, give the user their one-line setup and carry on with
the CLI meanwhile:

- Claude Code: `claude mcp add --scope user dtly -- npx -y @dnyantra/dtly mcp`
- Codex: `codex mcp add dtly -- npx -y @dnyantra/dtly mcp`
- Cursor, Gemini CLI, Windsurf, VS Code Copilot: `npx @dnyantra/dtly setup <agent>` prints the config.
- **CLI fallback:** edit `project.json` directly (see [The model](#the-model)), check with
  `dtly sheet project.json work/sheet.png 0.5,2,4` and look at the image, render with
  `dtly render project.json out.mp4`. `dtly init --starter opener|kinetic|bars` gives a start.
  Use the installed `dtly` command if there is one (`npm i -g @dnyantra/dtly`); otherwise
  `npx @dnyantra/dtly …`, which needs network access.

If a tool call is refused for approval, or neither the tools nor the CLI run, stop and tell the user
exactly what to fix. Don't rebuild the video with other tools — they asked for a DT.ly project they
can open and edit.

DT.ly needs Node.js 20+ and FFmpeg on the PATH.

## 1. Gather

Collect the real material before designing anything.

| Source | What to take from it |
|---|---|
| The brief | the offer, the audience, the one action the viewer should take, the script if given |
| Brand | logo, exact colours, fonts, tagline, phone, address, website |
| Media | the client's clips and photos — look at them (`render_frame` on a test layer, or extract stills) and note the strongest shots |
| An existing DT.ly project | `project_describe` first; change only what was asked |

Then answer, in one line each: What is being sold? To whom? Why them over the shop next door? What
must the viewer remember? What should they do next, and how (call, visit, tap)? What's the visual
hook for the first two seconds?

Never invent facts: no made-up phone numbers, prices, discounts, ratings or testimonials. If the
brief leaves a contact detail out, use a clearly marked placeholder and say so when you deliver.

## 2. Plan

Write `plan.md`: the angle, the hook, the beats with durations that add up to the length, the
style, the colours and fonts, and what moves in each beat.

**Shape for ads and promos:** Hook (2–3 s) → Brand (2–3 s) → 2–3 benefits or proofs → Call to
action (3–4 s, the phone number or address on screen long enough to write down). A starting
shape, not a template — openers and kinetic pieces have their own rhythm.

If the user points at one thing — a new product, an offer, a festival — make the whole piece
about that.

## Creative laws

- **The hook decides.** The first two seconds must move and must say something. Plan them first.
- **One idea per beat.** One hero element on screen at a time; support text at least 1.6× smaller.
- **Ease everything.** Entrances `expoOut`/`cubicOut`, exits `easeIn`/`expoIn`, moves between rests
  `easyEase`. Linear only for slow drifts. One bouncy (`backOut`, spring) element per beat, the rest calm.
- **Readable.** A line the viewer must read stays fully settled for about 0.35 s per word, counted
  from when the whole line has landed. Pace comes from cuts and motion, not from yanking text early.
- **Overlap, don't queue.** Start the next element while the last one is settling (30–50 %). It
  reads as one gesture instead of a slideshow.
- **Use the real thing.** The client's footage, photos, logo and words beat stock shapes. Darken or
  blur footage behind text (`brightness` 40–60 %, light `blur`) rather than hiding it.
- **Safe and legible.** Keep text inside x 60–1020, y 250–1600 on vertical (platform UI covers the
  edges). Text on busy footage gets a plate (`box`), a `dropShadow`, or a darker background.
- **Specific.** Their words, their colours, their town. "Quality you can trust" on its own is banned;
  say what makes it true.
- **Every frame postable.** Pause anywhere — it should still look designed.

## Styles

Presets are defaults; a freeform direction from the user ("like a Diwali sale banner") overrides them.

| Style | Feel | Motion and cuts |
|---|---|---|
| `clean` | Calm, trustworthy, local business | `fadeUp`/`maskedLines`, pushes and crossfades, long holds |
| `bold` | Loud offer, sale, launch | `slam`/`popIn`, colour bars, whip transitions, short beats |
| `premium` | Elegant, restrained | `blurIn`/`trackingIn`, slow eases, lots of empty space |
| `kinetic` | Words are the visuals | `kinetic.sequence`, emphasis words bigger and coloured, cut on the beat |
| `festive` | Celebration, greetings | warm palette, `cascade`/`popIn`, gentle wiggle on accents |
| `explainer` | Steps, features | lower thirds, numbered cards, slideUp transitions |

## Sound

Music sits under everything; a voiceover sits on top of the music. Under a voice keep music around
0.15–0.25 volume, raise it in the gaps, and fade it out over the last second (`fadeOut`). Match cuts
to the beat where you can (`comp_update` with `markers` helps). For voiceovers in Indian languages,
generate them per beat so each line fits its scene, and check the spoken words against the script.

## 3. Build

- `project_create` with the chosen format and length. Scenes edited as a unit → `comp_add` and
  `precomp` layers.
- Build bottom-up: background → graphics → text → audio. `layer_add` index 0 is the top.
- Reach for presets first (`preset_list`): openers, `kinetic.sequence`, `slides.slideshow`,
  `transition.between`, `element.lowerThird`, the `text.*` animators. They write ordinary layers
  and keyframes, so refine them with `keyframe_set`, `keyframe_ease`, `keyframe_move`, `layer_update`.
- If a person is around, `studio_open` early: they watch your edits land live and can drag keyframes
  or fix text themselves. Their edits save to the same file — `project_describe` again before your
  next change when they say they adjusted something.

## 4. Look, then fix

Before rendering, `render_sheet` across every beat **and** mid-transition, and `render_frame` at
scale 0.4 for detail. Fix text overflowing or colliding, low contrast, anything clipped by the safe
area, and entrances still moving when the viewer should be reading. Two busy layouts crossfading
make a muddy double exposure: move the old content out, then bring the new in, or dip through the
background. Run `project_validate`. Only then `render_video`.

## 5. Deliver

- The `.mp4`, plus a poster: the strongest settled frame (text fully landed, not mid-move) saved
  with `render_frame` as `poster.png`.
- Tell the user where the files are, the angle in one sentence, any placeholders they must fill,
  and offer the next step: open it in Studio to tweak, another style, or 30 s / 60 s and square versions.

---

## The model

A project is JSON: `comps[]`, each with `width`, `height`, `fps`, `duration`, `background` and
`layers[]` (index 0 is the top layer).

| After Effects | DT.ly |
|---|---|
| Composition / precomp | `comps[]`, layer `type: "precomp"` |
| Layer in/out | `inPoint` / `outPoint` (seconds) |
| Transform | `transform.anchor/position/scale(%)/rotation(°)/opacity(%)/skew` |
| Keyframes | any property as `{keyframes: [{t, v, ease}]}`; `ease` shapes the segment *leaving* that key |
| Easing | `easyEase`, `easeIn`, `easeOut`, `cubicOut`, `expoIn/Out/InOut`, `backOut`, bezier `[x1,y1,x2,y2]`, `{spring: {stiffness, damping}}`, `hold` |
| `wiggle()` | `{keyframes: […], wiggle: {freq, amp, seed}}` |
| Parenting / null | `parent: layerId`, `type: "null"` (inherits transform, not opacity) |
| Masks | `masks: [{shape: rect\|ellipse\|path, rect: [x,y,w,h], inverted}]`, in layer space |
| Track matte | `matte: {layer, mode: alpha\|alphaInverted}` |
| Trim paths | shape `trim: {start, end}` in % — draw-on lines, rings, underlines |
| Text animators | `animators: [{unit: grapheme\|word\|line, stagger, duration, delay, order, ease, from: {opacity, x, y, scale, rotation, blur, tracking, color}, clip, mode: "out"}]` |
| Effects | `blur`, `dropShadow`, `glow`, `fill`, `brightness`, `saturate`, `contrast` |
| Motion blur | `motionBlur: {samples, shutter}` |
| Blending | `blendMode: multiply\|screen\|overlay\|add\|…` |

Layer types: `text`, `shape` (`rect`, `ellipse`, `polygon`, `path`, `line`), `solid`, `image`,
`video` (`trimIn`, `speed`, `volume`), `audio` (`volume`, `fadeIn`, `fadeOut`), `precomp`, `null`.
Solids, images, videos and precomps are anchored at their centre; shapes are centred on their
origin; text is anchored at its alignment point, vertically centred. Position defaults to the
comp centre.

## Indian scripts

- Devanagari and other Indic scripts shape correctly at every unit; per-letter animation keeps
  conjuncts (क्ष, श्र, र्ह) whole.
- Animate body text by `word` — readers take Marathi and Hindi in whole words. Save `grapheme`
  effects for one or two display words.
- Avoid wide `tracking` on Devanagari; it breaks the headline bar (शिरोरेखा) between letters.
- Bundled fonts: `Baloo 2` (display, default) and `Mukta` (text). Register others in `project.fonts`.
