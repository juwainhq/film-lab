/*
 * Local mask invariants: per-mask adjustments, the eight-mask cap, texture
 * packing, export parity plumbing and the apply-to-all rules.
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const scripts = [...html.matchAll(/<script(?![^>]*src)[^>]*>([\s\S]*?)<\/script>/g)].map(match => match[1]);
const appScript = scripts.join('\n');

test('the local mask panel exists with every control, cap label and progress indicator', () => {
  const ids = [
    'localMasksDetails', 'localMaskList', 'localMaskCount', 'localMaskEmpty', 'localMaskAdjust', 'localMaskSliders',
    'localMaskAddSubjectBtn', 'localMaskAddBackgroundBtn', 'localMaskAddLinearBtn', 'localMaskAddRadialBtn',
    'localMaskAddColorBtn', 'localMaskAddLuminanceBtn', 'localMaskAddBrushBtn', 'localMaskDuplicateBtn',
    'localMaskRenameBtn', 'localMaskApplyAllBtn', 'localMaskUndoBtn', 'localMaskRedoBtn', 'localMaskStatus',
    'localMaskProgress', 'localMaskProgressBar', 'localMaskProgressFill', 'localMaskProgressText', 'localMaskAdjustName',
  ];
  for (const id of ids) assert.ok(html.includes(`id="${id}"`), `missing ${id}`);
  assert.match(html, /<span class="maskBgSummaryHint" id="localMaskCount">0 \/ 8<\/span>/);
  // the round one mask layers panel stays untouched next to it
  for (const id of ['maskLayersDetails','maskLayerList','maskAddRadialBtn','maskOverlayBtn','downloadMaskBtn']) {
    assert.ok(html.includes(`id="${id}"`), `legacy ${id} must stay`);
  }
});

test('ten neutral adjustments cover the requested set and reset on double click', () => {
  const order = ['exposure','contrast','highlights','shadows','temperature','tint','saturation','clarity','sharpness','blur'];
  for (const id of order) assert.ok(appScript.includes(`{id:'${id}'`), `missing ${id}`);
  assert.match(appScript, /const LOCAL_ADJUSTMENTS=\[/);
  assert.match(appScript, /const LOCAL_MASK_LIMIT=8;/);
  assert.match(appScript, /input\.addEventListener\('dblclick',event=>\{event\.preventDefault\(\);localMaskResetAdjustment\(/);
  assert.match(appScript, /function localMaskResetAdjustment\(maskId,key\)\{/);
  // the default bag is neutral, so an untouched photo renders identically
  assert.match(appScript, /for\(const def of LOCAL_ADJUSTMENTS\) values\[def\.id\]=0;/);
  assert.match(appScript, /lastPreviewRenderKey=null;\n  if\(hasContent\) render\(performance\.now\(\)\);\n\}\nfunction localMaskResetAdjustment/);
});

test('the composite shader blends each mask after the grade and before the looks', () => {
  assert.match(appScript, /uniform sampler2D u_localMasksA; uniform sampler2D u_localMasksB;/);
  assert.match(appScript, /uniform float u_localMaskOn; uniform float u_localMaskCount;/);
  assert.match(appScript, /uniform vec4 u_localAdjustA\[8\]; uniform vec4 u_localAdjustB\[8\]; uniform vec4 u_localAdjustC\[8\];/);
  assert.match(appScript, /float localMaskAlpha\(int index,vec2 uv\)/);
  assert.match(appScript, /vec3 localAdjust\(vec3 col,vec4 pa,vec4 pb,vec4 pc,vec2 uv\)/);
  assert.match(appScript, /col=mix\(col,adjusted,clamp\(alpha,0\.0,1\.0\)\);/);
  const block = appScript.indexOf('if(u_localMaskOn>0.0){');
  const grain = appScript.indexOf('// Signed Amount inverts the same film-like pattern when negative.');
  const grade = appScript.indexOf('// Split tone by luminance, and lift or deepen only the darkest parts.');
  assert.ok(block > grade, 'local masks come after the global grade');
  assert.ok(block < grain, 'local masks come before grain, looks and dither');
  // a neutral mask is the exact identity
  assert.match(appScript, /if\(abs\(exposure\)>0\.0001\) col\*=exp2\(exposure\);/);
  assert.match(appScript, /if\(blur>0\.0001\)\{/);
});

test('mask alphas are packed four to a texture and uploaded only when a mask changes', () => {
  assert.match(appScript, /localMaskTextureA=gl\.createTexture\(\); localMaskTextureB=gl\.createTexture\(\);/);
  assert.match(appScript, /upload\(localMaskTextureA,gl\.TEXTURE6,build\(0\)\);/);
  assert.match(appScript, /upload\(localMaskTextureB,gl\.TEXTURE7,build\(4\)\);/);
  assert.match(appScript, /gl\.activeTexture\(gl\.TEXTURE6\); gl\.bindTexture\(gl\.TEXTURE_2D,localMaskTextureA\);/);
  assert.match(appScript, /gl\.uniform1i\(gl\.getUniformLocation\(progComposite,'u_localMasksA'\),6\);/);
  // a typed array upload keeps every channel: canvas sources are premultiplied
  assert.match(appScript, /gl\.texImage2D\(gl\.TEXTURE_2D,0,gl\.RGBA,width,height,0,gl\.RGBA,gl\.UNSIGNED_BYTE,data\);/);
  assert.ok(!/gl\.texImage2D\(gl\.TEXTURE_2D,0,gl\.RGBA,gl\.RGBA,gl\.UNSIGNED_BYTE,canvas\);\n\s*gl\.activeTexture\(gl\.TEXTURE0\);\n\s*window\.__filmLabDebug/.test(appScript));
  // sliders only refresh uniforms
  const slider = appScript.slice(appScript.indexOf('function localMaskSetAdjustment'), appScript.indexOf('function localMaskResetAdjustment'));
  assert.ok(!/uploadLocalMaskTextures|localMaskRebuildAlphas|texImage2D/.test(slider), 'slider moves must not touch textures');
  assert.match(slider, /lastPreviewRenderKey=null;/);
  // the frame keys include the local adjustments so the cache never hides a change
  assert.match(appScript, /localMaskRenderKey\(\),\n    isVideo\?videoGrainSeed/);
  assert.match(appScript, /localMaskRenderKey\(\),\n    strength,backgroundOnly/);
});

test('a mask owns its own layer stack and the eight mask cap is enforced', () => {
  assert.match(appScript, /adjustments:\{\.\.\.localMaskDefaults\(\),\.\.\.\(adjustments\|\|\{\}\)\},\n    selectedLayerId:null,\n    alpha:null,\n    stack:api\.createStack\(\{historyLimit:40\}\),/);
  assert.match(appScript, /if\(localMasks\.length>=LOCAL_MASK_LIMIT\)\{/);
  assert.match(appScript, /Up to \$\{LOCAL_MASK_LIMIT\} local masks per photo/);
  assert.match(appScript, /function localMaskAdoptStack\(stack\)\{/);
  // the mask layers panel edits the active mask's stack
  assert.match(appScript, /const activeLocal=localMaskActive\(\);\n  if\(activeLocal\) activeLocal\.selectedLayerId=maskLayerSelectedId;/);
});

test('mask and adjustment changes have their own undo history in front of the grade history', () => {
  assert.match(appScript, /function localMaskHistoryPush\(\)\{/);
  assert.match(appScript, /localMaskHistory\.push\(snapshot\);/);
  assert.match(appScript, /if\(localMaskHistory\.length>24\) localMaskHistory\.shift\(\);/);
  assert.match(appScript, /function localMaskStepHistory\(direction\)\{\n  return direction<0 \? localMaskUndo\(\) : localMaskRedo\(\);/);
  assert.match(appScript, /if\(localMaskCanCaptureKeyboard\(\)&&localMaskStepHistory\(historyStep\)\) return;/);
  assert.match(appScript, /function maskLayerAfterChange\(message\)\{\n  localMaskHistoryPush\(\);/);
  assert.match(appScript, /function localMaskReset\(reason='The photo changed'\)\{[\s\S]*?localMaskHistoryReset\(\);/);
});

test('masks are saved per photo and survive switching and carousel export', () => {
  assert.match(appScript, /function saveActiveMaskBackground\(\)\{\n  if\(!isVideo\) currentPhoto\.maskLocal=localMaskSave\(\);/);
  assert.match(appScript, /localMaskRestore\(item\?\.maskLocal\);/);
  assert.match(appScript, /const payload=Array\.isArray\(saved\)\?\{activeId:saved\[0\]\?\.id,masks:saved\}:\(saved&&Array\.isArray\(saved\.masks\)\?saved:null\);/);
  assert.match(appScript, /localMaskReset\('photo changed'\);/);
  // export renders through the same composite program, so preview and export agree
  assert.match(appScript, /localMaskRenderKey\(\),\n    isVideo\?videoGrainSeed:currentPhoto\?\.grainSeed\|\|0,renderAtFullResolution\]\.join\('\|'\);/);
});

test('apply to all copies values, re-runs automatic selections and warns about brush and pick', () => {
  assert.match(appScript, /async function applyLocalMasksToAllPhotos\(\)\{/);
  assert.match(appScript, /const targets=photos\.filter\(item=>item!==currentPhoto\);/);
  assert.match(appScript, /if\(layer\.type==='brush'\|\|layer\.type==='pick'\) continue;/);
  assert.match(appScript, /pendingDetection\.push\(\{layer:added,auto:true\}\);/);
  assert.match(appScript, /finding the subject/);
  assert.match(appScript, /localMaskProgress\(true,\(index\+1\)\/targets\.length/);
  assert.match(appScript, /Brush or Pick object layer\$\{skippedBrush===1\?'':'s'\} could not be copied — brush strokes and picked objects are specific to each photo\./);
  assert.match(appScript, /const detected=await localMaskDetectAlpha\(\);/);
  assert.match(appScript, /await withTimeout\(ensureMaskBgModel\(\),90000,'AI model loading timed out after 90 seconds'\);/);
  assert.match(appScript, /await withTimeout\(requestMaskBgWorker\('segment',\{image,width,height\}\),30000,'Image segmentation timed out after 30 seconds'\);/);
  assert.match(appScript, /on\('localMaskApplyAllBtn',applyLocalMasksToAllPhotos\);/);
});

test('local masks keep round one background behaviour: only the panel in use cuts the background out', () => {
  assert.match(appScript, /let maskBgSurfaceLocal=false, maskBgUserEngaged=false;/);
  assert.match(appScript, /function maskBgReplaceActive\(\)\{ return !\(maskBgSurfaceLocal && !maskBgUserEngaged\); \}/);
  assert.match(appScript, /\&\& !!maskBgCanvas \&\& maskBgReplaceActive\(\);/);
  assert.match(appScript, /document\.addEventListener\('pointerdown',maskBgTrackSurface,true\);/);
  assert.match(appScript, /localOnly:maskBgSurfaceLocal&&!maskBgUserEngaged,/);
  assert.match(appScript, /if\(saved\.localOnly\)\{maskBgUserEngaged=false;maskBgSurfaceLocal=true;\}/);
  // legacy mask surfaces still mark themselves as background work
  assert.match(appScript, /if\(target\.closest\('#localMasksDetails'\)\) maskBgMarkLocalSurface\(\);/);
  assert.match(appScript, /else if\(target\.closest\('#maskLayersDetails,#maskBackgroundDetails'\)\) maskBgMarkLegacySurface\(\);/);
  assert.match(appScript, /function maskBgMarkLegacySurface\(\)\{ maskBgUserEngaged=true; maskBgSurfaceLocal=false; \}/);
  assert.match(appScript, /function ensureMaskBgBase\(mode\)\{\n  if\(maskBgActive\) return;/);
});

test('the service worker ships the new build and no removed assets', () => {
  const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
  assert.match(sw, /const CACHE = 'filmlab-v9';/);
  assert.match(sw, /mask-stack\.js/);
  assert.ok(!sw.includes('vendor/transformers'), 'the transformers bundle is not committed');
});
