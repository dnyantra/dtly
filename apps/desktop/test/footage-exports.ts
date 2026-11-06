export {addSegmentLayer, analysePass1, contactSheet, extractAudio, segmentPrepare} from '../src/engine/footage.js';
// The layer added by "Add to timeline" keeps sources relative (valid on the web too).
import {checkRelativeSources} from '../src/engine/projects.js';
export const previewSafe = (p: any) => checkRelativeSources(p).length === 0;
