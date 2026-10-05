const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const {runInNewContext} = require('node:vm');

const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
const styles = html.split('<style>')[1].split('</style>')[0];
const composite = script.match(/const fsComposite=`([\s\S]*?)`;/)[1];

test('Mask & Background is a collapsible photo-only sidebar tab between Adjust and Export', () => {
  const adjust = html.indexOf('id="adjustTab"');
  const mask = html.indexOf('id="maskTab"');
  const exportTab = html.indexOf('id="exportTab"');
  assert.ok(adjust < mask && mask < exportTab);
  assert.match(html, /class="sidebarTab photo-only" id="maskTab"[^>]*data-tab="mask"/);
  assert.match(html, /class="sidebarPanel photo-only" id="maskPanel" data-panel="mask"/);
  assert.match(html, /<details class="maskBackgroundDetails" id="maskBackgroundDetails" open>/);
  assert.match(html, /body\[data-mode="video"\] \.photo-only \{ display: none !important; \}/);
  assert.match(script, /if\(name==='mask'&&appState\.mode!=='photo'\)return/);
  assert.match(script, /if\(name==='mask'\)loadMaskBgModelOnOpen\(\)/);
  assert.match(styles, /\.maskBackgroundDetails > summary/);
});

test('the feature exposes automatic removal, magic select, paint/erase, refinement, and five background types', () => {
  for (const id of ['autoRemoveBackgroundBtn','magicSelectBtn','maskBgPaintBtn','maskBgEraseBtn','maskBgFeather','maskBgExpand','maskBgInvert','applyMaskBackgroundBtn']) {
    assert.match(html, new RegExp(`id="${id}"`), id);
  }
  for (const mode of ['transparent','color','blur','image','gradient']) {
    assert.match(html, new RegExp(`name="maskBgMode" value="${mode}"`), mode);
  }
  assert.match(script, /function magicSelectMask\(point\)/);
  assert.match(script, /function beginMaskBgStroke\(event\)/);
  assert.match(script, /function autoRemoveMaskBackground\(\)/);
});

test('masking composes after the existing color grade and preserves alpha for transparent PNG output', () => {
  for (const uniform of ['u_maskBackground','u_backgroundImage','u_maskEnabled','u_backgroundMode','u_maskFeatherPixels','u_maskExpandPixels','u_maskInvert']) {
    assert.match(composite, new RegExp(`\\b${uniform}\\b`), uniform);
  }
  assert.match(composite, /if\(u_maskEnabled==1\)/);
  // Alpha still comes from the mask in transparent mode; the foreground colour is now
  // routed through the edge-cleanup estimate before it is mixed with the background.
  assert.match(composite, /u_backgroundMode==1\)\{ outColor=vec4\(foreground,base\.a\*keepAlpha\); return; \}/);
  assert.match(composite, /outColor=vec4\(mix\(background,foreground,keepAlpha\),1\.0\)/);
  assert.match(composite, /uniform sampler2D u_cutout; uniform float u_cleanupStrength;/);
  assert.match(composite, /float band=1\.0-abs\(keepAlpha\*2\.0-1\.0\);/);
  assert.match(script, /const maskBgEnabled=appState\.mode==='photo' && !isVideo && !!maskBgActive/);
  assert.match(script, /if\(!needsTransparentMaskPng\(\)\|\|exportOptions\.type==='png'\)return false/);
  assert.match(script, /hasTransparentMask\?\'png\':exportOptions\.type/);
});

test('selfie multiclass segmentation runs in its photo-only worker with separate model-load and inference timeouts', () => {
  const worker = readFileSync(resolve(__dirname, '../mask-segmentation-worker.js'), 'utf8');
  const autoRemove = script.match(/async function autoRemoveMaskBackground\(\)[\s\S]*?\n\}/)[0];
  const fastEngine = script.match(/function maskEngineRunFast\(redetect=false\)\{[\s\S]*?\n\}/)[0];
  assert.match(script, /script\.src='vendor\/mediapipe-selfie\/selfie_segmentation\.js'/); // preserve Dither's existing local model
  assert.match(script, /function loadMaskBgModelOnOpen\(\)[\s\S]*?activeSidebarTab!=='mask'/);
  assert.match(script, /new Worker\(new URL\('mask-segmentation-worker\.js',document\.baseURI\)\)/);
  assert.match(script, /function withTimeout\(promise,ms,message\)/);
  assert.match(script, /function maskEngineRunFast\(redetect=false\)\{/);
  assert.match(autoRemove, /maskEngineRunFast\(false\)/);
  assert.match(fastEngine, /if\(!maskBgPhotoReady\(\)\) return;/);
  assert.match(fastEngine, /withTimeout\(ensureMaskBgModel\(\),90000,/);
  assert.match(fastEngine, /requestMaskBgWorker\('segment',\{image,width,height\}\),30000,/);
  assert.match(fastEngine, /if\(error\?\.name==='TimeoutError'\) ?terminateMaskBgWorker\(error,'error'\)/);
  assert.match(fastEngine, /const failure=`Auto-remove failed: \$\{maskLayerErrorMessage\(error\)\}\. Try Magic select or Paint \/ keep\.`/);
  assert.match(fastEngine, /maskBgProcessing=false/);
  assert.doesNotMatch(fastEngine, /8000|8 seconds/);
  assert.match(script, /setMaskBgAiStatus\('Analyzing image…',true,true\)/);
  assert.match(script, /setMaskBgStatus\('Subject selected — refine edges with the brush or the Refine controls'\)/);
  assert.match(worker, /report\('Analyzing image…'\)/);
  assert.match(html, /class="engineSpinner" aria-hidden="true"/);
  assert.match(worker, /@mediapipe\/tasks-vision@1\.0\.1/);
  assert.match(worker, /TASKS_VISION_CDN_WASM_URL = TASKS_VISION_CDN_BASE \+ 'wasm'/);
  assert.match(worker, /selfie_multiclass_256x256/);
  assert.match(worker, /ImageSegmenter\.createFromOptions/);
  assert.match(worker, /baseOptions: \{modelAssetPath\}/);
  assert.match(worker, /self\.postMessage\(\{type: 'result'/);
  assert.doesNotMatch(autoRemove, /https?:\/\//);
});

test('withTimeout rejects with a named timeout and clears its active timer', async () => {
  const helper = script.match(/function withTimeout\(promise,ms,message\)\{[\s\S]*?\n\}/)[0];
  const context = {maskBgAutoTimeout: null, setTimeout, clearTimeout};
  const timed = runInNewContext(`${helper}; withTimeout(new Promise(resolve=>setTimeout(resolve,40)),1,'model timed out')`, context);
  await assert.rejects(timed, error => error.name === 'TimeoutError' && error.message === 'model timed out');
  assert.equal(context.maskBgAutoTimeout, null);
});

test('the 2x mask worker smooth-thresholds, erodes, blurs, downsamples, and returns an alpha-ready grayscale mask', () => {
  const worker = readFileSync(resolve(__dirname, '../mask-segmentation-worker.js'), 'utf8');
  assert.match(worker, /value <= 0\.3/);
  assert.match(worker, /value >= 0\.7/);
  assert.match(worker, /targetWidth \* 2/);
  assert.match(worker, /erodeMask\(highResolution, width, height, 2\)/);
  assert.equal(worker.match(/boxBlurPass\(refined, width, height, 2\)/g)?.length, 2);
  assert.match(worker, /output\[y \* targetWidth \+ x\] = Math\.round/);
});

test('mask brush supports 20px diameter, hardness, live cursor, and connected Shift-click fill', () => {
  assert.match(html, /id="maskBgBrushSize" min="4" max="140" value="20"/);
  assert.match(html, /id="maskBgHardness" min="0" max="100" value="65"/);
  assert.match(html, /id="maskBrushCursor"/);
  assert.match(script, /function updateMaskBrushCursor\(event\)/);
  assert.match(script, /function floodFillMaskBackground\(point,mode\)/);
  assert.match(script, /if\(e\.shiftKey&&\(maskBgPaintMode==='paint'\|\|maskBgPaintMode==='erase'\)/);
  assert.match(script, /const softness=1-maskBgSettings\.hardness\/100/);
});

test('background blur is a real local StackBlur pass and export waits for the requested 2–40px result', () => {
  const blurWorker = readFileSync(resolve(__dirname, '../background-blur-worker.js'), 'utf8');
  assert.match(html, /id="maskBgBlur" min="2" max="40" value="24"/);
  assert.match(script, /new Worker\(new URL\('background-blur-worker\.js',document\.baseURI\)\)/);
  assert.match(script, /function prepareMaskBgBlurForExport\(\)/);
  assert.match(script, /await prepareMaskBgBlurForExport\(\)/);
  const blurRequest = script.match(/function requestMaskBgBlur\(immediate=false\)\{[\s\S]*?\n\}/)[0];
  assert.match(blurRequest, /const complete=result=>\{if\(!settled\)\{settled=true;resolveCompletion\(result\);\}\}/);
  assert.match(blurRequest, /if\(maskBgBlurResolve===complete\)maskBgBlurResolve=null/);
  assert.match(blurWorker, /function stackBlurImageData/);
  assert.match(blurWorker, /radius \+ 1/);
  assert.doesNotMatch(composite, /texture\(u_base,maskUv\+vec2/);
  assert.match(composite, /u_backgroundMode==3\)\{\s*background=texture\(u_backgroundImage,maskUv\)\.rgb/);
});

test('the local StackBlur worker produces radius-2 triangular blur pixels', () => {
  const blurWorker = readFileSync(resolve(__dirname, '../background-blur-worker.js'), 'utf8');
  const context = {self: {addEventListener() {}}};
  runInNewContext(blurWorker, context);
  const values = [0, 50, 100, 150, 200];
  const imageData = {data: new Uint8ClampedArray(values.flatMap(value => [value, value, value, 255]))};
  context.stackBlurImageData(imageData, values.length, 1, 2);
  assert.deepEqual(Array.from(imageData.data).filter((_, index) => index % 4 === 0), [22, 56, 100, 144, 178]);
  assert.deepEqual(Array.from(imageData.data).filter((_, index) => index % 4 === 3), [255, 255, 255, 255, 255]);
});

test('photo mask state is saved per carousel item and Mask & Background settings round-trip with presets', () => {
  assert.match(script, /currentPhoto\.maskBackground=maskBgCanvas[\s\S]*?active:maskBgActive/);
  assert.match(script, /function restoreMaskBackgroundForPhoto\(item\)/);
  assert.match(script, /restoreMaskBackgroundForPhoto\(item\)/);
  assert.match(script, /values\.MaskBackground=getMaskBackgroundPresetSettings\(true\)/);
  assert.match(script, /if\(values\.MaskBackground&&appState\.mode==='photo'\)applyMaskBackgroundPresetSettings\(values\.MaskBackground\)/);
  assert.match(script, /restoreMaskBgPresetSnapshot\(maskSnapshot\)/);
});
