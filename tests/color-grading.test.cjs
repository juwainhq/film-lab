'use strict';

const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const grading = require('../color-grading.js');

const root = resolve(__dirname, '..');
const html = readFileSync(resolve(root, 'index.html'), 'utf8');
const serviceWorker = readFileSync(resolve(root, 'sw.js'), 'utf8');
const styles = [...html.matchAll(/<style\b[^>]*>([\s\S]*?)<\/style>/gi)].map(match => match[1]).join('\n');
const appScript = [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
  .map(match => match[1]).find(source => source.includes('function render(timeMs)')) || '';
const gradeShader = appScript.match(/const fsColorGrade=`([\s\S]*?)`;/)?.[1] || '';

test('tone curve lookup is a neutral 256-sample RGBA-ready identity curve', () => {
  const identity = [{x: 0, y: 0}, {x: 1, y: 1}];
  const samples = grading.monotoneCurveSamples(identity, 256);
  assert.equal(samples.length, 256);
  assert.deepEqual([...samples], Array.from({length: 256}, (_, index) => index));
  assert.equal(samples[0], 0);
  assert.equal(samples[255], 255);
  assert.equal(grading.isIdentityCurve(identity), true);
  assert.equal(grading.isIdentityCurve([{x: 0, y: 0}, {x: .5, y: .5}, {x: 1, y: 1}]), false);
});

test('monotone cubic curve samples stay between neighboring points without overshoot', () => {
  const points = [
    {x: 0, y: 0}, {x: .2, y: .18}, {x: .48, y: .82},
    {x: .73, y: .42}, {x: 1, y: 1}
  ];
  const samples = grading.monotoneCurveSamples(points, 256);
  let segment = 0;
  for (let index = 0; index < samples.length; index++) {
    const x = index / 255;
    while (segment < points.length - 2 && x > points[segment + 1].x) segment++;
    const low = Math.min(points[segment].y, points[segment + 1].y) - 1 / 255;
    const high = Math.max(points[segment].y, points[segment + 1].y) + 1 / 255;
    assert.ok(samples[index] / 255 >= low && samples[index] / 255 <= high, `no overshoot at sample ${index}`);
  }
  assert.equal(samples[0], 0);
  assert.equal(samples[255], 255);
  for (let part = 0; part < points.length - 1; part++) {
    const start = Math.ceil(points[part].x * 255), end = Math.floor(points[part + 1].x * 255);
    const direction = Math.sign(points[part + 1].y - points[part].y);
    for (let index = start + 1; index <= end; index++) {
      const difference = samples[index] - samples[index - 1];
      assert.ok(direction >= 0 ? difference >= 0 : difference <= 0, `monotone segment ${part}, sample ${index}`);
    }
  }
});

test('curve samples clamp malformed points and remain finite with repeated x coordinates', () => {
  const samples = grading.monotoneCurveSamples([
    {x: 0, y: -2}, {x: .5, y: .2}, {x: .5, y: .9}, {x: 1, y: 4}, {x: NaN, y: NaN}
  ]);
  assert.equal(samples.length, 256);
  assert.ok([...samples].every(value => Number.isInteger(value) && value >= 0 && value <= 255));
  assert.equal(samples[0], 0);
  assert.equal(samples[255], 255);
});

test('histogram Auto returns bounded exposure, contrast, whites and blacks and ignores transparent pixels', () => {
  const neutral = new Uint8ClampedArray([128, 128, 128, 255, 128, 128, 128, 255]);
  const auto = grading.autoAdjustFromPixels({data: neutral});
  assert.deepEqual(Object.keys(auto).sort(), ['blacks', 'contrast', 'exposure', 'percentiles', 'whites']);
  assert.ok(auto.exposure >= -1.5 && auto.exposure <= 1.5);
  assert.ok(auto.contrast >= -35 && auto.contrast <= 35);
  assert.ok(auto.whites >= -30 && auto.whites <= 30);
  assert.ok(auto.blacks >= -30 && auto.blacks <= 30);
  assert.equal(auto.percentiles.length, 4);
  assert.ok(grading.autoAdjustFromPixels(new Uint8ClampedArray([20, 20, 20, 255])).exposure > 0);
  assert.ok(grading.autoAdjustFromPixels(new Uint8ClampedArray([235, 235, 235, 255])).exposure < 0);
  assert.deepEqual(grading.autoAdjustFromPixels(new Uint8ClampedArray([0, 0, 0, 0])), {
    exposure: 0, contrast: 0, whites: 0, blacks: 0, percentiles: [0, 0, 0, 0]
  });
});

test('3D .cube LUT parser accepts identity cubes and supported sizes, and reports malformed or unsupported files clearly', () => {
  const makeCube = (size, rows) => `TITLE "Identity test"\nLUT_3D_SIZE ${size}\nDOMAIN_MIN 0 0 0\nDOMAIN_MAX 1 1 1\n${rows}`;
  const size = 17, identityRows = [];
  for (let blue = 0; blue < size; blue++) for (let green = 0; green < size; green++) for (let red = 0; red < size; red++) {
    identityRows.push(`${(red / (size - 1)).toFixed(6)} ${(green / (size - 1)).toFixed(6)} ${(blue / (size - 1)).toFixed(6)}`);
  }
  const lut = grading.parseCubeLut(makeCube(size, identityRows.join('\n')));
  assert.equal(lut.size, 17);
  assert.equal(lut.data.length, 17 ** 3 * 4);
  assert.deepEqual([...lut.data.slice(0, 4)], [0, 0, 0, 255]);
  assert.deepEqual([...lut.data.slice(4, 8)], [16, 0, 0, 255]);
  assert.deepEqual([...lut.data.slice(-4)], [255, 255, 255, 255]);
  assert.deepEqual([...lut.domainMin], [0, 0, 0]);
  assert.deepEqual([...lut.domainMax], [1, 1, 1]);
  assert.equal(grading.parseCubeLut(makeCube(33, '0 0 0\n'.repeat(33 ** 3))).size, 33);
  assert.equal(grading.parseCubeLut(makeCube(64, '0 0 0\n'.repeat(64 ** 3))).size, 64);
  assert.throws(() => grading.parseCubeLut('LUT_1D_SIZE 17\n'), /1D \.cube LUTs are not supported/);
  assert.throws(() => grading.parseCubeLut('LUT_3D_SIZE 16\n'), /Only 17³, 33³, or 64³/);
  assert.throws(() => grading.parseCubeLut('LUT_3D_SIZE 17\n0 0 0\n'), /Expected 4913 RGB entries/);
  assert.throws(() => grading.parseCubeLut(makeCube(17, 'NaN 0 0\n'.repeat(17 ** 3))), /non-finite/);
  assert.throws(() => grading.parseCubeLut('LUT_3D_SIZE 17\nDOMAIN_MIN 1 0 0\nDOMAIN_MAX 1 1 1\n0 0 0\n'), /DOMAIN_MAX must be greater/);
});

test('Grade is a photo-only tab with neutral Basic controls, editable ranges, and a mobile compare button', () => {
  assert.match(html, /class="sidebarTab photo-only" id="gradeTab"[^>]*data-tab="grade"/);
  assert.match(html, /class="sidebarPanel photo-only gradeDashboard" id="colorGradePanel"/);
  assert.match(html, /<details class="gradeSection" id="gradeBasicSection"[^>]*open>/);
  assert.match(html, /id="gradeToneCurveSection" data-grade-section="curve">/);
  assert.match(html, /id="gradeHslSection" data-grade-section="hsl">/);
  assert.match(html, /id="sliderGradeExposure" min="-5" max="5" step="0\.05" value="0"/);
  for (const id of ['sliderGradeTemperature','sliderGradeTint','sliderGradeContrast','sliderGradeHighlights','sliderGradeShadows','sliderGradeWhites','sliderGradeBlacks','sliderGradeVibrance','sliderGradeSaturation']) {
    assert.match(html, new RegExp(`class="subSlider gradeSlider" type="range" id="${id}"[^>]*value="0"`), id);
  }
  assert.match(html, /id="gradeAutoBtn"/);
  assert.match(html, /id="gradeUndoBtn"/);
  assert.match(html, /id="gradeRedoBtn"/);
  assert.match(html, /id="gradeResetAllBtn"/);
  assert.match(html, /class="toolBtn gradeMobileBefore" id="gradeBeforeBtn"/);
  assert.match(html, /confirm\('Reset all color grading controls, tone curves, LUT, and HSL mixer settings\?'\)/);
  assert.match(appScript, /if\(name==='grade'&&appState\.mode!=='photo'\)return/);
  assert.match(appScript, /\['mask','grade'\]\.includes\(activeSidebarTab\)/);
});

test('tone curve provides RGB and channel tabs, touch-capable point editing, fixed endpoints and LUT upload', () => {
  for (const channel of ['master','red','green','blue']) assert.match(html, new RegExp(`data-curve-channel="${channel}"`));
  assert.match(html, /id="gradeCurveCanvas" width="256" height="256"/);
  assert.match(appScript, /monotoneCurveSamples\(gradeCurvePoints\[channel\],256\)/);
  assert.match(appScript, /gl\.texSubImage2D\(gl\.TEXTURE_2D,0,0,0,256,1,gl\.RGBA,gl\.UNSIGNED_BYTE,rgba\)/);
  assert.match(appScript, /addEventListener\('pointerdown'/);
  assert.match(appScript, /addEventListener\('pointermove'/);
  assert.match(appScript, /addEventListener\('pointercancel'/);
  assert.match(appScript, /addEventListener\('dblclick'/);
  assert.match(appScript, /index<=0\|\|index>=points\.length-1/);
  assert.match(styles, /#gradeCurveCanvas \{[^}]*touch-action: none/);
});

test('the HSL mixer has three independent eight-color tabs with resettable neutral sliders', () => {
  for (const tab of ['hue','saturation','luminance']) assert.match(html, new RegExp(`data-hsl-tab="${tab}"`));
  for (const band of ['red','orange','yellow','green','aqua','blue','purple','magenta']) {
    assert.equal((html.match(new RegExp(`data-hsl-control="(?:hue|saturation|luminance)" data-hsl-band="${band}"`, 'g')) || []).length, 3, `${band} has all three HSL controls`);
  }
  assert.match(gradeShader, /float hueBandWeight\(float hue,float center\)/);
  assert.match(gradeShader, /smoothstep\(0\.045,0\.18,distance\)/);
  assert.match(appScript, /function resetGradeHslTab\(\)/);
  assert.match(appScript, /data-hsl-control="\$\{gradeHslTab\}"/);
});

test('extended grade controls are neutral by default and run after HSL in the shared preview/export pipeline', () => {
  const postGradeShader = appScript.match(/const fsGradeFinish=`([\s\S]*?)`;/)?.[1] || '';
  assert.match(html, /id="gradeColorWheelsSection"/);
  for (const name of ['shadows','midtones','highlights']) {
    assert.match(html, new RegExp(`data-grade-wheel="${name}" role="slider"`));
    assert.match(html, new RegExp(`id="sliderGradeWheel${name[0].toUpperCase()+name.slice(1)}Intensity" min="0" max="100" value="100" data-grade-default="100"`));
  }
  for (const id of ['sliderGradeTexture','sliderGradeClarity','sliderGradeDehaze','sliderGradeSharpness','sliderGradeNoiseReduction','sliderGradeVignette']) assert.match(html,new RegExp(`id="${id}"[^>]*value="0"`),id);
  assert.match(html, /id="sliderGradeVignetteMidpoint"[^>]*value="50" data-grade-default="50"/);
  assert.match(html, /id="sliderGradeVignetteFeather"[^>]*value="50" data-grade-default="50"/);
  assert.match(html, /id="gradeBlackWhiteBtn" aria-pressed="false"/);
  assert.match(html, /id="sliderGradeBwRed"[^>]*value="21"/);
  assert.match(html, /id="sliderGradeBwGreen"[^>]*value="72"/);
  assert.match(html, /id="sliderGradeBwBlue"[^>]*value="7"/);
  assert.match(postGradeShader, /uniform sampler3D u_lut/);
  assert.match(postGradeShader, /u_lutEnabled/);
  assert.match(postGradeShader, /u_texture/);
  assert.match(postGradeShader, /u_clarity/);
  assert.match(postGradeShader, /u_dehaze/);
  assert.match(postGradeShader, /u_sharpness/);
  assert.match(postGradeShader, /u_noiseReduction/);
  assert.match(postGradeShader, /u_vignetteMidpoint/);
  assert.match(appScript, /function gradePostProcessingIsActive\(\)/);
  assert.match(appScript, /function gradePostUniformSettings\(\)/);
  assert.match(appScript, /const gradeLegacyActive=gradeLegacyProcessingIsActive\(\)/);
  assert.match(appScript, /if\(gradePostProcessingIsActive\(\)\)/);
  assert.match(appScript, /drawGradeFallback\(new Error\('Extended color grading shader or framebuffer is unavailable\.'/);
  assert.ok(appScript.indexOf('gradeSourceTexture=fboGraded.tex') < appScript.indexOf('if(gradePostProcessingIsActive())'));
  assert.ok(appScript.indexOf('if(gradePostProcessingIsActive())') < appScript.indexOf('// bloom extract'));
  assert.match(styles, /\.gradeWheelPicker[^}]*touch-action: none/);
});

test('the grading toolkit has a portable 3D LUT importer, copy and paste shortcuts, and reversible snapshots', () => {
  assert.match(html, /id="gradeLutInput" accept="\.cube,text\/plain"/);
  assert.match(html, /Supports 17³, 33³, and 64³ 3D LUTs/);
  assert.match(html, /id="gradeCopyBtn"/);
  assert.match(html, /id="gradePasteBtn"/);
  assert.match(appScript, /colorGrading\.parseCubeLut\(String\(reader\.result\|\|''\)\)/);
  assert.match(appScript, /gl\.texImage3D\(gl\.TEXTURE_3D,0,gl\.RGBA8/);
  assert.match(appScript, /function copyGradeSettings\(\)/);
  assert.match(appScript, /function pasteGradeSettings\(\)/);
  assert.match(appScript, /key==='c'\|\|key==='v'/);
  assert.match(appScript, /wheels:Object\.fromEntries\(gradeWheelNames/);
  assert.match(appScript, /bwEnabled:gradeBlackWhiteEnabled,lutId:activeGradeLutId/);
  assert.match(appScript, /setActiveGradeLut\(snapshot\.lutId\|\|null/);
  assert.match(appScript, /makeGradeSnapshot\(\)[\s\S]*?curves:[\s\S]*?wheels:[\s\S]*?bwEnabled:/);
  assert.match(appScript, /console\.warn\('3D LUT import failed; the current grade was kept\.'/);
});

test('at least twenty categorized studio presets include cached previews and local user-look JSON import/export', () => {
  const definitions=[...appScript.matchAll(/makeBuiltinGradePreset\('([^']+)','([^']+)','([^']+)'/g)];
  assert.ok(definitions.length>=20,`found ${definitions.length} built-in presets`);
  const categories=new Set(definitions.map(match=>match[3]));
  for(const category of ['Cinematic','Portrait','Black & White','Film','Moody','Bright & Airy'])assert.ok(categories.has(category),category);
  assert.match(html, /id="gradePresetGrid"/);
  assert.match(html, /id="gradePresetSaveBtn"/);
  assert.match(html, /id="gradePresetImportInput" accept="application\/json,\.json"/);
  assert.match(appScript, /const GRADE_PRESET_STORAGE_KEY='film_lab_user_grade_presets_v1'/);
  assert.match(appScript, /function persistGradeUserPresets\(\)/);
  assert.match(appScript, /function exportGradeUserPresets\(\)/);
  assert.match(appScript, /function importGradePresetFile\(file\)/);
  assert.match(appScript, /function createGradePresetThumbnail\(preset\)/);
  assert.match(appScript, /gradePresetThumbnailCache\.has\(key\)/);
  const sliderInput=appScript.match(/function onGradeSliderInput\(\)\{([\s\S]*?)\n\}/)?.[1]||'';
  assert.doesNotMatch(sliderInput, /renderGradePresetCards\(/);
  assert.match(appScript, /function deleteGradeUserPreset\(id\)/);
});

test('grading runs in linear light before looks and uses one shared renderer for preview and exports', () => {
  for (const source of ['srgbToLinear','linearColor.r*=exp2(temperature','linearColor*=exp2(clamp(u_gradeExposure','contrastFactor','u_gradeHighlights','u_gradeWhites','u_gradeCurveMaster','rgbToHsl','u_gradeVibrance','u_gradeSaturation']) assert.ok(gradeShader.includes(source), source);
  assert.ok(gradeShader.indexOf('srgbToLinear') < gradeShader.indexOf('linearColor.r*=exp2(temperature'));
  assert.ok(gradeShader.indexOf('linearColor*=exp2(clamp(u_gradeExposure') < gradeShader.indexOf('contrastFactor'));
  const curveSampling=gradeShader.indexOf('color=vec3(',gradeShader.indexOf('vec3 color=linearToSrgb'));
  const hslConversion=gradeShader.indexOf('vec3 hsl=rgbToHsl');
  const vibranceApplication=gradeShader.indexOf('float vibrance=u_gradeVibrance');
  assert.ok(curveSampling < hslConversion && hslConversion < vibranceApplication);
  assert.match(gradeShader, /if\(u_gradeActive==0\)\{ outColor=base; return; \}/);
  assert.match(appScript, /let sourceTexture=null, fboComposite=null, fboSharpened=null, fboGraded=null/);
  assert.match(appScript, /previewFrameKey\(\)[\s\S]*?gradeStateKey\(\)/);
  assert.match(appScript, /floydStateKey\([\s\S]*?gradeStateKey\(\)/);
  assert.ok(appScript.indexOf('// The grading pass runs in linear light') < appScript.indexOf('// bloom extract'));
  assert.match(appScript, /bindTexture\(gl\.TEXTURE_2D,gradeSourceTexture\).*?u_image/s);
  assert.match(appScript, /function render\(timeMs\)/);
  assert.match(appScript, /render\(performance\.now\(\)\);[\s\S]*?const output=makeExportCanvas/);
  assert.match(appScript, /console\.warn\('Color grading render failed; showing the unedited image instead\.'/);
});

test('grading history is capped at 51 snapshots, captures slider release and curve edits, and supports keyboard undo', () => {
  assert.match(appScript, /if\(gradeHistory\.length>51\) gradeHistory\.splice/);
  assert.match(appScript, /slider\.addEventListener\('change',onGradeSliderCommit\)/);
  assert.match(appScript, /slider\.addEventListener\('pointerup',onGradeSliderCommit\)/);
  assert.match(appScript, /slider\.addEventListener\('keyup',onGradeSliderCommit\)/);
  assert.match(appScript, /event\.key\.toLowerCase\(\)!=='z'/);
  assert.match(appScript, /stepGradeHistory\(event\.shiftKey\?1:-1\)/);
  assert.match(appScript, /gradeHistoryIndex=gradeHistory\.length-1/);
  assert.match(appScript, /gradeCurveInteractionChanged=false;commitGradeSnapshot\(\)/);
  assert.match(appScript, /gradeCurveRenderFrame|scheduleGradeRender/);
  assert.match(appScript, /gradeRenderFrame=requestAnimationFrame/);
});

test('live histogram uses downscaled readback and remains throttled to roughly ten frames per second', () => {
  assert.match(html, /id="gradeHistogram" width="256" height="82"/);
  assert.match(html, /LIVE RGB \/ LUMA/);
  assert.match(appScript, /const scale=Math\.min\(1,256\/canvas\.width,256\/canvas\.height\)/);
  assert.match(appScript, /gradeReadbackContext\.getImageData\(0,0,width,height\)/);
  assert.match(appScript, /100-\(performance\.now\(\)-gradeHistogramLastAt\)/);
  assert.match(appScript, /new Uint32Array\(256\)/);
  assert.match(appScript, /channels\[3\]\[Math\.round\(\.2126\*red\+\.7152\*green\+\.0722\*blue\)\]\+\+/);
});

test('the helper is part of the versioned offline and Capacitor app shells', () => {
  assert.match(html, /<script src="\.\/color-grading\.js"><\/script>/);
  assert.match(serviceWorker, /const CACHE = 'filmlab-v5'/);
  assert.match(serviceWorker, /'color-grading\.js'/);
});
