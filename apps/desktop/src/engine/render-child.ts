// Child process for exports: runs DT.ly's renderVideoParallel so the engine can cancel a render by killing
// this process tree (DT.ly's renderer has no abort signal). Forked with ELECTRON_RUN_AS_NODE under Electron.
import {dtlyNode} from './dtly.js';
import {configureFfmpeg} from './ffmpeg.js';

interface Job { project: string; out: string; workers?: number; crf?: number; comp?: string }
const send = (m: unknown) => process.send?.(m);

process.once('message', async (job: Job) => {
  try {
    configureFfmpeg();
    const {renderVideoParallel} = await dtlyNode();
    let last = 0;
    const r = await renderVideoParallel(job.project, job.out, {
      workers: job.workers, crf: job.crf, comp: job.comp,
      onProgress: (done, total) => { const now = Date.now(); if (now - last > 150 || done === total) { last = now; send({type: 'progress', done, total}); } },
    });
    send({type: 'done', result: r});
    process.exit(0);
  } catch (e) {
    send({type: 'error', message: (e as Error).message});
    process.exit(1);
  }
});
