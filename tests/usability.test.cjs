const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');

const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const styles = html.split('<style>')[1].split('</style>')[0];
const script = html.split('<script>')[1].split('</script>')[0];

test('phone editing keeps the photo visible above a 45% sheet with a tappable peek bar', () => {
  assert.match(styles, /@media \(max-width: 900px\), \(max-width: 1024px\) and \(orientation: portrait\) \{/);
  assert.match(styles, /body\[data-mode="photo"\] \{ --sheet-peek: 112px; height: 100%; overflow: hidden;/);
  assert.match(styles, /body\[data-mode="photo"\] #sidebar \{[^}]*height: 45dvh; max-height: 45dvh;[^}]*overflow-y: auto;/);
  assert.match(styles, /body\[data-mode="photo"\] #content \{[^}]*padding-bottom: var\(--sheet-peek,112px\);[^}]*transition: padding-bottom/);
  assert.match(styles, /body\[data-mode="photo"\]\[data-sheet="open"\] #content \{ padding-bottom: 45dvh; \}/);
  assert.match(styles, /body\[data-mode="photo"\] #mainArea\.hasPhotos\[[^\]]*\]|body\[data-mode="photo"\] #app #mainArea\.hasPhotos/);
  assert.match(styles, /body\[data-mode="photo"\] #app #carouselStrip \{ position: relative;[^}]*margin: auto 0 0;/);
  assert.match(script, /document\.body\.dataset\.sheet=open\?'open':'peek'; \/\/ sheet-aware stage sizing/);
  assert.match(script, /if\(!sheet\.classList\.contains\('mobileSheetOpen'\)\)setMobileSheet\(true\);/);
  assert.match(script, /function refreshCanvasAfterSheetLayout\(\)[\s\S]*?schedulePreviewFit\(\)[\s\S]*?render\(performance\.now\(\)\)/);
});

test('the preview fits the stage by itself and stays separate from preview zoom', () => {
  assert.match(script, /function applyPreviewFit\(\)\{[\s\S]*?const scale=Math\.min\(availableWidth\/pixelsW,availableHeight\/pixelsH,3\)/);
  assert.match(script, /canvas\.style\.width=`\$\{fittedW\}px`;/);
  assert.match(script, /if\(availableHeight-fittedH>16\) canvasWrap\.style\.maxHeight=/);
  assert.match(script, /function installPreviewFitObserver\(\)\{[\s\S]*?new ResizeObserver\(\(\)=>\{ syncHeaderHeight\(\); schedulePreviewFit\(\); \}\)/);
  assert.match(script, /zoomResetBtn\.addEventListener\('click',\(\)=>schedulePreviewFit\(\)\)/);
  assert.match(script, /if\(resetView\) resetPreviewZoom\(\); else updatePreviewZoom\(\);\n  schedulePreviewFit\(\);/);
  assert.match(styles, /body\[data-mode="photo"\] #glCanvas \{ width: auto; height: auto; max-width: 100%; max-height: 100%; \}/);
});

test('look cards preview the loaded photo, render one per frame, and cache on the preset', () => {
  assert.match(script, /const LOOK_PREVIEW_WIDTH=320; \/\/ one canvas per photo; each look is rendered once from it and cached/);
  assert.match(script, /return thumb\.toDataURL\('image\/jpeg',0\.6\);/);
  assert.match(script, /lookPreviewFrame=requestAnimationFrame\(renderNextLookPreview\);/);
  assert.match(script, /Object\.defineProperty\(next\.values,'lookPreview',\{value:url/);
  assert.match(script, /lookPreviewSource=source;[\s\S]*?lookPreviewKey=`\$\{item\?\.id\|\|'photo'\}:\$\{\+\+lookPreviewGeneration\}`/);
  // The thumbnail is built once per loaded photo, inside uploadPhoto, and never from a slider move.
  assert.equal((script.match(/createLookPreviewSource\(/g) || []).length, 2);
  assert.match(script, /const source=applyStraightenToSource\(rotateCanvas\(baseSource,baseW,baseH,rotation\),w,h,item\.straighten\);\n  buildPhotoSampleCanvas\(source,w,h,item\.id\);\n  createLookPreviewSource\(item,source\);/);
  const sliderPath = script.slice(script.indexOf('function userChangedSliders(){'), script.indexOf('function updateDitherControlVisibility(){'));
  assert.doesNotMatch(sliderPath, /LookPreview|createLookPreviewSource/);
  assert.doesNotMatch(sliderPath, /toDataURL/);
  // Cards keep their gradient until a real preview exists, and the swatch can show either.
  assert.match(script, /console\.warn\('A look preview could not be rendered; its gradient swatch stays\.',error\);/);
  assert.match(styles, /#presetChips \.chip \.presetColorSwatch,#savedPresetChips \.chip \.presetColorSwatch \{ display: block; width: 100%; height: 46px;/);
  // Second pass: photo-shaped preview with the look name underneath, curve reduced to a corner mark.
  assert.match(styles, /body #presetChips \.chip,\nbody #savedPresetChips \.chip \{ display: flex; flex-direction: column-reverse;[^}]*\}/);
  assert.match(styles, /body #presetChips \.chip \.presetColorSwatch,\nbody #savedPresetChips \.chip \.presetColorSwatch \{[^}]*aspect-ratio: 4 \/ 3;[^}]*\}/);
  assert.match(styles, /body #presetChips \.chip \.presetColorSwatch::after,\nbody #savedPresetChips \.chip \.presetColorSwatch::after \{ inset: auto 5px 5px auto; width: 18px; height: 11px; opacity: \.5;/);
  // The card label keeps its own line instead of being clipped away under the preview.
  assert.doesNotMatch(styles, /body #presetChips \.chip \{ max-height/);
});

test('the preset dropdown never repeats a label while every distinct look stays available', () => {
  assert.match(script, /function presetDisplayName\(name\)\{[\s\S]*?if\(name\.startsWith\('ig:'\)&&Object\.prototype\.hasOwnProperty\.call\(builtInPresets,label\)\) return `\$\{label\} \(IG\)`;/);
  assert.match(script, /if\(chip\.dataset\)chip\.dataset\.presetName=name;/);
  assert.match(script, /if\(card\.dataset\)card\.dataset\.presetName=name;/);
});

test('the status toast is anchored below the header, never over text, and auto-dismisses', () => {
  assert.match(styles, /#toast \{ position: fixed; top: calc\(var\(--header-h,54px\) \+ 8px\); left: 50%; z-index: 200;/);
  assert.match(styles, /#toast\.show \{ opacity: 1; transform: translate\(-50%,0\); \}/);
  assert.match(script, /let toastTimer=null;\nfunction showToast\(m,ms=3200\)\{/);
  assert.match(script, /if\(toastTimer!==null\)clearTimeout\(toastTimer\);/);
  assert.match(script, /function syncHeaderHeight\(\)\{[\s\S]*?document\.documentElement\.style\.setProperty\('--header-h'/);
  assert.match(script, /showToast\(notes\.join\(' · '\),3000\);/);
});

test('coarse pointers get 44px hit areas and lose the keyboard-shortcuts footer', () => {
  const coarseStart = styles.indexOf('@media (pointer: coarse) {\n  #shortcuts-bar');
  assert.ok(coarseStart > 0, 'the coarse-pointer block keeps the 44px rules');
  const coarse = styles.slice(coarseStart, styles.indexOf('\n}', coarseStart));
  assert.match(coarse, /\.zoomInstructions,#zoomControls \.zoomInstructions \{ display: none !important; \}/);
  assert.match(coarse, /header #backToDropBtn::before,[\s\S]*?width: 44px; height: 44px; min-width: 100%; min-height: 100%;/);
  assert.match(coarse, /#sidebarTabs \.sidebarTab \{ position: relative; min-height: 44px; \}/);
  for (const id of ['backToDropBtn', 'addPhotosBtn', 'removePhotoBtn', 'exportZipBtn', 'applyAllBtn', 'resetOriginalBtn']) {
    assert.match(coarse, new RegExp(`#${id}`));
  }
});

test('the landing screen dims the header export actions until media loads', () => {
  assert.match(styles, /#hdrBeforeBtn:disabled,#hdrDownloadBtn:disabled \{ opacity: \.38; cursor: not-allowed; border-bottom-color: transparent; \}/);
  assert.doesNotMatch(styles, /body\[data-mode="empty"\] #app #headerActions #hdr(?:Before|Download)Btn/);
  assert.match(script, /\$\('hdrBeforeBtn'\)\.disabled=!hasContent\|\|locked;/);
  assert.match(script, /\$\('hdrDownloadBtn'\)\.disabled=!hasContent\|\|locked;/);
});

test('each Adjust group has a single header and scale labels keep clear of the next slider', () => {
  assert.match(styles, /#adjustPanel \.adjustSectionHeading:has\(\+ \.effectGroup\) \{ display: none !important; \}/);
  assert.match(styles, /#adjustPanel \.subControls \{ gap: 16px; \}/);
  assert.match(styles, /#adjustPanel \.subScale \{ margin-top: 3px; padding-bottom: 1px;/);
  assert.match(html, /body\[data-mode="photo"\] #adjustPanel \.adjustCluster\[data-cluster="basic"\] > \.clusterContents > \.adjustSectionHeading:first-child,/);
  for (const group of ['bloom', 'hallation']) {
    assert.match(html, new RegExp(`effectGroup[^"]*"[^>]*data-group="${group}"`));
  }
  assert.match(script, /document\.querySelectorAll\('\.effectHeader'\)\.forEach\(h=>\{/);
});
