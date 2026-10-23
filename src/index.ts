// DT.ly core: the document model, editing operations, presets and the environment-agnostic
// renderer. Safe to import in a browser; Node rendering lives in "@dnyantra/dtly/node".
export * from './core/model.js';
export {applyEase, spring, EASE_NAMES} from './core/ease.js';
export {val, evalKeyframes} from './core/anim.js';
export {parseColor, withAlpha} from './core/color.js';
export {layoutText, drawText, graphemes} from './core/text.js';
export * from './ops/ops.js';
export {PRESETS, listPresets, type Preset} from './presets/index.js';
export {TEXT_ANIMATORS} from './presets/text.js';
export {Renderer, type Host, type CanvasLike, type Drawable} from './render/renderer.js';
export {VERSION, BRAND} from './version.js';
