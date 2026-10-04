const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const vm = require('node:vm');

const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const styles = html.split('<style>')[1].split('</style>')[0];
const script = html.split('<script>')[1].split('</script>')[0];
const timeline = readFileSync(resolve(__dirname, '../multi-timeline.js'), 'utf8');

test('landing has separate filtered photo and video pickers without removing the general drop picker', () => {
  assert.match(html, /id="fileInput" accept="image\/\*[^\"]*video\/\*" multiple hidden/);
  assert.match(html, /id="photoPickerInput" accept="image\/\*[^\"]*\.heic,\.heif,image\/heic,image\/heif" multiple hidden/);
  assert.match(html, /id="videoPickerInput" accept="video\/\*[^\"]*\.m4v" hidden/);
  assert.match(html, /id="photoPickerBtn"/);
  assert.match(html, /id="videoPickerBtn"/);
  assert.match(script, /photoPickerBtn'\)\.addEventListener\('click',e=>\{ e\.preventDefault\(\); e\.stopPropagation\(\); \$\('photoPickerInput'\)\.click\(\); \}\)/);
  assert.match(script, /videoPickerBtn'\)\.addEventListener\('click',e=>\{ e\.preventDefault\(\); e\.stopPropagation\(\); \$\('videoPickerInput'\)\.click\(\); \}\)/);
  assert.match(script, /photoPickerInput'\)\.addEventListener\('change',e=>\{ handleFiles\(e\.target\.files\); e\.target\.value=''; \}\)/);
  assert.match(script, /videoPickerInput'\)\.addEventListener\('change',e=>\{ handleFiles\(e\.target\.files\); e\.target\.value=''; \}\)/);
});

test('the photo and video picker buttons stay plain text with no camera or film icons', () => {
  const button = id => html.match(new RegExp(`<button\\b[^>]*id="${id}"[\\s\\S]*?</button>`))[0];
  const label = id => button(id).match(/<span>([\s\S]*?)<\/span>/)[1];
  // Exact labels: no emoji, no leading icon character, nothing but the words.
  assert.equal(label('photoPickerBtn'), 'Open Photo');
  assert.equal(label('videoPickerBtn'), 'Open Video');
  for (const id of ['photoPickerBtn', 'videoPickerBtn']) {
    // No emoji/pictographs, no variation selectors, no inline SVG or <img> icon.
    assert.doesNotMatch(button(id), /[\u{1F000}-\u{1FAFF}\u{2190}-\u{2BFF}\u{FE0F}]/u);
    assert.doesNotMatch(button(id), /<svg\b|<img\b/i);
  }
  // And no CSS pseudo-element draws an icon over the labels either.
  assert.doesNotMatch(styles, /\.dropPickerBtn::(?:before|after)/);
});

test('responsive media layouts include the tablet two-column photo editor and a larger simplified mobile scrubber', () => {
  assert.match(styles, /@media \(min-width: 768px\) and \(max-width: 1100px\)[\s\S]*?body\[data-mode="photo"\] #content \{ display: flex; flex-direction: row/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*?\.dropPickers \{ gap: 8px/);
  assert.match(styles, /#app\[data-workspace="video"\] #videoSeek \{ width: 100%; min-width: 0; min-height: 44px; height: 44px/);
  assert.match(styles, /#app\[data-workspace="video"\] \.videoPlaybackActions \.playbackSpeeds,[\s\S]*?#videoLoopToggle \{ display: none !important; \}/);
  assert.match(html, /id="videoSeek"/); // same seek input/listener remains mounted
  assert.match(script, /\$\('videoSeek'\)\.addEventListener\('input'/);
});

test('mobile preview scales only WebGL render targets and can calculate full-size exports', () => {
  const dimensions = script.match(/function getRenderDimensions\(w,h\)\{[\s\S]*?\n\}/)[0];
  const context = vm.createContext({
    MOBILE_PREVIEW_MAX_EDGE: 1280,
    renderAtFullResolution: false,
    window: {matchMedia: query => ({matches: query === '(max-width: 767px)'})},
  });
  vm.runInContext(`${dimensions}\nthis.dimensions=getRenderDimensions;`, context);
  assert.deepEqual(JSON.parse(JSON.stringify(context.dimensions(4000, 3000))), {width: 1280, height: 960});
  context.renderAtFullResolution = true;
  assert.deepEqual(JSON.parse(JSON.stringify(context.dimensions(4000, 3000))), {width: 4000, height: 3000});
  context.renderAtFullResolution = false;
  context.window.matchMedia = () => ({matches: false});
  assert.deepEqual(JSON.parse(JSON.stringify(context.dimensions(4000, 3000))), {width: 4000, height: 3000});
  assert.match(script, /function recreateFBOs\(w,h\)[\s\S]*?getRenderDimensions\(w,h\)/);
  assert.match(script, /fboDithered=renderWidth!==w \|\| renderHeight!==h \? createFBO\(renderWidth,renderHeight\) : null/);
  assert.match(script, /canvas\.width=w; canvas\.height=h; recreateFBOs\(w,h\)/); // source/export canvas pixels remain original size
});

test('the reduced dither target matches shader resolution and upscales only the preview result', () => {
  assert.match(script, /const reduced=!!fboDithered && \(fboDithered\.width!==canvas\.width \|\| fboDithered\.height!==canvas\.height\)/);
  assert.match(script, /gl\.bindFramebuffer\(gl\.FRAMEBUFFER,reduced\?fboDithered\.fbo:null\); gl\.viewport\(0,0,targetWidth,targetHeight\)/);
  assert.match(script, /gl\.uniform2f\(gl\.getUniformLocation\(progDither,'u_resolution'\),targetWidth,targetHeight\)/);
  assert.match(script, /if\(reduced\)\{[\s\S]*?gl\.bindTexture\(gl\.TEXTURE_2D,fboDithered\.tex\)[\s\S]*?progPassthrough/);
  assert.match(script, /gl\.uniform2f\(gl\.getUniformLocation\(progComposite,'u_resolution'\),canvas\.width,canvas\.height\)/); // preserve source-space grain scale
  assert.match(script, /fboComposite\?\.width\|\|0,fboComposite\?\.height\|\|0/); // diffusion cache follows the actual target size
});

test('slider values update synchronously while expensive renders are coalesced at 16ms', () => {
  const changed = script.match(/function userChangedSliders\(\)\{[\s\S]*?\n\}/)[0];
  assert.match(changed, /updateFromSliders\(\); updateSliderUI\(\); floydLastKey=null; updateClusterSummaries\(\)/);
  assert.match(changed, /if\(hasContent\) scheduleSliderRender\(\)/);
  assert.match(script, /sliderRenderTimer=setTimeout\(\(\)=>\{[\s\S]*?\},16\)/);
  assert.match(script, /function cancelSliderRender\(\)[\s\S]*?clearTimeout\(sliderRenderTimer\)/);
});

test('export temporarily forces full render targets and restores the preview quality afterward', () => {
  const begin = script.match(/function beginExport\(title\)\{[\s\S]*?\n\}/)[0];
  const finish = script.match(/function finishExport\(view\)\{[\s\S]*?\n\}/)[0];
  const download = script.match(/async function downloadImage\(\)\{[\s\S]*?\n\}/)[0];
  assert.match(begin, /fullResolution:renderAtFullResolution/);
  assert.match(begin, /setFullResolutionRendering\(true\)/);
  assert.match(finish, /setFullResolutionRendering\(view\.fullResolution\)/);
  assert.match(finish, /setFullResolutionRendering\(view\.fullResolution\); updatePreviewZoom\(\); render/);
  assert.match(download, /const view=beginExport\('Preparing original-size PNG'\)/);
  assert.match(download, /finally\{ finishExport\(view\); \}/);
});

test('preview frames and duplicate video texture uploads are cached, while timeline thumbnails wait for idle time', () => {
  assert.match(script, /function previewFrameKey\(\)[\s\S]*?videoEl\?\.currentTime/);
  assert.match(script, /if\(cacheable && frameKey===lastPreviewRenderKey\) return/);
  assert.match(script, /if\(frameKey===lastUploadedVideoFrameKey\) return/);
  assert.match(timeline, /function scheduleMediaThumbnail\(media, videoElement\)[\s\S]*?requestIdleCallback\(renderThumbnail, \{ timeout: 1200 \}\)/);
  assert.match(timeline, /else setTimeout\(renderThumbnail, 120\)/);
  assert.match(timeline, /scheduleMediaThumbnail\(media, videoElement\)/);
});

test('More presets previews on hover and the dropdown remains scrollable without replacing the native select', () => {
  assert.match(html, /<select id="presetSelect"><option value="">Choose a look<\/option><\/select>/);
  assert.match(html, /id="presetHoverMenu" class="presetHoverMenu" role="listbox" aria-label="More preset previews" hidden/);
  assert.match(styles, /\.presetHoverMenu \{[^}]*max-height: min\(340px,45vh\); overflow-y: auto; overscroll-behavior: contain/);
  assert.match(styles, /\.presetHoverOption \.presetColorSwatch \{ position: relative;[^}]*overflow: hidden; \}/);
  assert.match(styles, /\.presetHoverOption \.presetColorSwatch::after \{ content: none; \}/);
  assert.match(script, /function renderPresetHoverOptions\(\)[\s\S]*?option\.addEventListener\('pointerenter',\(\)=>previewPresetHoverOption\(name\)\)/);
  assert.match(script, /function previewPresetHoverOption\(name\)[\s\S]*?startPresetCompare\(name,availablePresets\.get\(name\),customPresetDither\.get\(name\)\)/);
  assert.match(script, /presetHoverWrap\.addEventListener\('pointerenter',[\s\S]*?openPresetHoverMenu\(\)/);
  assert.match(script, /presetHoverMenu\.addEventListener\('wheel',[\s\S]*?previewPresetAtPoint\(e\.clientX,e\.clientY,true\)/);
  assert.match(script, /presetHoverWrap\.addEventListener\('wheel',[\s\S]*?presetHoverMenu\.scrollTop\+=e\.deltaY/);
  assert.match(script, /function choosePresetHoverOption\(name\)[\s\S]*?dispatchEvent\(new Event\('change',\{bubbles:true\}\)\)/);
  assert.match(script, /if\(e\.pointerType!=='mouse' && e\.pointerType!=='pen'\) return/); // native touch/keyboard selection stays available
});

test('preset work is deferred to animation frames and hover comparisons debounce against the mounted list', () => {
  const apply = script.match(/function applyPreset\(name, values, ditherOptions=null, options=\{\}\)\{[\s\S]*?\n\}/)[0];
  const schedule = script.match(/function schedulePresetApplication\(name,values,ditherOptions=null\)\{[\s\S]*?\n\}/)[0];
  const preview = script.match(/function previewPresetHoverOption\(name\)\{[\s\S]*?\n\}/)[0];
  const open = script.match(/function openPresetHoverMenu\(\)\{[\s\S]*?\n\}/)[0];
  const sync = script.match(/function syncPresetSelection\(\)\{[\s\S]*?\n\}/)[0];
  assert.match(apply, /requestAnimationFrame\(beginTransition\)/);
  assert.match(apply, /setDitherScope\(values\.DitherScope/);
  assert.match(schedule, /requestAnimationFrame\(frameTime=>\{[\s\S]*?applyPreset\(name,values,ditherOptions,\{inAnimationFrame:true/);
  assert.match(schedule, /renderFrame\(frameTime\)/);
  assert.match(preview, /setTimeout\([\s\S]*?,80\)/);
  assert.match(script, /if\(typeof renderPresetHoverOptions==='function'\) renderPresetHoverOptions\(\)/); // built alongside the select at initialization/data changes
  assert.doesNotMatch(open, /renderPresetHoverOptions/); // opening only reveals already-mounted options
  assert.doesNotMatch(sync, /renderChips\(\)|renderPresetHoverOptions\(\)/); // selection is updated in place
});

test('preset intensity scales signed preset values toward neutral and can update the active look live', () => {
  const scaler = script.match(/function scalePresetValues\(values,intensity=presetIntensity\)\{[\s\S]*?\n\}/)[0];
  const state = vm.createContext({ids:['Exposure','Bloom','Temperature','Grain'],presetIntensity:100});
  vm.runInContext(`${scaler}\nthis.scale=scalePresetValues;`,state);
  assert.deepEqual(JSON.parse(JSON.stringify(state.scale({Exposure:-80,Bloom:60,Temperature:0,Grain:125},50))),{
    Exposure:-40,Bloom:30,Temperature:0,Grain:50,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(state.scale({Exposure:-80,Bloom:60},0))),{
    Exposure:0,Bloom:0,Temperature:0,Grain:0,
  });
  assert.match(html,/id="presetIntensity" min="0" max="100" value="100"/);
  assert.match(script,/const target=scalePresetValues\(values,presetIntensity\)/);
  assert.match(script,/presetIntensityInput\.addEventListener\('input',applyActivePresetIntensity\)/);
  assert.match(script,/setValues\(scalePresetValues\(availablePresets\.get\(name\),presetIntensity\)\)/);
});

test('preset intensity is immediately visible at the top of Looks, before the preset list', () => {
  const looksStart = html.indexOf('<section class="sidebarPanel active" id="looksPanel"');
  const adjustStart = html.indexOf('<section class="sidebarPanel" id="adjustPanel"', looksStart);
  const looks = html.slice(looksStart, adjustStart);
  const heading = looks.indexOf('class="panelHeading"');
  const intensity = looks.indexOf('class="presetIntensityControl"');
  const popular = looks.indexOf('Popular looks');
  assert.ok(heading >= 0 && heading < intensity && intensity < popular);
  assert.match(looks, /aria-describedby="presetIntensityHint"/);
  assert.match(styles, /\.presetIntensityControl \{[^}]*border: 1px solid var\(--panel-border\)/);
});

test('Adjust keeps Bloom and Hallation in Basic and folds Technical controls into Creative', () => {
  const adjust = html.match(/<section class="sidebarPanel" id="adjustPanel"[\s\S]*?<\/section>\s*<section class="sidebarPanel exportTabPanel"/)?.[0] || '';
  const basicStart = adjust.indexOf('<details class="adjustCluster" data-cluster="basic"');
  const creativeStart = adjust.indexOf('<details class="adjustCluster" data-cluster="creative"');
  const basic = adjust.slice(basicStart, creativeStart);
  const creativeEnd = adjust.indexOf('</details>', creativeStart) + '</details>'.length;
  const creative = adjust.slice(creativeStart, creativeEnd);
  assert.ok(basic.includes('data-group="bloom"') && basic.includes('data-group="hallation"'));
  assert.ok(creative.includes('data-group="dither"') && creative.includes('data-group="sharpen"'));
  assert.doesNotMatch(basic, /data-group="dither"|data-group="sharpen"/);
  assert.doesNotMatch(creative, /data-group="bloom"|data-group="hallation"/);
  assert.doesNotMatch(adjust, /data-cluster="technical"|<span>Technical<\/span>/);
  const summaryGroups = script.match(/const groups=\{([\s\S]*?)\n  \};/)[1];
  assert.match(summaryGroups, /basic:[\s\S]*?\['Bloom','Bloom'\][\s\S]*?\['Hall','Hallation'\]/);
  assert.match(summaryGroups, /creative:[\s\S]*?\['Dither','Dither'\][\s\S]*?\['Sharp','Sharpening'\]/);
});

test('photo Grade owns color and light controls while video Adjust Basic retains them', () => {
  const adjust = html.match(/<section class="sidebarPanel" id="adjustPanel"[\s\S]*?<\/section>\s*<section class="sidebarPanel exportTabPanel"/)?.[0] || '';
  const basicStart = adjust.indexOf('<details class="adjustCluster" data-cluster="basic"');
  const creativeStart = adjust.indexOf('<details class="adjustCluster" data-cluster="creative"');
  const basic = adjust.slice(basicStart, creativeStart);
  assert.ok(basic.includes('data-group="bloom"') && basic.includes('data-group="hallation"'));
  assert.ok(basic.includes('id="sliderExposure"') && basic.includes('id="sliderContrast"')); // retained for preset compatibility
  assert.ok(styles.includes('body[data-mode="photo"] #adjustPanel .adjustCluster[data-cluster="basic"] > .clusterContents > .adjustSectionHeading:first-child,'));
  assert.ok(styles.includes('body[data-mode="photo"] #adjustPanel .adjustCluster[data-cluster="basic"] > .clusterContents > .effectGroup[data-group="color"] { display: none !important; }'));
  assert.ok(html.includes('data-summary="basic">Bloom · Hallation'));
  assert.ok(script.includes("basic:appState.mode==='video'?"));
  assert.ok(script.includes(":[['Bloom','Bloom'],['Hall','Hallation'],['BloomAnam','Anamorphic']]"));
  assert.match(html, /id="gradeBasicSection"[\s\S]*?White balance[\s\S]*?Light[\s\S]*?Color/);
});

test('FFmpeg preload status is separate from the export-only progress dialog', () => {
  const initialize = script.match(/async function initializeFFmpeg\(\)\{[\s\S]*?\n\}/)[0];
  assert.match(html, /id="videoEngineStatus"[^>]*role="status" aria-live="polite"/);
  assert.match(script, /setVideoEngineStatus\('loading','Loading video engine… this takes a moment'\)/);
  assert.doesNotMatch(initialize, /progressText\.textContent='Loading video engine/);
  assert.match(initialize, /if\(!encodingVideo \|\| !Number\.isFinite\(progress\)\) return/);
  assert.match(script, /progressWrap\.classList\.add\('show'\)/);
  assert.match(script, /function setEditorBusy\(busy\)[\s\S]*?if\(busy\) \$\('videoEngineStatus'\)\.hidden=true/);
});
