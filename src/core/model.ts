// DT.ly document model — an After Effects-style project as plain JSON.
// Units follow AE: time in seconds, scale and opacity in percent, rotation in degrees.

export type Vec2 = [number, number];
export type Color = string; // any CSS color: '#E8692A', 'rgba(0,0,0,.5)'

export type EaseName =
  | 'linear' | 'hold'
  | 'easeIn' | 'easeOut' | 'easyEase'
  | 'quadOut' | 'cubicOut' | 'expoIn' | 'expoOut' | 'expoInOut' | 'backOut' | 'backIn' | 'elasticOut' | 'bounceOut';
// A named curve, a cubic-bezier [x1, y1, x2, y2], or a damped spring.
export type Ease = EaseName | [number, number, number, number] | {spring: {stiffness?: number; damping?: number; mass?: number}};

// `ease` shapes the segment that LEAVES this keyframe (towards the next one).
export interface Keyframe<T> { t: number; v: T; ease?: Ease }
export interface Wiggle { freq: number; amp: number; seed?: number }
export interface Animated<T> { keyframes: Keyframe<T>[]; wiggle?: Wiggle }
export type Prop<T> = T | Animated<T>;

export interface Transform {
  anchor?: Prop<Vec2>;
  position?: Prop<Vec2>;
  scale?: Prop<Vec2>; // percent
  rotation?: Prop<number>; // degrees
  opacity?: Prop<number>; // percent
  skew?: Prop<number>; // degrees, along X
}

export type Effect =
  | {type: 'blur'; radius: Prop<number>}
  | {type: 'dropShadow'; color?: Color; blur?: Prop<number>; distance?: Prop<number>; angle?: number; opacity?: Prop<number>}
  | {type: 'glow'; color?: Color; radius?: Prop<number>; strength?: Prop<number>}
  | {type: 'fill'; color: Color; opacity?: Prop<number>}
  | {type: 'brightness'; amount: Prop<number>} // percent, 100 = unchanged
  | {type: 'saturate'; amount: Prop<number>}
  | {type: 'contrast'; amount: Prop<number>};

export interface Mask {
  shape: 'rect' | 'ellipse' | 'path';
  // rect/ellipse: [x, y, w, h] in layer space; path: list of points
  rect?: Prop<[number, number, number, number]>;
  points?: Vec2[];
  radius?: number;
  inverted?: boolean;
}

export interface Matte { layer: string; mode: 'alpha' | 'alphaInverted' }

export type BlendMode = 'normal' | 'multiply' | 'screen' | 'overlay' | 'add' | 'darken' | 'lighten' | 'softLight' | 'difference';

// Text animators: AE-style per-unit animation with a stagger, so every grapheme/word/line
// starts `stagger` seconds after the previous one, moving FROM the given offsets to rest.
export interface TextAnimator {
  unit: 'grapheme' | 'word' | 'line';
  mode?: 'in' | 'out'; // 'out' animates from rest TO the offsets, ending at `delay + ...`
  delay?: number; // seconds from layer inPoint (for 'out': seconds before layer outPoint)
  stagger?: number;
  duration?: number;
  order?: 'forward' | 'reverse' | 'center' | 'edges' | 'random';
  ease?: Ease;
  seed?: number;
  clip?: boolean; // reveal each line through its own box (classic masked line reveal)
  from: {opacity?: number; x?: number; y?: number; scale?: number; rotation?: number; blur?: number; tracking?: number; color?: Color};
}

interface LayerBase {
  id: string;
  name?: string;
  inPoint?: number; // seconds, default 0
  outPoint?: number; // seconds, default comp duration
  parent?: string; // layer id — inherits transform (not opacity), like AE parenting
  transform?: Transform;
  blendMode?: BlendMode;
  effects?: Effect[];
  masks?: Mask[];
  matte?: Matte; // track matte: this layer is shown through another layer
  hidden?: boolean; // e.g. layers used only as mattes
  motionBlur?: {samples?: number; shutter?: number}; // shutter in degrees, AE default 180
}

export interface SolidLayer extends LayerBase { type: 'solid'; color: Prop<Color>; size?: Vec2 }
export interface NullLayer extends LayerBase { type: 'null' }
export interface ShapeLayer extends LayerBase {
  type: 'shape';
  shape: 'rect' | 'ellipse' | 'polygon' | 'path' | 'line';
  size?: Prop<Vec2>; // rect/ellipse
  radius?: Prop<number>; // rect corner radius / polygon radius
  sides?: number; // polygon
  points?: Vec2[]; // path/line
  closed?: boolean;
  fill?: Prop<Color> | {linear: {from: Vec2; to: Vec2; stops: [number, Color][]}};
  stroke?: Prop<Color>;
  strokeWidth?: Prop<number>;
  lineCap?: 'butt' | 'round' | 'square';
  trim?: {start?: Prop<number>; end?: Prop<number>}; // percent of path length, for draw-on lines
}
export interface TextLayer extends LayerBase {
  type: 'text';
  text: string;
  font?: string; // family registered in project.fonts
  weight?: number;
  size?: Prop<number>;
  color?: Prop<Color>;
  align?: 'left' | 'center' | 'right';
  lineHeight?: number; // multiple of size
  tracking?: Prop<number>; // extra px between graphemes
  maxWidth?: number; // wrap width in px
  stroke?: {color: Color; width: number};
  shadow?: {color: Color; blur: number; x?: number; y?: number};
  box?: {color: Prop<Color>; padding?: [number, number]; radius?: number; reveal?: Prop<number>}; // background plate; reveal 0-100 wipes it in
  animators?: TextAnimator[];
}
export interface ImageLayer extends LayerBase { type: 'image'; src: string; size?: Vec2; fit?: 'cover' | 'contain' | 'fill' }
export interface VideoLayer extends LayerBase {
  type: 'video';
  src: string;
  size?: Vec2;
  fit?: 'cover' | 'contain' | 'fill';
  trimIn?: number; // seconds into the source
  speed?: number; // 0.5 = half speed
  volume?: Prop<number>; // 0-1, default 0 (muted)
}
export interface AudioLayer extends LayerBase {
  type: 'audio';
  src: string;
  trimIn?: number;
  volume?: Prop<number>; // 0-1
  fadeIn?: number;
  fadeOut?: number;
}
export interface PrecompLayer extends LayerBase { type: 'precomp'; comp: string; timeOffset?: number; speed?: number }

export type Layer = SolidLayer | NullLayer | ShapeLayer | TextLayer | ImageLayer | VideoLayer | AudioLayer | PrecompLayer;
export type LayerType = Layer['type'];
// A layer before it has an id (Omit distributed over the union).
export type NewLayer = Layer extends infer L ? (L extends Layer ? Omit<L, 'id'> & {id?: string} : never) : never;

export interface Composition {
  id: string;
  name?: string;
  width: number;
  height: number;
  fps: number;
  duration: number;
  background?: Color;
  layers: Layer[]; // index 0 is the TOP layer, as in After Effects
  markers?: {t: number; label: string}[];
}

export interface Project {
  dtly: 1;
  name: string;
  root: string; // id of the comp that gets rendered
  fonts?: Record<string, string[]>; // family -> font file paths (relative to the project file)
  comps: Composition[];
}

export const isAnimated = <T>(p: Prop<T> | undefined): p is Animated<T> =>
  typeof p === 'object' && p !== null && !Array.isArray(p) && 'keyframes' in p;
