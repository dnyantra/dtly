import type {TextAnimator} from '../core/model.js';

// Text animator presets — the "Animation Presets > Text" folder of DT.ly.
export const TEXT_ANIMATORS: Record<string, {description: string; animators: TextAnimator[]}> = {
  typewriter: {description: 'Letters appear one by one with no motion.', animators: [{unit: 'grapheme', stagger: 0.05, duration: 0.01, ease: 'hold', from: {opacity: 0}}]},
  fadeUp: {description: 'Words fade in while rising slightly. Calm, readable default.', animators: [{unit: 'word', stagger: 0.08, duration: 0.6, ease: 'cubicOut', from: {opacity: 0, y: 40}}]},
  popIn: {description: 'Words scale up from zero with an overshoot. Playful, energetic.', animators: [{unit: 'word', stagger: 0.1, duration: 0.55, ease: 'backOut', from: {opacity: 0, scale: 0}}]},
  slam: {description: 'Words crash in from huge and blurred. Punchy kinetic typography.', animators: [{unit: 'word', stagger: 0.18, duration: 0.35, ease: 'expoOut', from: {opacity: 0, scale: 320, blur: 14}}]},
  blurIn: {description: 'Letters sharpen from a blur. Elegant, premium.', animators: [{unit: 'grapheme', stagger: 0.03, duration: 0.7, ease: 'cubicOut', from: {opacity: 0, blur: 18, x: -20}}]},
  maskedLines: {description: 'Each line slides up from behind its own mask. The classic title reveal.', animators: [{unit: 'line', stagger: 0.12, duration: 0.8, ease: 'expoOut', clip: true, from: {y: 120}}]},
  cascade: {description: 'Letters drop and rotate into place with an overshoot.', animators: [{unit: 'grapheme', stagger: 0.035, duration: 0.7, ease: 'backOut', from: {opacity: 0, y: -70, rotation: -25}}]},
  trackingIn: {description: 'Letter spacing collapses from wide to normal while fading in. Cinematic openers.', animators: [{unit: 'grapheme', stagger: 0, duration: 1.4, ease: 'expoOut', from: {opacity: 0, tracking: 60}}]},
  centerOut: {description: 'Letters grow outward from the middle of the word.', animators: [{unit: 'grapheme', order: 'center', stagger: 0.04, duration: 0.5, ease: 'backOut', from: {opacity: 0, scale: 0}}]},
  randomFlicker: {description: 'Letters switch on in random order.', animators: [{unit: 'grapheme', order: 'random', stagger: 0.03, duration: 0.08, ease: 'hold', from: {opacity: 0}}]},
  colorSweep: {description: 'A highlight colour sweeps through the letters, settling to the text colour.', animators: [{unit: 'grapheme', stagger: 0.04, duration: 0.5, ease: 'easeOut', from: {color: '#FFC93C', scale: 115}}]},
  // Exits (mode: out) end at the layer's outPoint.
  fadeOutDown: {description: 'Exit: words fade out while dropping.', animators: [{unit: 'word', mode: 'out', stagger: 0.05, duration: 0.4, ease: 'easeIn', from: {opacity: 0, y: 40}}]},
  blurOut: {description: 'Exit: letters blur away.', animators: [{unit: 'grapheme', mode: 'out', stagger: 0.02, duration: 0.45, ease: 'easeIn', from: {opacity: 0, blur: 16}}]},
  maskedLinesOut: {description: 'Exit: lines slide up out of their masks.', animators: [{unit: 'line', mode: 'out', stagger: 0.08, duration: 0.5, ease: 'expoInOut', clip: true, from: {y: -120}}]},
};
