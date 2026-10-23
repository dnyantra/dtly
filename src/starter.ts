// Starter projects for `dtly init`: media-free, so they render anywhere.
import type {Project} from './core/model.js';
import {addLayer, newProject} from './ops/ops.js';
import {PRESETS} from './presets/index.js';

export const STARTERS: Record<string, {description: string; build: (title: string) => Project}> = {
  opener: {
    description: 'Brand opener: ring burst, title, accent line, tagline (6 s, 9:16)',
    build: (title) => {
      const p = newProject({name: title, duration: 6, background: '#14110f'});
      PRESETS['opener.logoReveal'].apply(p, 'main', {title, tagline: 'MADE WITH DT.LY', position: [540, 900]});
      return p;
    },
  },
  kinetic: {
    description: 'Kinetic typography: phrases slam in one after another (5.5 s, 9:16)',
    build: (title) => {
      const p = newProject({name: title, duration: 5.5, background: '#101418'});
      addLayer(p, 'main', {type: 'shape', name: 'glow', shape: 'ellipse', size: [900, 900], fill: '#1f3b57', effects: [{type: 'blur', radius: 120}],
        transform: {position: [540, 960], scale: {keyframes: [{t: 0, v: [80, 80]}, {t: 5.5, v: [120, 120]}]}}}, 0);
      PRESETS['kinetic.sequence'].apply(p, 'main', {phrases: ['Make', 'motion', 'with words', title], emphasis: [title.split(' ')[0]], style: 'slam', start: 0.3});
      p.comps[0].duration = 5.5;
      return p;
    },
  },
  bars: {
    description: 'Colour bars sweep across and reveal a title (4 s, 9:16)',
    build: (title) => {
      const p = newProject({name: title, duration: 4, background: '#111111'});
      PRESETS['opener.bars'].apply(p, 'main', {title, start: 0.2});
      return p;
    },
  },
};
