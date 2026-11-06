import fs from 'node:fs';
import path from 'node:path';
import {describe, expect, it} from 'vitest';
import {checkRelativeSources, createProject, duplicateProject, findLinkedProject, listProjects, openProjectDir, renameProject, safeFolderName, writeLink} from '../src/engine/projects.js';
import {compareVersions, redact} from '../src/shared/misc.js';
import {parseDeepLink} from '../src/main/deeplink.js';
import {tmpDir} from './helpers.js';

describe('project folders (D3)', () => {
  it('creates the exact layout', () => {
    const root = tmpDir('proj');
    const dir = createProject({name: 'KK Park: Launch / Reel', preset: 'reel', root});
    expect(path.basename(dir)).toBe('KK Park Launch Reel');
    for (const f of ['project.json', 'sources.json', 'analysis.json']) expect(fs.existsSync(path.join(dir, f))).toBe(true);
    for (const d of ['media', 'vo', 'music', 'director', 'renders']) expect(fs.statSync(path.join(dir, d)).isDirectory()).toBe(true);
    const p = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'));
    expect(p).toMatchObject({dtly: 1, root: 'main', comps: [{width: 1080, height: 1920}]});
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'sources.json'), 'utf8'))).toEqual({version: 1, sources: []});
  });

  it('dedupes names, lists newest first, renames and duplicates without the link', () => {
    const root = tmpDir('proj');
    const a = createProject({name: 'Reel', root});
    const b = createProject({name: 'Reel', root, preset: 'square'});
    expect(path.basename(b)).toBe('Reel 2');
    fs.utimesSync(path.join(a, 'project.json'), new Date(), new Date(Date.now() + 5000));
    expect(listProjects({root}).map((s) => path.basename(s.dir))).toEqual(['Reel', 'Reel 2']);
    const renamed = renameProject(b, 'Square promo');
    expect(path.basename(renamed)).toBe('Square promo');
    expect(JSON.parse(fs.readFileSync(path.join(renamed, 'project.json'), 'utf8')).name).toBe('Square promo');
    writeLink(renamed, {orgId: 3, projectId: 42, rev: 5});
    expect(findLinkedProject(42, {root})?.dir).toBe(renamed);
    const copy = duplicateProject(renamed, 'Square promo (desktop copy)');
    expect(fs.existsSync(path.join(copy, '.customerpro.json'))).toBe(false);
    expect(openProjectDir(copy).linked).toBe(false);
  });

  it('rejects non-relative sources', () => {
    const bad = checkRelativeSources({comps: [{layers: [{src: 'media/a.mp4'}, {src: '/Users/x/raw.mov'}, {src: '../footage/x.mp4'}, {src: 'media/../../x'}, {src: 'https://cdn/x.png'}, {src: 'vo/line1.wav'}]}]});
    expect(bad).toEqual(['/Users/x/raw.mov', '../footage/x.mp4', 'media/../../x']);
    expect(safeFolderName('  a<b>:c.  ')).toBe('a b c');
  });
});

describe('small utilities', () => {
  it('parses customerpro-video:// links', () => {
    expect(parseDeepLink('customerpro-video://open?project=123&org=9')).toEqual({action: 'open', project: '123', org: '9'});
    expect(parseDeepLink('customerpro-video://open/?project=ab-1')).toEqual({action: 'open', project: 'ab-1', org: undefined});
    expect(parseDeepLink('customerpro-video://delete?project=1')).toBeUndefined();
    expect(parseDeepLink('customerpro-video://open?project=../../etc')).toBeUndefined();
    expect(parseDeepLink('https://open?project=1')).toBeUndefined();
  });
  it('compares versions and redacts tokens', () => {
    expect(compareVersions('0.10.0', '0.9.9')).toBe(1);
    expect(compareVersions('1.0.0', '1.0')).toBe(0);
    expect(redact('Authorization: Bearer 12|abcDEF.xyz')).toBe('Authorization: Bearer [redacted]');
    expect(redact('{"token":"12|secret","x":1}')).toBe('{"token":"[redacted]","x":1}');
    expect(redact('https://r2/x?X-Amz-Signature=abc123&a=1')).toBe('https://r2/x?X-Amz-Signature=[redacted]&a=1');
  });
});
