// Graphic blocks + timeline.build: rebuilds the KK Park reel from its shot list, overlays, beat grid and
// voiceover durations, and checks shot order and cut times against the hand-built project
// (test/fixtures/kkpark-reference.json, taken from kkpark/project/project.json).
// With the kkpark folder next to this repo (or KKPARK=/path), it also renders a contact sheet of
// both projects and compares them.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {getComp, newProject, PRESETS, validate, type Project} from '../src/index.js';
import {renderContactSheet, writeProject} from '../src/node.js';
import {TOOLS, toolByName} from '../src/tools/index.js';

const step = (s: string) => console.log(`✓ ${s}`);
const ref = JSON.parse(fs.readFileSync(path.resolve('test/fixtures/kkpark-reference.json'), 'utf8')) as {
  beats: number[]; markers: {t: number; label: string}[]; shots: {id: string; inPoint: number; outPoint: number}[]; vo: {id: string; inPoint: number; outPoint: number}[]; comps: number; layers: number;
};

// ---- every block applies to an empty comp and validates ----
{
  const p = newProject({name: 'blocks', duration: 8});
  const brand = {colors: {primary: '#1D4ED8', accent: '#F59E0B', ink: '#111827'}, fonts: {heading: 'Baloo 2', body: 'Baloo 2'}};
  const params: Record<string, Record<string, unknown>> = {
    'block.titlePlate': {title: 'GREEN VALLEY\nRESIDENCY', kicker: 'PRESENTING', sub: '2 & 3 BHK HOMES'},
    'block.chip': {text: 'CLUBHOUSE'},
    'block.kickerChip': {text: 'SWIMMING POOL', kicker: 'INSIDE THE SOCIETY'},
    'block.areaReveal': {points: [[300, 600], [800, 560], [860, 1300], [320, 1350]], value: 52000, unit: 'SQ.FT'},
    'block.badge': {name: 'RAILWAY STATION', chip: '5 MIN', at: [540, 1100]},
    'block.price': {value: 1.25},
    'block.bigName': {title: 'GREEN VALLEY', sub: 'PUNE'},
    'block.endCard': {name: 'GREEN VALLEY', logo: 'logo.png', tagline: 'LIVE GREEN', phones: ['98765 43210', '91234 56789'], address: 'Baner, Pune', website: 'www.example.com'},
    'block.logoTile': {src: 'logo.png'},
    'block.watermark': {src: 'logo.png', from: 1, to: 6},
    'grade.look': {look: 'tealOrange'},
  };
  for (const [name, o] of Object.entries(params)) {
    const r = PRESETS[name].apply(p, 'main', {brand, ...o});
    assert.ok(r.created.length > 0, `${name} created layers`);
  }
  // text-mask intro takes over the comp's bottom video layer
  p.comps[0].layers.push({id: 'clip', type: 'video', src: 'clip.mp4', size: [1188, 2112]});
  PRESETS['block.textMaskIntro'].apply(p, 'main', {brand, text: 'GREEN VALLEY', logo: 'logo.png'});
  assert.ok(!p.comps[0].layers.some((l) => l.id === 'clip'), 'intro replaced the plate');
  assert.equal(p.comps[0].layers.filter((l) => l.type === 'video' && l.src === 'clip.mp4').length, 2);
  // brand colours reach the layers
  const plate = p.comps[0].layers.find((l) => l.id === 'plate');
  assert.equal(plate?.type === 'text' && (plate.box?.color as string), '#F59E0B');
  assert.deepEqual(validate(p), []);
  const names = Object.keys(PRESETS).filter((n) => n.startsWith('block.') || n.startsWith('grade.'));
  assert.equal(names.length, 12);
  for (const n of names) assert.ok(PRESETS[n].params.length > 20 && PRESETS[n].description.length > 20, `${n} documented`);
  step(`12 blocks/looks apply, validate and use brand colours (${p.comps[0].layers.length} layers)`);
}

// ---- timeline.build: rebuild KK Park ----
const LIME = '#C9E62E', INK = '#0B0B0B';
const SHOTS = [
  {id: 'intro', dur: 3.2}, {id: 'board', dur: 3.0}, {id: 'match', dur: 3.2}, {id: 'bat1', dur: 1.8}, {id: 'night', dur: 2.4},
  {id: 'sqft', dur: 4.6}, {id: 'towers', dur: 2.6}, {id: 'turf', dur: 2.8}, {id: 'bat2', dur: 1.9}, {id: 'cheer', dur: 1.2},
  {id: 'run', dur: 1.7}, {id: 'trophy', dur: 1.5}, {id: 'team', dur: 1.6}, {id: 'crowd', dur: 2.6}, {id: 'school', dur: 1.75},
  {id: 'college', dur: 3.2}, {id: 'play', dur: 2.3}, {id: 'gym', dur: 2.0}, {id: 'garden', dur: 2.3}, {id: 'gate', dur: 2.8},
  {id: 'evening', dur: 4.0}, {id: 'end', dur: 7.6},
];
const CAMPUS = [[450, 510], [555, 285], [750, 180], [855, 255], [900, 375], [936, 600], [936, 1170], [954, 1320], [870, 1560], [720, 1575], [555, 1410], [525, 1200], [510, 900], [450, 750]];
const kchip = (text: string, kicker: string, o: Record<string, unknown> = {}) => ({block: 'block.kickerChip', params: {text, kicker, ...o}});
const OVER: Record<string, unknown> = {
  intro: {block: 'block.textMaskIntro', params: {text: 'K K PARK', kicker: 'PRESENTING', logo: '../assets/logo.png', logoAspect: 618 / 582, background: '#B30F1C'}},
  board: {block: 'block.titlePlate', params: {kicker: 'K K PARK PRESENTS', title: 'KK PARK\nPREMIER LEAGUE', sub: 'BOX CRICKET TOURNAMENT', start: 0.15}},
  sqft: {block: 'block.areaReveal', params: {points: CAMPUS, value: 180000, unit: 'SQ.FT', kicker: 'SPREAD ACROSS', start: 0.15}},
  turf: kchip('BOX CRICKET TURF', 'INSIDE THE SOCIETY'),
  school: kchip('SCHOOL', 'INSIDE THE CAMPUS', {y: 1460}),
  college: [kchip('S.D.S.M COLLEGE', 'JUST OPPOSITE', {y: 1400}), {block: 'block.chip', params: {text: '2.1 KM FROM PALGHAR STATION', start: 0.9, y: 1540, color: '#FFFFFF', textColor: INK, size: 44}}],
  play: kchip('KIDS PLAY AREA', 'FOR THE LITTLE ONES'),
  gym: kchip('OPEN GYM', 'STAY FIT'),
  garden: kchip('LANDSCAPED GARDEN', 'GREEN LIVING'),
  gate: kchip('GRAND GATED ENTRANCE', 'SAFE & SECURE'),
  evening: {block: 'block.bigName', params: {title: 'K K PARK', sub: 'GATED COMMUNITY · PALGHAR', start: 0.25}},
  end: {block: 'block.endCard', params: {name: 'K K PARK', logo: '../assets/logo.png', logoAspect: 618 / 582, tagline: "PALGHAR'S FIRST SINGLE LARGEST\nGATED COMMUNITY", cta: 'BOOK YOUR SITE VISIT',
    phones: ['85529 19026', '80804 91482'], address: 'Opp. S.D.S.M College, Kharekuran Road,\nPalghar (W) · 2.1 km from Palghar Station', website: 'www.kkgroup.info', start: 0.2}},
};
const TRANS = ['flash', 'zoom', 'whip', 'rgbWhip', 'glitch', 'whip', 'zoom', 'flash', 'whip', 'rgbWhip', 'flash', 'whip', 'zoom', 'glitch', 'slideUp', 'zoom', 'whip', 'rgbWhip', 'whip', 'crossfade', 'crossfade'];
// VO line i starts at (shot, offset); durations measured with ffprobe from kkpark/vo/l1..l8.wav
const VO: [string, number, number][] = [['board', 0.35, 2.201375], ['match', 0.25, 4.375063], ['sqft', 0.35, 4.006083], ['turf', 0.15, 5.017438],
  ['school', 0.1, 5.021542], ['play', 0.45, 4.412563], ['evening', 0.35, 2.718229], ['end', 2.2, 1.695313]];

const buildKK = () => {
  const p: Project = {dtly: 1, name: 'KK Park Premier League (timeline.build)', root: 'main',
    fonts: {'Montserrat Black Italic': ['../fonts/MontserratBlackItalic.ttf'], 'Montserrat ExtraBold': ['../fonts/MontserratExtraBold.ttf'], 'Montserrat SemiBold': ['../fonts/MontserratSemiBold.ttf']},
    comps: [{id: 'main', name: 'KK Park reel', width: 1080, height: 1920, fps: 30, duration: 60, background: '#000000', layers: []}]};
  const r = PRESETS['timeline.build'].apply(p, 'main', {
    shots: SHOTS.map((s) => ({id: s.id, src: `../footage/shots/${s.id}.mp4`, trimIn: 0, dur: s.dur, speed: 1, ...(s.id === 'sqft' ? {push: 104} : {}), ...(OVER[s.id] ? {overlay: OVER[s.id]} : {})})),
    music: {src: '../music/techno.wav', beats: ref.beats},
    transitions: TRANS,
    vo: VO.map(([shot, offset, duration], i) => ({src: `../vo/l${i + 1}.wav`, duration, at: {shot, offset}})),
    duck: {lo: 0.2, hi: 0.55},
    grade: 'punch',
    watermark: {src: '../assets/logo.png', aspect: 618 / 582, from: {shot: 'board'}, to: {shot: 'end', offset: 0.2}},
    duration: 60,
    oversize: 1.1,
    brand: {colors: {primary: '#C8102E', accent: LIME, ink: INK}, fonts: {heading: 'Montserrat Black Italic', display: 'Montserrat ExtraBold', body: 'Montserrat SemiBold'}},
  });
  return {p, r};
};

{
  const {p, r} = buildKK();
  const main = getComp(p, 'main');
  const FRAME = 1 / 30;
  // markers: same order, cut times within one frame
  assert.deepEqual(main.markers!.map((m) => m.label), ref.markers.map((m) => m.label), 'shot order');
  const diffs = main.markers!.map((m, i) => Math.abs(m.t - ref.markers[i].t));
  assert.ok(Math.max(...diffs) <= FRAME, `cut times within a frame (max diff ${Math.max(...diffs).toFixed(4)} s)`);
  // precomp stacking order and in/out points
  const shots = main.layers.filter((l) => l.type === 'precomp');
  assert.deepEqual(shots.map((l) => l.id), ref.shots.map((s) => s.id), 'precomp stack order');
  shots.forEach((l, i) => {
    assert.ok(Math.abs((l.inPoint ?? 0) - ref.shots[i].inPoint) <= FRAME && Math.abs((l.outPoint ?? 0) - ref.shots[i].outPoint) <= FRAME, `${l.id} in/out`);
  });
  const vo = main.layers.filter((l) => l.id.startsWith('vo-'));
  vo.forEach((l, i) => assert.ok(Math.abs((l.inPoint ?? 0) - ref.vo[i].inPoint) <= FRAME && Math.abs((l.outPoint ?? 0) - ref.vo[i].outPoint) <= FRAME, `${l.id} timing`));
  assert.deepEqual(validate(p), []);
  const layers = p.comps.reduce((a, c) => a + c.layers.length, 0);
  assert.equal(p.comps.length, ref.comps, 'one precomp per shot + main');
  step(`timeline.build rebuilds KK Park: ${shots.length} shots in order, max cut diff ${(Math.max(...diffs) * 1000).toFixed(2)} ms, VO within a frame, ${p.comps.length} comps / ${layers} layers (original ${ref.comps} / ${ref.layers})`);
  console.log(`  ${r.note}`);

  // Optional visual check against the original project (needs the kkpark folder with footage).
  const kk = process.env.KKPARK ?? path.resolve('../kkpark');
  if (fs.existsSync(path.join(kk, 'project/project.json')) && fs.existsSync(path.join(kk, 'footage/shots/intro.mp4'))) {
    // The rebuilt project lives in a temp copy of the folder layout (media symlinked), never in kkpark/.
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtly-kk-'));
    for (const d of ['footage', 'music', 'vo', 'assets', 'fonts']) fs.symlinkSync(path.join(kk, d), path.join(dir, d));
    fs.mkdirSync(path.join(dir, 'project'));
    const file = path.join(dir, 'project', 'rebuilt.json');
    try {
      writeProject(file, p);
      const times = [1.0, 2.6, 4.6, 8.0, 15.5, 22.0, 36.5, 50.0, 56.0];
      const a = await renderContactSheet(path.join(kk, 'project/project.json'), times, path.join(dir, 'orig.png'), {columns: 9, thumbWidth: 120});
      const b = await renderContactSheet(file, times, path.join(dir, 'rebuilt.png'), {columns: 9, thumbWidth: 120});
      const {loadImage, Canvas} = await import('skia-canvas');
      const px = async (f: string) => { const img = await loadImage(f); const c = new Canvas(img.width, img.height); const x = c.getContext('2d'); x.drawImage(img, 0, 0); return x.getImageData(0, 0, img.width, img.height).data; };
      const [da, db] = [await px(a), await px(b)];
      assert.equal(da.length, db.length);
      let sum = 0;
      for (let i = 0; i < da.length; i += 4) sum += Math.abs(da[i] - db[i]) + Math.abs(da[i + 1] - db[i + 1]) + Math.abs(da[i + 2] - db[i + 2]);
      const mad = sum / (da.length / 4) / 3;
      assert.ok(mad < 3, `contact sheets differ too much (mean abs diff ${mad.toFixed(2)}/255)`);
      step(`contact sheet of the rebuilt reel matches the original (mean abs pixel diff ${mad.toFixed(2)}/255 over ${times.length} frames)`);
    } finally {
      if (!process.env.KEEP) fs.rmSync(dir, {recursive: true, force: true}); else console.log(`  sheets in ${dir}`);
    }
  } else console.log('  (kkpark footage not found: skipped the contact-sheet comparison)');
}

// ---- shared tools interface ----
{
  assert.equal(TOOLS.length, 26);
  for (const t of TOOLS) {
    assert.equal(toolByName(t.name), t);
    assert.equal((t.inputSchema as {type?: string}).type, 'object');
    assert.equal((t.inputSchema as {additionalProperties?: boolean}).additionalProperties, false);
    assert.ok(!('project' in ((t.inputSchema as {properties?: object}).properties ?? {})), `${t.name} takes the project from ctx`);
  }
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dtly-tools-'));
  const projectPath = path.join(dir, 'project.json');
  const denied: string[] = [];
  const ctx = {projectPath, allowRead: (p: string) => { if (!p.startsWith(dir)) { denied.push(p); return false; } return true; }};
  const ok = async (name: string, input: unknown) => { const r = await toolByName(name)!.handler(input, ctx); assert.ok(!r.isError, `${name}: ${JSON.stringify(r.content)}`); return r; };
  await ok('project_create', {name: 'Tools test', duration: 4});
  await ok('preset_apply', {preset: 'block.kickerChip', params: {text: 'POOL', kicker: 'INSIDE'}});
  fs.copyFileSync(path.resolve('test/fixtures/icon.svg'), path.join(dir, 'icon.svg'));
  await ok('svg_import', {file: 'icon.svg', width: 200});
  const bad = await toolByName('svg_import')!.handler({file: path.resolve('test/fixtures/icon.svg')}, ctx);
  assert.ok(bad.isError && denied.length === 1, 'allowRead guards svg_import');
  const inval = await toolByName('layer_get')!.handler({layer: 1, extra: true}, ctx);
  assert.ok(inval.isError && /Invalid input/.test((inval.content[0] as {text: string}).text));
  const list = await ok('preset_list', {});
  assert.match((list.content[0] as {text: string}).text, /timeline\.build/);
  const d = await ok('project_describe', {});
  assert.match((d.content[0] as {text: string}).text, /chip/);
  // allowWrite: optional; when present every tool that writes a file (other than the project) asks it.
  const asked: string[] = [];
  const wctx = {...ctx, allowWrite: (p: string) => { asked.push(p); return p.startsWith(path.join(dir, 'renders') + path.sep); }};
  const denied1 = await toolByName('render_video')!.handler({out: 'out.mp4', to: 0.2}, wctx);
  assert.ok(denied1.isError && /Writing out\.mp4 is not allowed/.test((denied1.content[0] as {text: string}).text));
  assert.ok(!fs.existsSync(path.join(dir, 'out.mp4')));
  const denied2 = await toolByName('map_tiles')!.handler({out: '../map.png', tiles: 'http://127.0.0.1:9/{z}/{x}/{y}.png', bounds: [[19, 73], [18, 74]]}, wctx);
  assert.ok(denied2.isError && /not allowed/.test((denied2.content[0] as {text: string}).text));
  const denied3 = await toolByName('render_frame')!.handler({time: 0.5}, wctx);
  assert.ok(denied3.isError && !fs.existsSync(path.join(dir, '.dtly')), 'preview folder not created when denied');
  const denied4 = await toolByName('render_sheet')!.handler({times: [0, 1]}, wctx);
  assert.ok(denied4.isError);
  assert.deepEqual(asked.map((p) => path.relative(dir, p).split(path.sep)[0]), ['out.mp4', '..', '.dtly', '.dtly']);
  const allowed = await toolByName('render_video')!.handler({out: 'renders/ok.mp4', to: 0.2}, wctx);
  assert.ok(!allowed.isError && fs.statSync(path.join(dir, 'renders/ok.mp4')).size > 500, JSON.stringify(allowed.content));
  await ok('render_frame', {time: 0.5, scale: 0.1}); // no allowWrite → allowed
  fs.rmSync(dir, {recursive: true, force: true});
  step('@dnyantra/dtly/tools: 26 tools with JSON Schemas, ctx.projectPath, allowRead + allowWrite guards, input validation');
}
console.log('Timeline and blocks tests passed.');
