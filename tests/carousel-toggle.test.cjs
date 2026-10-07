const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');

const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const styles = html.split('<style>')[1].split('</style>')[0];
const script = html.split('<script>')[1].split('</script>')[0];
const serviceWorker = readFileSync(resolve(__dirname, '../sw.js'), 'utf8');

test('the carousel strip carries a chevron toggle wired to the thumbnail list', () => {
  assert.match(html, /<div class="stripHead"><button type="button" id="carouselToggleBtn" class="carouselToggleBtn" aria-expanded="true" aria-controls="photoThumbnails" aria-label="Hide photos" title="Hide photos"><span class="panelChevron" aria-hidden="true"><\/span><\/button><span class="stripTitle" id="carouselCount">/);
  // The toggle sits left of the title, inside .stripHead, ahead of the actions.
  const head = html.slice(html.indexOf('<div class="stripHead">'), html.indexOf('<div id="photoThumbnails"'));
  assert.ok(head.indexOf('id="carouselToggleBtn"') < head.indexOf('id="carouselCount"'));
  assert.ok(head.indexOf('id="carouselCount"') < head.indexOf('class="stripActions"'));
});

test('collapsing hides the gallery, hint and bulk actions in CSS only', () => {
  // Every id stays in the markup; nothing is removed from the DOM by script.
  assert.match(html, /<div id="photoThumbnails" role="group" aria-label="Switch photo"><\/div>/);
  assert.match(html, /<p id="carouselHint" class="socialHint">One shared edit\./);
  for (const id of ['exportZipBtn', 'applyAllBtn', 'addPhotosBtn', 'removePhotoBtn']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(styles, /#carouselStrip\.collapsed #exportZipBtn,\n#carouselStrip\.collapsed #applyAllBtn,\n#carouselStrip\.collapsed #removePhotoBtn \{ display: none !important; \}/);
  assert.match(styles, /#carouselStrip\.collapsed #photoThumbnails,\n#carouselStrip\.collapsed #carouselHint \{ visibility: hidden; pointer-events: none; transition: visibility 0s linear \.26s; \}/);
  // The slim one-line bar keeps the count, "+ Add" and the toggle.
  assert.match(styles, /#carouselStrip\.collapsed \.stripHead \{ justify-content: flex-start; gap: 8px; margin-bottom: 0; \}/);
  assert.match(styles, /#carouselStrip\.collapsed \.stripActions \{ flex: 0 0 auto; flex-wrap: nowrap; justify-content: flex-end; margin-left: auto; \}/);
  assert.match(html, /id="carouselCount">Carousel \//);
  // Nothing in the collapse path strips a node or an id from the document.
  const togglePath = script.slice(script.indexOf("const CAROUSEL_COLLAPSED_KEY"), script.indexOf("$('cropPanelToggle')"));
  assert.doesNotMatch(togglePath, /removeChild|replaceChildren|innerHTML|remove\(\)/);
});

test('the strip folds on a height transition that respects reduced motion', () => {
  assert.match(styles, /#carouselStrip \{ overflow: hidden; max-height: 300px; transition: max-height \.26s cubic-bezier\(\.2,\.8,\.2,1\); \}/);
  assert.match(styles, /#carouselStrip\.collapsed \{ max-height: 52px; min-height: 52px; padding-top: 12px; \}/);
  assert.match(styles, /@media \(prefers-reduced-motion: reduce\) \{\n  #carouselStrip,\n  #carouselStrip #photoThumbnails,\n  #carouselStrip #carouselHint \{ transition: none !important; \}\n\}/);
  // Phone/tablet layout keeps the same toggle and a one-line collapsed bar under the photo.
  assert.match(styles, /body\[data-mode="photo"\] #app #carouselStrip\.collapsed \{ max-height: 52px; min-height: 52px; padding-top: 12px; \}/);
  assert.match(styles, /body\[data-mode="photo"\] #carouselStrip\.collapsed \.stripHead \{ flex-direction: row; flex-wrap: nowrap; align-items: center; gap: 8px; margin-bottom: 0; \}/);
  assert.match(styles, /body\[data-mode="photo"\] #carouselStrip\.collapsed \.stripActions \{ flex: 0 0 auto; flex-wrap: nowrap; justify-content: flex-end; margin-left: 0; \}/);
  // The 44px touch target comes from an invisible ::before, so the button keeps its size.
  const coarseStart = styles.lastIndexOf('@media (pointer: coarse) {');
  const coarse = styles.slice(coarseStart, styles.indexOf('\n}', coarseStart));
  assert.match(coarse, /#carouselStrip #carouselToggleBtn \{ position: relative; \}/);
  assert.match(coarse, /#carouselStrip #carouselToggleBtn::before \{ content: ''; position: absolute; left: 50%; top: 50%; width: 44px; height: 44px; min-width: 100%; min-height: 100%;[^}]*transform: translateY\(-50%\); \}/);
  // Same-plus-one specificity so the photo/tablet padding really moves the 44px box inside the strip.
  assert.match(coarse, /body\[data-mode="photo"\] #app #carouselStrip \{ padding-top: 12px; \}/);
  assert.match(styles, /#carouselToggleBtn \{ position: relative; display: inline-flex;[^}]*width: 20px; height: 20px; min-width: 20px; min-height: 20px;/);
});

test('the collapsed default follows the photo count and a manual choice is remembered', () => {
  assert.match(script, /const CAROUSEL_COLLAPSED_KEY='filmlab-carousel-collapsed';/);
  assert.match(script, /let carouselCollapsedPref=null; \/\/ null until the user folds or unfolds the strip by hand/);
  assert.match(script, /try\{\n  const savedCarouselChoice=localStorage\.getItem\(CAROUSEL_COLLAPSED_KEY\);/);
  assert.match(script, /function carouselDefaultCollapsed\(\)\{ return photos\.length<=1; \} \/\/ one photo folds, two or more stay open/);
  assert.match(script, /try\{ localStorage\.setItem\(CAROUSEL_COLLAPSED_KEY,folded\?'1':'0'\); \}/);
  assert.match(script, /catch\(error\)\{ console\.warn\('The carousel hide\/show choice could not be saved\.',error\); \}/);
  assert.match(script, /function syncCarouselCollapse\(\)\{\n  applyCarouselCollapsed\(carouselCollapsedPref===null\?carouselDefaultCollapsed\(\):carouselCollapsedPref,false\);/);
  assert.match(script, /new MutationObserver\(\(\)=>\{ syncCarouselCollapse\(\); schedulePreviewFit\(\); \}\)\.observe\(carouselThumbList,\{childList:true\}\)/);
  assert.match(script, /toggle\.setAttribute\('aria-expanded',String\(!folded\)\);/);
  assert.match(script, /toggle\.setAttribute\('aria-label',folded\?'Show photos':'Hide photos'\);/);
  assert.match(script, /toggle\.title=folded\?'Show photos':'Hide photos';/);
});

test('toggling re-fits the preview through the existing routine and never touches renderPhotoStrip', () => {
  assert.match(script, /if\(carouselToggleBtn\)carouselToggleBtn\.addEventListener\('click',toggleCarouselCollapse\);/);
  assert.match(script, /function toggleCarouselCollapse\(\)\{[\s\S]*?refreshCanvasAfterSheetLayout\(\); \/\/ the existing fit\/resize routine/);
  assert.match(script, /carouselStripEl\.addEventListener\('transitionend',event=>\{\n    if\(event\.target===carouselStripEl&&event\.propertyName==='max-height'\)refreshCanvasAfterSheetLayout\(\);/);
  // renderPhotoStrip is byte-identical to what it was before this pass.
  const strip = script.slice(script.indexOf('function renderPhotoStrip(){'), script.indexOf('\n}', script.indexOf('function renderPhotoStrip(){')));
  assert.equal(strip, [
    'function renderPhotoStrip(){',
    "  const strip=$('carouselStrip'), list=$('photoThumbnails');",
    '  strip.hidden=!photos.length||isVideo; list.replaceChildren();',
    "  $('carouselCount').textContent=`Carousel / ${String(activePhotoIndex+1).padStart(2,'0')} of ${String(photos.length).padStart(2,'0')}`;",
    '  photos.forEach((photo,index)=>{',
    "    const btn=document.createElement('button'); btn.type='button'; btn.className='photoThumb';",
    "    btn.setAttribute('aria-pressed',String(index===activePhotoIndex)); btn.setAttribute('aria-label',`Photo ${index+1}: ${photo.file.name}`);",
    '    btn.title=photo.file.name; btn.disabled=exportBusy||mediaBusy;',
    "    const image=document.createElement('img'); image.src=photo.thumbUrl; image.alt=''; image.width=54; image.height=54;",
    "    const number=document.createElement('span'); number.textContent=String(index+1).padStart(2,'0');",
    "    btn.append(image,number); btn.addEventListener('click',()=>activatePhoto(index)); list.appendChild(btn);",
    '  });',
    '  schedulePreviewFit();',
  ].join('\n'));
});

test('the service worker cache was bumped for the carousel strip change', () => {
  assert.match(serviceWorker, /const CACHE = 'filmlab-v20';/);
  assert.doesNotMatch(serviceWorker, /filmlab-v5/);
});
