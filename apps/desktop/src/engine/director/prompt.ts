// What the app puts in the conversation. The Worker replaces any system prompt with the server-owned one
// (platform rules), so the workspace style and the project brief travel INSIDE the first user message,
// wrapped in <workspace_style> and <project_brief> (CustomerPro D13 prompt layers).
import type {DirectorPlan, MusicTrack} from '../../shared/director.js';

const esc = (s: string) => s.replace(/<\/(workspace_style|project_brief|owner_request|approved_plan|brand|music_library|media)>/gi, '</ $1>');

export const PLAN_SCHEMA = `{"title": string, "duration": seconds, "music": {"mood": string, "trackId"?: library id},
 "voice"?: {"language": "hi-IN"|"en-IN"|…, "speaker": string},
 "beats": [{"name": string, "duration": seconds, "shots": [{"clip": media id, "from": s, "to": s, "note"?: string}], "text"?: on-screen text, "vo"?: voiceover line}],
 "facts": [{"text": string, "source": media id or "brief"}],
 "gaps": [what is missing or unclear]}`;

export const contextBlocks = (o: {style: string; brief: string; brand?: unknown; music?: MusicTrack[]; media: string; project: string}) => [
  `<workspace_style>\n${esc(o.style)}\n</workspace_style>`,
  `<project_brief>\n${esc(o.brief)}\n</project_brief>`,
  o.brand ? `<brand>\n${JSON.stringify(o.brand)}\n</brand>` : '',
  o.music?.length ? `<music_library>\n${o.music.map((t) => `${t.id} | ${t.title} | ${t.mood} | ${t.bpm} bpm | ${t.duration} s`).join('\n')}\n</music_library>` : '',
  `<project>\n${o.project}\n</project>`,
  `<media>\n${o.media}\n</media>`,
].filter(Boolean).join('\n\n');

export const planInstructions = `<app_instructions>
Phase: PLAN. Look at the footage as much as you need (media_sheet, media_frames, media_transcribe, doc_pages), but do not change the project yet: the owner approves the plan first.
When the plan is ready, reply with a short note and the plan as JSON inside <plan>…</plan>:
${PLAN_SCHEMA}
Every fact needs its source (a media id, or "brief"). Shots use real seconds of real clips. Put anything missing (logo, phone number, a shot you need) in gaps.
</app_instructions>`;

export const buildInstructions = (plan: DirectorPlan) => `<approved_plan>
${JSON.stringify(plan)}
</approved_plan>
<app_instructions>
Phase: BUILD. The owner approved this plan (it may include their edits; follow it). Prepare each shot with segment_prepare, make the voiceover with vo_generate, the music with music_pick, then build with preset_apply "timeline.build" and the block.* presets before any layer-level edits. Check your work with render_sheet and fix what you find. End with a two-line summary for the owner.
</app_instructions>`;

export const editInstructions = (text: string) => `<owner_request>
${esc(text)}
</owner_request>
<app_instructions>
Phase: EDIT. Make this change to the current project (call project_describe first if you are not sure of its state). Keep everything else as it is, check the result with render_frame or render_sheet, and reply in one or two lines.
</app_instructions>`;

export const continueInstructions = `<app_instructions>The owner added credits. Continue from where you stopped; the project is saved as it was.</app_instructions>`;

export const analyseInstructions = (meta: string) => `<app_instructions>
Phase: ANALYSE. Describe this file for a video editor, independent of any project. Reply with JSON only:
{"caption": one sentence, "motion": "static"|"pan"|"drone orbit"|"handheld"|…, "quality": exposure/shake/focus notes, "best": [{"t": seconds, "why": string}], "tags": [string]}
</app_instructions>
<file>${esc(meta)}</file>`;

// The plan from the model's reply (last <plan>…</plan>, or a fenced JSON block), normalised. undefined if absent/invalid.
export const parsePlan = (text: string): DirectorPlan | undefined => {
  const m = [...text.matchAll(/<plan>([\s\S]*?)<\/plan>/g)].pop()?.[1] ?? /```json\s*([\s\S]*?)```/.exec(text)?.[1];
  if (!m) return undefined;
  let raw: any;
  try { raw = JSON.parse(m.trim()); } catch { return undefined; }
  return normalizePlan(raw);
};

const num = (v: unknown, d = 0) => (typeof v === 'number' && Number.isFinite(v) ? v : Number.isFinite(Number(v)) ? Number(v) : d);
const str = (v: unknown) => (typeof v === 'string' ? v : v === undefined || v === null ? '' : String(v));
export const normalizePlan = (raw: any): DirectorPlan | undefined => {
  if (!raw || typeof raw !== 'object' || !Array.isArray(raw.beats)) return undefined;
  const beats = raw.beats.map((b: any) => ({
    name: str(b?.name) || 'Beat', duration: num(b?.duration),
    shots: (Array.isArray(b?.shots) ? b.shots : []).map((s: any) => ({clip: str(s?.clip), from: num(s?.from), to: num(s?.to), ...(s?.note ? {note: str(s.note)} : {})})),
    ...(b?.text ? {text: str(b.text)} : {}), ...(b?.vo ? {vo: str(b.vo)} : {}),
  }));
  return {
    title: str(raw.title) || 'Untitled',
    duration: num(raw.duration, beats.reduce((s: number, b: {duration: number}) => s + b.duration, 0)),
    music: {mood: str(raw.music?.mood), ...(raw.music?.trackId ? {trackId: str(raw.music.trackId)} : {})},
    ...(raw.voice ? {voice: {language: str(raw.voice.language), speaker: str(raw.voice.speaker)}} : {}),
    beats,
    facts: (Array.isArray(raw.facts) ? raw.facts : []).map((f: any) => ({text: str(f?.text), source: str(f?.source)})),
    gaps: (Array.isArray(raw.gaps) ? raw.gaps : []).map(str),
  };
};

export const parseJsonObject = (text: string): any => {
  const start = text.indexOf('{'), end = text.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('The model did not return JSON');
  return JSON.parse(text.slice(start, end + 1));
};
