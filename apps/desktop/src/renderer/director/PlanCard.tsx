// The plan card (task 4.5): beats with durations, shots (clip + seconds), on-screen text, voiceover, music,
// facts with sources, gaps. Everything is editable before the owner approves.
import type {DirectorPlan, PlanBeat, PlanShot} from '../../shared/director.js';
import type {SourceState} from '../../shared/types.js';

type Props = {plan: DirectorPlan; media: SourceState[]; disabled?: boolean; onChange: (p: DirectorPlan) => void};

const num = (v: string) => Math.max(0, Math.round((Number(v) || 0) * 100) / 100);
const val = (e: Event) => (e.target as HTMLInputElement).value;

export const PlanCard = ({plan, media, disabled, onChange}: Props) => {
  const set = (patch: Partial<DirectorPlan>) => onChange({...plan, ...patch});
  const setBeat = (i: number, patch: Partial<PlanBeat>) => set({beats: plan.beats.map((b, k) => (k === i ? {...b, ...patch} : b))});
  const setShot = (i: number, j: number, patch: Partial<PlanShot>) => setBeat(i, {shots: plan.beats[i].shots.map((s, k) => (k === j ? {...s, ...patch} : s))});
  const total = plan.beats.reduce((s, b) => s + b.duration, 0);
  const clipName = (id: string) => media.find((m) => m.id === id || m.name === id)?.name;
  const videos = media.filter((m) => m.kind === 'video');
  return (
    <div class="plan-card">
      <input class="plan-title" value={plan.title} disabled={disabled} onInput={(e) => set({title: val(e)})} />
      <div class="small muted">{plan.beats.length} beats · {total.toFixed(1)} s{plan.duration && Math.abs(plan.duration - total) > 0.5 ? ` (target ${plan.duration} s)` : ''}</div>
      <ol class="beats">
        {plan.beats.map((b, i) => (
          <li key={i} class="beat">
            <div class="row">
              <input class="grow" value={b.name} disabled={disabled} onInput={(e) => setBeat(i, {name: val(e)})} />
              <input class="num" type="number" step="0.1" min="0" value={b.duration} disabled={disabled} onInput={(e) => setBeat(i, {duration: num(val(e))})} title="Seconds" /><span class="small muted">s</span>
              <button class="link" disabled={disabled} title="Remove beat" onClick={() => set({beats: plan.beats.filter((_, k) => k !== i)})}>×</button>
            </div>
            {b.shots.map((s, j) => (
              <div key={j} class="shot row small">
                <select value={videos.some((v) => v.id === s.clip) ? s.clip : ''} disabled={disabled} onChange={(e) => setShot(i, j, {clip: (e.target as HTMLSelectElement).value})} title={s.clip}>
                  {!videos.some((v) => v.id === s.clip) && <option value="">{clipName(s.clip) ?? s.clip ?? 'clip'}</option>}
                  {videos.map((v) => <option value={v.id}>{v.name}</option>)}
                </select>
                <input class="num" type="number" step="0.1" value={s.from} disabled={disabled} onInput={(e) => setShot(i, j, {from: num(val(e))})} />–
                <input class="num" type="number" step="0.1" value={s.to} disabled={disabled} onInput={(e) => setShot(i, j, {to: num(val(e))})} />s
                <button class="link" disabled={disabled} onClick={() => setBeat(i, {shots: b.shots.filter((_, k) => k !== j)})}>×</button>
              </div>
            ))}
            {b.shots.length === 0 && <div class="small muted">No shot</div>}
            <button class="link small" disabled={disabled || !videos.length} onClick={() => setBeat(i, {shots: [...b.shots, {clip: videos[0]?.id ?? '', from: 0, to: 2}]})}>+ shot</button>
            <label class="small">On screen<input value={b.text ?? ''} disabled={disabled} onInput={(e) => setBeat(i, {text: val(e) || undefined})} /></label>
            <label class="small">Voiceover<textarea rows={2} value={b.vo ?? ''} disabled={disabled} onInput={(e) => setBeat(i, {vo: val(e) || undefined})} /></label>
          </li>
        ))}
      </ol>
      <button class="link small" disabled={disabled} onClick={() => set({beats: [...plan.beats, {name: 'New beat', duration: 2, shots: []}]})}>+ beat</button>
      <div class="form-grid">
        <label>Music mood<input value={plan.music.mood} disabled={disabled} onInput={(e) => set({music: {...plan.music, mood: val(e)}})} /></label>
        <label>Track<input value={plan.music.trackId ?? ''} placeholder="director picks" disabled={disabled} onInput={(e) => set({music: {...plan.music, trackId: val(e) || undefined}})} /></label>
        {plan.voice && <label>Voice language<input value={plan.voice.language} disabled={disabled} onInput={(e) => set({voice: {...plan.voice!, language: val(e)}})} /></label>}
        {plan.voice && <label>Speaker<input value={plan.voice.speaker} disabled={disabled} onInput={(e) => set({voice: {...plan.voice!, speaker: val(e)}})} /></label>}
      </div>
      <h4>Facts</h4>
      <ul class="facts small">
        {plan.facts.map((f, i) => (
          <li key={i} class="row">
            <input class="grow" value={f.text} disabled={disabled} onInput={(e) => set({facts: plan.facts.map((x, k) => (k === i ? {...x, text: val(e)} : x))})} />
            <span class="source" title="Source">{clipName(f.source) ?? f.source}</span>
            <button class="link" disabled={disabled} onClick={() => set({facts: plan.facts.filter((_, k) => k !== i)})}>×</button>
          </li>
        ))}
        {plan.facts.length === 0 && <li class="muted">No facts.</li>}
      </ul>
      {plan.gaps.length > 0 && (
        <>
          <h4>Missing</h4>
          <ul class="gaps small">{plan.gaps.map((g) => <li>{g}</li>)}</ul>
        </>
      )}
    </div>
  );
};

