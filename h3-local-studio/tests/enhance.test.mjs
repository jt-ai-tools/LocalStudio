import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

async function enhancementModule() {
  const source = await readFile(new URL('../lib/enhance.ts', import.meta.url), 'utf8');
  const javascript = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext } }).outputText.replace('"./comfy"', JSON.stringify(new URL('../lib/comfy.ts', import.meta.url).href));
  return import(`data:text/javascript;base64,${Buffer.from(javascript).toString('base64')}`);
}

test('enhancement preserves source fps and separates LAB cache from saved works', async () => {
  const { buildEnhancementWorkflow } = await enhancementModule();
  const graph = buildEnhancementWorkflow({ sourceId: 'a'.repeat(32), inputFile: 'h3_enhance/source.mp4', outputWidth: 1296, outputHeight: 720 });
  assert.equal(graph['1'].inputs.file, 'h3_enhance/source.mp4');
  assert.deepEqual(graph['14'].inputs.fps, ['2', 2]);
  assert.equal(graph['13'].inputs.color_correction_method, 'lab');
  assert.equal(graph['3'].inputs['resize_type.height'], 720);
  assert.equal(graph['3'].inputs['resize_type.width'], 1296);
  assert.equal(graph['15'].inputs.filename_prefix, `h3_enhance_cache/${'a'.repeat(32)}`);
});

test('remixing uses cached source and AI result without submitting a new GPU prompt', async () => {
  const { blendEnhancement } = await enhancementModule();
  const previousFetch = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, init) => { calls.push([String(url), JSON.parse(init.body)]); return Response.json({ filename: 'mixed.mp4', enhancementStrength: 25 }); };
  try {
    const raw = { filename: 'cached.mp4', subfolder: 'h3_enhance_cache', type: 'output' };
    const result = await blendEnhancement({ sourceId: 'b'.repeat(32) }, raw, 25);
    assert.equal(result.enhancementStrength, 25);
    assert.equal(calls.length, 1);
    assert.equal(calls[0][0], 'http://127.0.0.1:8188/h3-studio/enhance/blend');
    assert.deepEqual(calls[0][1], { sourceId: 'b'.repeat(32), raw, strength: 25 });
    await blendEnhancement({ sourceId: 'b'.repeat(32) }, null, 0);
    assert.equal(calls[1][1].raw, null);
    assert.equal(calls[1][1].strength, 0);
  } finally { globalThis.fetch = previousFetch; }
});
