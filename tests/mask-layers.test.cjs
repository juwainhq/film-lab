/* Guards for the Lightroom-style mask layer system: the new surface exists, the
   legacy mask tools are still present, and the offline/progressive-load plumbing
   (MIME types, staging, service worker) covers the new files. */
const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync, existsSync} = require('node:fs');
const {resolve} = require('node:path');

const root = resolve(__dirname, '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
const styles = html.split('<style>')[1].split('</style>')[0];
const worker = readFileSync(resolve(root, 'mask-segmentation-worker.js'), 'utf8');
const proWorker = readFileSync(resolve(root, 'mask-pro-worker.mjs'), 'utf8');
const serviceWorker = readFileSync(resolve(root, 'sw.js'), 'utf8');
const electron = readFileSync(resolve(root, 'electron/main.js'), 'utf8');
const stage = readFileSync(resolve(root, 'scripts/stage-web.cjs'), 'utf8');
const stack = require(resolve(root, 'mask-stack.js'));

test('the mask stack exposes the full layer engine as a UMD module', () => {
  for (const name of ['createAlpha','mergeAlpha','invertAlpha','blurMask','smoothMask','expandContract','guidedFilter',
    'linearGradientMask','radialGradientMask','luminanceRangeMask','colorRangeMask','resizeMask','softmaxRow',
    'multiclassForeground','edgeForegroundEstimate','layerAlpha','compositeLayers','defaultParams','createStack']) {
    assert.equal(typeof stack[name], 'function', name);
  }
  assert.deepEqual([...stack.LAYER_TYPES], ['subject','background','pick','brush','linear','radial','luminance','color']);
  assert.deepEqual([...stack.OPERATIONS], ['add','subtract','intersect']);
  assert.equal(typeof stack.TYPE_LABELS.background, 'string');
});

test('every layer type is reachable from the Mask tab and the overlay keeps its own canvas', () => {
  for (const id of ['maskLayersDetails','maskLayerList','maskLayerCount','maskLayerEmpty','maskLayerSettings',
    'maskAddSubjectBtn','maskAddBackgroundBtn','maskAddPickBtn','maskAddLinearBtn','maskAddRadialBtn',
    'maskAddLuminanceBtn','maskAddColorBtn','maskAddBrushBtn','maskLayerUndoBtn','maskLayerRedoBtn',
    'maskOverlayBtn','maskOverlayCanvas','maskQualityDetails','maskRefineDetails','maskSmoothRange',
    'maskEdgeRefineToggle','maskEdgeRadius','maskEdgeStrength','maskEdgeCleanupToggle','downloadMaskBtn']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  assert.match(html, /id="maskOverlayCanvas" aria-hidden="true"/);
  assert.match(styles, /#maskOverlayCanvas \{[^}]*pointer-events: none/);
  assert.match(script, /maskLayerToggleOverlay/);
  assert.match(script, /e\.key\.toLowerCase\(\)==='o'\s*&&\s*appState\.mode==='photo'/);
});

test('legacy mask tools and ids are untouched so the old workflows still run', () => {
  for (const id of ['autoRemoveBackgroundBtn','magicSelectBtn','maskBgPaintBtn','maskBgEraseBtn','finishMaskBgEditBtn',
    'undoMaskBgBtn','resetMaskBackgroundBtn','applyMaskBackgroundBtn','maskBgFeather','maskBgExpand','maskBgInvert',
    'maskBgBrushSize','maskBgHardness','maskBgImageInput']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  for (const mode of ['transparent','color','blur','image','gradient']) {
    assert.match(html, new RegExp(`name="maskBgMode" value="${mode}"`), mode);
  }
  for (const fn of ['function beginMaskBgStroke(event)','function paintMaskBackground(event)','function magicSelectMask(point)',
    'function rebuildMaskBackgroundCanvas()','function uploadMaskBackground()','function clearMaskBackground()',
    'function autoRemoveMaskBackground()','function ensureMaskBgWorker()','function withTimeout(promise,ms,message)']) {
    assert.ok(script.includes(fn), fn);
  }
  assert.match(script, /maskBgAutoCanvas=maskLayerRasterFromAlpha\(alpha,width,height\)/);
  assert.match(script, /maskBgAutoCanvas=saved\.auto\|\|null/);
});

test('layer geometry, blend operations and refinement stay wired to the composite', () => {
  assert.match(script, /api\.compositeLayers\(maskStack\.layers,width,height,maskLayerSourceRgba\(\)\)/);
  assert.match(script, /\[\[('add','Add'),('subtract','Subtract'),('intersect','Intersect')\]\]|\[\['add','Add'\],\['subtract','Subtract'\],\['intersect','Intersect'\]\]/);
  assert.match(script, /maskLayerDrag=\{id:event\.pointerId,handle,layerId:layer\.id,start:point,origin:\{\.\.\.layer\.params\}\}/);
  assert.match(script, /edgeRefine:maskRefineSettings\.edgeRefine&&reason==='ai'/);
  assert.match(script, /maskLayerRequestRefine\('ai'\)/);
  assert.match(script, /requestMaskBgWorker\('refine',\{mask,width,height,options\}\)/);
  assert.match(script, /requestMaskBgWorker\('foreground',\{mask:sized,width:maskWidth,height:maskHeight,radius:maskCleanSettings\.radius\}\)/);
  assert.match(script, /maskBgBrushPreview/);
  assert.match(script, /autoMask:!!layer\.params\.autoMask/);
});

test('the segmentation worker speaks the new protocol and keeps the pinned MediaPipe bootstrap', () => {
  for (const message of ['init','init-pick','segment','pick','source','refine','foreground','composite']) {
    assert.match(worker, new RegExp(`case '${message}':`), message);
  }
  assert.match(worker, /new URL\('vendor\/mediapipe-tasks\/', self\.location\.href\)\.href/);
  assert.match(worker, /self\.Vision \|\| self\.vision \|\| self/);
  assert.match(worker, /InteractiveSegmenterLegacy/);
  assert.match(worker, /InteractiveSegmenter\.createFromOptions/);
  assert.match(worker, /keypoint: \{x: point\.x, y: point\.y\}/);
  assert.match(worker, /selfie_multiclass_256x256\.onnx/);
  assert.match(worker, /edgeForegroundEstimate/);
  assert.doesNotMatch(worker, /ModelLoader/);
  assert.doesNotMatch(worker, /^\s*import\s/m);
  assert.doesNotMatch(worker, /^\s*export\s/m);
});

test('the Pro engine is an opt-in module worker with caching, progress and cancel', () => {
  assert.match(proWorker, /new Worker|self\.addEventListener\('message'/);
  assert.match(html, /new Worker\(new URL\('mask-pro-worker\.mjs',document\.baseURI\),\{type:'module'\}\)/);
  assert.match(proWorker, /onnx-community\/BiRefNet_lite/);
  assert.match(proWorker, /@huggingface\/transformers@\$\{TRANSFORMERS_VERSION\}/);
  assert.match(proWorker, /vendor\/transformers\/transformers\.web\.min\.js/); // local copy wins when present
  assert.match(proWorker, /const TRANSFORMERS_VERSION = '4\.3\.0'/);
  assert.match(proWorker, /fp16/);
  assert.match(proWorker, /fp32/);
  assert.match(proWorker, /caches\.open/);
  assert.match(proWorker, /case 'purge'/);
  assert.match(proWorker, /case 'cancel'/);
  assert.match(script, /MASK_PRO_BYTES=\{webgpu:115\*1024\*1024,wasm:224\*1024\*1024\}/);
  assert.match(script, /maskProShowProgress\(data\.loaded\/data\.total/);
  assert.match(script, /function maskEngineFallback\(mode,reason\)/);
  assert.match(script, /maskProRemoveVisible\(true\)/);
  assert.doesNotMatch(html + proWorker + worker, /imgly|background-removal/);
});

test('the shell ships the new files offline: MIME types, staging and service worker', () => {
  assert.match(electron, /'\.task': 'application\/octet-stream'/);
  assert.match(electron, /'\.onnx': 'application\/octet-stream'/);
  assert.match(electron, /'\.mjs': 'text\/javascript; charset=utf-8'/);
  // The staging step mirrors the repository root, so vendor/ (models, ORT, transformers)
  // and the new mask files ship with the native bundle; only scratch dirs are skipped.
  assert.match(stage, /const SKIP = new Set\(\[/);
  assert.doesNotMatch(stage, /^\s*'vendor',$/m);
  assert.doesNotMatch(stage, /^\s*'mask-stack\.js',$/m);
  assert.match(stage, /'\.arena-tmp',/);
  assert.match(serviceWorker, /const CACHE = 'filmlab-v11';/);
  assert.match(serviceWorker, /'mask-stack\.js'/);
  assert.match(serviceWorker, /'mask-pro-worker\.mjs'/);
  assert.match(serviceWorker, /path\.includes\('onnxruntime-web'\)/);
  assert.match(serviceWorker, /path\.includes\('mask-stack\.js'\)/);
  for (const asset of ['mask-stack.js','mask-pro-worker.mjs','mask-segmentation-worker.js','vendor/onnxruntime-web/ort.min.js',
    'vendor/models/selfie_multiclass_256x256.onnx','vendor/transformers/LICENSE','vendor/transformers/README.md',
    'vendor/mediapipe-tasks/vision_bundle.js']) {
    assert.ok(existsSync(resolve(root, asset)), asset);
  }
});
