const {test} = require('node:test');
const assert = require('node:assert/strict');
const {readFileSync} = require('node:fs');
const {resolve} = require('node:path');
const vm = require('node:vm');

const html = readFileSync(resolve(__dirname, '../index.html'), 'utf8');
const script = html.split('<script>')[1].split('</script>')[0];
const styles = html.split('<style>')[1].split('</style>')[0];
const timeline = readFileSync(resolve(__dirname, '../timeline-module.js'), 'utf8');
const multiTimeline = readFileSync(resolve(__dirname, '../multi-timeline.js'), 'utf8');

test('the existing upload landing routes image and video files without a reload', () => {
  assert.match(html, /id="dropZone"/);
  assert.match(html, /READY FOR MEDIA/);
  assert.match(html, /id="fileInput" accept="image\/\*[^\"]*video\/\*" multiple hidden/);
  assert.match(script, /function handleFiles\(fileList/);
  assert.match(script, /if\(document\.readyState==='loading'\)document\.addEventListener\('DOMContentLoaded',startFilmLab,\{once:true\}\)/);
  assert.ok(html.indexOf('<canvas id="glCanvas"')<html.indexOf("const canvas = document.getElementById('glCanvas')"), 'the persistent canvas exists before WebGL initialization');
  assert.match(script, /fileInput\.addEventListener\('change'/);
  assert.match(script, /dropZone\.addEventListener\('drop'/);
  assert.match(script, /const images=files\.filter\(isPhotoFile\), videos=files\.filter\(isVideoFile\)/);
  assert.match(script, /isVideo=false; hasContent=true; currentPhoto=item/);
  assert.match(script, /isVideo=true; hasContent=true; setWorkspaceMode\('video'\); videoCrop=/);
  const replacement=script.match(/if\(replacing\)\{([\s\S]*?)\n        \}/)[1];
  assert.doesNotMatch(replacement, /isVideo=false/); // uploadPhoto must see Video Mode to restore the saved photo-export options
  assert.match(script, /hasContent=false; if\(animId!==null\)[\s\S]*?setWorkspaceMode\('empty'\)/);
  assert.doesNotMatch(script, /location\.reload\(/);
});

test('workspace state shows subtle top-bar mode and only exposes video controls in video mode', () => {
  const fn = script.match(/function updateWorkspaceUI\(\)\{[\s\S]*?\n\}/)[0];
  const ids=['app','workspacePill','videoPlaybackControls','editorTimeline','grainSpeedRow','backToDropBtn','exportPanelTitle','frameFormatLabel','frameQualityLabel'];
  const elements = Object.fromEntries(ids.map(id => [id, {dataset:{},hidden:false,disabled:false,textContent:''}]));
  const state = vm.createContext({appState:{mode:'empty'},document:{body:{dataset:{}}},hasContent:true,isVideo:false,mediaBusy:false,exportBusy:false,$:id=>elements[id],updateCaptionOverlay(){}});
  vm.runInContext(`${fn}\nthis.update=updateWorkspaceUI;`,state);
  state.update();
  assert.equal(elements.app.dataset.workspace,'photo');
  assert.equal(state.appState.mode,'photo');
  assert.equal(state.document.body.dataset.mode,'photo');
  assert.equal(elements.workspacePill.hidden,false);
  assert.equal(elements.workspacePill.textContent,'Photo mode');
  assert.equal(elements.videoPlaybackControls.hidden,true);
  assert.equal(elements.editorTimeline.hidden,true);
  assert.equal(elements.grainSpeedRow.hidden,true);
  state.isVideo=true; state.update();
  assert.equal(elements.workspacePill.textContent,'Video mode');
  assert.equal(state.appState.mode,'video');
  assert.equal(state.document.body.dataset.mode,'video');
  assert.equal(elements.videoPlaybackControls.hidden,false);
  assert.equal(elements.editorTimeline.hidden,false);
  assert.equal(elements.grainSpeedRow.hidden,false);
  assert.equal(elements.backToDropBtn.disabled,false);
  state.hasContent=false; state.update();
  assert.equal(elements.app.dataset.workspace,'empty');
  assert.equal(state.appState.mode,'empty');
  assert.equal(state.document.body.dataset.mode,'empty');
  assert.equal(elements.workspacePill.hidden,true);
  assert.equal(elements.videoPlaybackControls.hidden,true);
  assert.equal(elements.editorTimeline.hidden,true);
  assert.equal(elements.grainSpeedRow.hidden,true);
  assert.equal(elements.backToDropBtn.disabled,true);
});

test('video workspace places the canvas and playback above a full-width timeline with the sidebar on the right', () => {
  assert.match(styles, /#app\[data-workspace="video"\] #content \{ display: grid; grid-template-columns: minmax\(0,1fr\) 390px; grid-template-rows: minmax\(0,1fr\) 120px;/);
  assert.match(styles, /#app\[data-workspace="video"\] #sidebar \{ grid-column: 2; grid-row: 1;/);
  assert.match(styles, /#app\[data-workspace="video"\] #content \{ grid-template-rows: minmax\(0,1fr\) 220px;/);
  assert.match(styles, /#app\[data-workspace="video"\] #content > \.mtl-shell \{ grid-column: 1 \/ -1; grid-row: 2;/);
  assert.match(styles, /#app\[data-workspace="video"\] #editorTimeline \{ grid-column: 1; grid-row: 2;/);
  assert.match(styles, /\.timelineHeader \{ display: flex; align-items: center; \}/);
  assert.match(styles, /#timelineTrack \{ position: relative; display: block; flex: 1 1 auto;/);
  assert.match(styles, /#timelineFilmstrip img \{ flex: 1 1 0;[^}]*object-fit: cover/);
  assert.match(styles, /\.timelineKeyframeMarker \{ position: absolute/);
  assert.match(styles, /#app\[data-workspace="video"\] #sidebarViews > \.sidebarPanel\.active #videoExportPanel \{ display: flex; \}/);
  assert.match(html, /id="videoPlaybackControls" class="video-only" hidden/);
  for(const id of ['videoSkipStart','videoPlayBtn','videoSkipEnd','videoTime','videoSeek','videoVolume','videoMuteBtn','videoLoopToggle','videoSpeed']) assert.match(html,new RegExp(`id="${id}"`));
  for(const speed of ['0.5','1','1.5','2']) assert.match(html,new RegExp(`data-playback-rate="${speed}"`));
  assert.match(html, /id="timelineFilmstrip"/);
  assert.match(html, /id="audioWaveform"/);
  assert.match(html, /id="timelineSelection"/);
  assert.match(html, /id="trimStartHandle"[\s\S]*?id="trimEndHandle"/);
  assert.match(html, /id="timelinePlayhead"/);
  assert.match(html, /id="timelineInTime"[\s\S]*?id="timelinePlayheadTime"[\s\S]*?id="timelineOutTime"/);
  assert.match(script, /function renderVideoFilmstrip\(token\)/);
  assert.match(script, /async function renderAudioWaveform\(file,token\)/);
  assert.match(script, /function updateTimelineVisuals\(\)/);
  assert.match(script, /function timeAtTimelinePointer\(e\)/);
  assert.match(script, /timelineTrack'\)\.addEventListener\('pointermove'/);
  assert.match(script, /if\(e\.code==='Space'\)[\s\S]*?isVideo\?toggleVideoPlayback\(\):toggleBeforeAfter\(\)/);
  assert.match(script, /if\(videoEl\.currentTime>=videoTrim\.end\)\{[\s\S]*?videoLoopToggle'\)\.getAttribute\('aria-pressed'\)==='true'[\s\S]*?videoEl\.pause\(\);videoEl\.currentTime=videoTrim\.end/);
});

test('photo and video panels switch with appState.mode while the existing DOM stays mounted', () => {
  assert.match(script, /const \$ = id => document\.getElementById\(id\)/);
  assert.match(script, /const appState=\{mode:'empty'\}/);
  assert.match(script, /function setWorkspaceMode\(mode\)[\s\S]*?appState\.mode=mode;[\s\S]*?document\.body\.dataset\.mode=mode/);
  assert.match(script, /function updateWorkspaceUI\(\)[\s\S]*?document\.body\.dataset\.mode=workspace/);
  assert.match(html, /<body data-mode="empty">/);
  assert.match(styles, /body\[data-mode="photo"\] \.video-only \{ display: none !important; \}/);
  assert.match(styles, /body\[data-mode="video"\] \.photo-only \{ display: none !important; \}/);
  assert.match(styles, /body\[data-mode="empty"\] \.photo-only,body\[data-mode="empty"\] \.video-only \{ display: none !important; \}/);
  for(const [id,modeClass] of [['exportPanel','photo-only'],['actions','photo-only'],['carouselStrip','photo-only'],['videoPlaybackControls','video-only'],['videoCaptionPanel','video-only'],['videoTrimPanel','video-only'],['videoExportPanel','video-only'],['editorTimeline','video-only'],['grainSpeedRow','video-only'],['captionOverlay','video-only']]){
    const root=html.match(new RegExp(`<[^>]+id="${id}"[^>]*>`))[0];
    assert.match(root,new RegExp(`class="[^"]*${modeClass}`),id);
  }
  for(const text of ['id="glCanvas"','id="videoEl"','id="fileInput"','id="editorTimeline"']) assert.ok(html.includes(text),`${text} remains in the source DOM`);
  assert.doesNotMatch(script, /DocumentFragment|parkWorkspaceNode|detachedWorkspaceElements/);
  assert.match(script, /const slider=row\.querySelector\('input\[type="range"\]'\);\s*if\(!slider\)return/);
  assert.match(script, /const group=groupRoot\?\.querySelector\('\.effectTitle'\)\?\.textContent/);
  assert.match(script, /function initializeWorkspaceModes\(\)\{ setWorkspaceMode\('empty'\); \}/);
  assert.match(script, /uploadPhoto\(item,img,resetView=true\)[\s\S]*?setWorkspaceMode\('photo'\)/);
  assert.match(script, /isVideo=true; hasContent=true; setWorkspaceMode\('video'\)/);
  assert.match(script, /if\(typeof isVideo!==\x27undefined\x27&&isVideo\)strength=0/);
  assert.doesNotMatch(styles, /#effectsWrap \.effectGroup\[data-group="dither"\] \{ display: none !important;/);
  assert.match(html, /Text &amp; Captions/);
  for(const id of ['captionText','captionFont','captionSize','captionColor','captionEnabled','captionOverlay','captionKeyframeBtn','captionKeyframeMarkers']) assert.match(html,new RegExp(`id="${id}"`));
  assert.match(script, /function drawVideoCaption\(ctx,output/);
  assert.match(script, /if\(isVideo\) drawVideoCaption\(ctx,output,o,position\)/);
  assert.match(script, /captionOverlay'\)\.addEventListener\('pointermove'/);
  assert.match(script, /function captionPositionAt\(time\)/);
  assert.match(script, /function renderCaptionKeyframeMarkers\(\)/);
  assert.match(html, /Show on this clip/);
});

test('empty and photo workspaces hide irrelevant video chrome and guard header export actions', () => {
  assert.match(styles, /body\[data-mode="empty"\] #app #content #timeline-module,[\s\S]*?body\[data-mode="photo"\] #app #shortcuts-bar \{ display: none !important; \}/);
  assert.match(styles, /body\[data-mode="empty"\] #app #headerActions #hdrBeforeBtn/);
  assert.match(styles, /body\[data-mode="empty"\] #app #headerActions #hdrDownloadBtn/);
  const update = script.match(/function updateSocialUI\(\)\{[\s\S]*?\n\}/)[0];
  assert.match(update, /\$\('hdrBeforeBtn'\)\.disabled=!hasContent\|\|locked/);
  assert.match(update, /\$\('hdrDownloadBtn'\)\.disabled=!hasContent\|\|locked/);
  const exportHandler = script.match(/function handleHeaderExport\(\)\{[\s\S]*?\n\}/)[0];
  assert.match(exportHandler, /if\(!hasContent\|\|exportBusy\|\|mediaBusy\) return/);
  assert.match(script, /hdrDownloadBtn'\)\.addEventListener\('click',\(\)=>\{if\(hasContent&&!isVideo\)/);
  assert.match(styles, /body\[data-mode="video"\] #app #timeline-module:not\(\[hidden\]\) \{ display: flex; \}/);
});

test('video timeline is an additive module with trim, cut, history, zoom, waveform and transition controls', () => {
  assert.match(html, /<section id="timeline-module" class="video-only"/);
  for(const id of ['timeline-skip-start','timeline-play','timeline-skip-end','timeline-timecode','timeline-cut','timeline-delete','timeline-undo','timeline-redo','timeline-zoom-minus','timeline-zoom-plus','timeline-ruler','timeline-clips','timeline-audio','timeline-playhead']) assert.match(html,new RegExp(`id="${id}"`));
  for(const transition of ['none','dissolve','fade-to-black','fade-from-black']) assert.match(html,new RegExp(`data-transition="${transition}"`));
  assert.match(html, /src="\.\/timeline-module\.js"/);
  assert.match(timeline, /function splitAt\(time\)/);
  assert.match(timeline, /No clip loaded/);
  assert.match(styles, /body\[data-mode="video"\] #app #timeline-module:not\(\[hidden\]\) \{ display: flex; \}/);
  assert.doesNotMatch(styles, /body\[data-mode="empty"\] #app #content #timeline-module:not\(\[hidden\]\)/);
  assert.match(timeline, /function getExportPlan\(\)/);
  assert.match(timeline, /function mapOutputTime\(time, plan = getExportPlan\(\)\)/);
  assert.match(timeline, /addEventListener\('timeupdate', onPlaybackTime\)/);
  assert.match(timeline, /video\(\)\.currentTime\s*=/);
  assert.doesNotMatch(timeline, /video\(\)\.(?:play|pause|volume|muted|playbackRate)\s*=/);
  assert.match(script, /window\.filmLabTimelineBridge=/);
  assert.equal((html.match(/id="glCanvas"/g)||[]).length,1,'the existing WebGL canvas remains mounted exactly once');
  assert.match(styles, /#app\[data-workspace="video"\] #timeline-module \{ grid-column: 1; grid-row: 2/);
  assert.match(styles, /body\[data-mode="photo"\] #app #mainArea \.video-only/);
  assert.match(styles, /#exportProgress\.show \{ position: fixed; top: 50%/);
});

test('timeline output mapping covers concatenated cuts, dissolves, and black fades', () => {
  const mapper=timeline.match(/function mapOutputTime\(time, plan = getExportPlan\(\)\) \{[\s\S]*?\n  \}/)[0];
  const state=vm.createContext({getExportPlan:()=>({}),clamp:(n,min,max)=>Math.max(min,Math.min(max,n))});
  vm.runInContext(`${mapper}\nthis.map=mapOutputTime;`,state);
  const dissolve={transitionSeconds:.5,segments:[{start:0,end:2,transition:'dissolve'},{start:5,end:7,transition:'none'}]};
  assert.deepEqual(JSON.parse(JSON.stringify(state.map(1.75,dissolve))),{sourceTime:1.75,blendTime:5.25,blend:.5});
  const fadeOut={transitionSeconds:.5,segments:[{start:0,end:2,transition:'fade-to-black'},{start:4,end:5,transition:'none'}]};
  assert.deepEqual(JSON.parse(JSON.stringify(state.map(1.75,fadeOut))),{sourceTime:1.75,blackAlpha:.5});
  const fadeIn={transitionSeconds:.5,segments:[{start:0,end:2,transition:'fade-from-black'},{start:3,end:5,transition:'none'}]};
  assert.deepEqual(JSON.parse(JSON.stringify(state.map(2.25,fadeIn))),{sourceTime:3.25,blackAlpha:.5});
});

test('multi-clip editor is additive, multi-track, and keeps the first-upload video element for preview', () => {
  assert.match(html, /<section id="multi-timeline" class="video-only mtl-shell"/);
  for (const id of ['mtl-add-clip','mtl-file-input','mtl-media-pool','mtl-main-track','mtl-overlay-track','mtl-audio-track','mtl-playhead','mtl-ruler','mtl-context-menu','mtl-transition-popover']) assert.match(html,new RegExp(`id="${id}"`));
  for (const action of ['cut','delete','undo','redo','zoom-in','zoom-out']) assert.match(html,new RegExp(`data-mtl-action="${action}"`));
  for (const action of ['delete','duplicate','split']) assert.match(html,new RegExp(`data-mtl-context="${action}"`));
  assert.match(html, /src="\.\/multi-timeline\.js"/);
  assert.match(multiTimeline, /\/\/ === MULTI-TIMELINE MODULE ===/);
  assert.match(multiTimeline, /function addDropHandlers\(track, trackName\)/);
  assert.match(multiTimeline, /function onClipPointerDown\(event\)/);
  assert.match(multiTimeline, /function splitClip\(clip, at\)/);
  assert.match(multiTimeline, /function getExportPlan\(clips = state\.clips\)/);
  assert.match(multiTimeline, /function mapOutputTime\(outputTime, plan\)/);
  assert.match(multiTimeline, /function renderOverlays\(outputCanvas, time, plan = null\)/);
  assert.match(multiTimeline, /bridge\(\)\.ensureVideoSource\?\.\(media\.src\)/);
  assert.doesNotMatch(multiTimeline, /videoElement\.replaceWith|videoEl\.replaceWith/);
  assert.match(script, /window\.multiTimeline\?\.adoptFirstVideo\(file,videoEl,videoObjectUrl,dur,videoTrim\)/);
  assert.match(script, /async function exportMultiClip\(clips\)/);
  assert.match(script, /window\.exportProject=\(\)=>window\.multiTimeline\?\.isReady\?\.\(\)\?exportMultiClip/);
  assert.match(script, /window\.multiTimeline\?\.isReady\?\.\(\)/);
  assert.match(script, /multiFramePlan=editPlan\.multiClip\?window\.multiTimeline\?\.mapOutputTime/);
  assert.match(script, /window\.multiTimeline\.renderOverlays\(output,outputTime,editPlan\)/);
  assert.match(script, /Segment \$\{segmentIndex\}\/\$\{segmentCount\}/);
  assert.match(html, /id="shortcuts-bar"[\s\S]*?id="shortcut-footer"/);
  assert.match(styles, /#shortcuts \{ display: none !important; \}/);
  const sidebar = html.match(/<aside id="sidebar">([\s\S]*?)<\/aside>/)?.[1] || '';
  assert.doesNotMatch(sidebar, /<kbd|class="shortcut"/, 'sidebar controls and section headers do not render keybind labels');
  assert.equal((html.match(/class="shortcuts-bar"/g) || []).length, 1, 'the bottom shortcuts bar is the only rendered shortcut reference');
  assert.doesNotMatch(html, /<kbd>INFO<\/kbd>/i, 'the shortcuts modal has no INFO keycaps');
  assert.match(html, /<div id="shortcut-footer" class="shortcuts-bar"[\s\S]*?SPACE[\s\S]*?RESET[\s\S]*?EXPORT[\s\S]*?EXPAND[\s\S]*?CROP/);
  assert.match(html, /id="shortcut-footer" class="shortcuts-bar"/);
  assert.match(styles, /#shortcut-footer\.shortcuts-bar \{ position: relative; z-index: 0;/);
  assert.match(html, /data-mtl-action="step-back"[\s\S]*?−5s[\s\S]*?data-mtl-action="step-forward"[\s\S]*?\+5s/);
  assert.match(html, /id="mtl-zoom-slider"/);
  assert.match(html, /id="mtl-extra-video-tracks"/);
  assert.match(html, /id="mtl-extra-photo-tracks"/);
  assert.match(html, /data-track-id="video-2"[\s\S]*?V2/);
  assert.match(html, /data-track-id="photo-2"[\s\S]*?PHOTO 2/);
  assert.match(multiTimeline, /state\.tracks\.push\([\s\S]*?id: 'video-2'[\s\S]*?id: 'photo-2'/);
  assert.match(multiTimeline, /const filmLabState = window\.filmLabState/);
  assert.match(multiTimeline, /clips: filmLabState\.clips/);
  assert.match(multiTimeline, /function ensureTrack\(kind, id = null\)/);
  assert.match(multiTimeline, /function getExportManifest\(clips = state\.clips\)/);
  assert.match(multiTimeline, /playing: \{ configurable: true, enumerable: true, get: \(\) => state\.transportPlaying \}/);
  assert.match(multiTimeline, /const timelineFacade = window\.TL \|\| \{\}/);
  assert.match(multiTimeline, /window\.TL = timelineFacade/);
  assert.match(multiTimeline, /get: \(\) => state\.tracks\.map\(\(track\) => \(\{/);
  assert.match(timeline, /Object\.assign\(window\.filmLabTimeline \|\| \{\}, api\)/);
  assert.match(styles, /\.mtl-clip\.mtl-selected/);
  assert.match(styles, /#app\[data-workspace="video"\] #timeline-module,#app\[data-workspace="video"\] #editorTimeline \{ display: none !important; \}/);
  assert.match(html, /<section id="timeline-module" class="video-only"/);
});

test('timeline drag moves clips across tracks, frame-snaps, pushes collisions, and trims to a 0.1s minimum', () => {
  assert.match(multiTimeline, /\/\/ === TIMELINE DRAG MODULE ===/);
  assert.match(multiTimeline, /const FRAME_RATE = 24/);
  assert.match(multiTimeline, /const MIN_CLIP_DURATION = 0\.1/);
  assert.match(multiTimeline, /function trackAtPointerY\(clientY, clip, drag\)/);
  assert.match(multiTimeline, /drop outside an existing compatible row is a request for a new lane/);
  assert.doesNotMatch(multiTimeline, /clientY < first\.top && kind === 'video'\) return 'main'/);
  const mtlMarkup=html.slice(html.indexOf('<section id="multi-timeline"'));
  assert.ok(mtlMarkup.indexOf('id="mtl-extra-video-tracks"') < mtlMarkup.indexOf('data-track-id="main"'), 'new V2+ lanes appear above V1');
  assert.match(multiTimeline, /function pushTrackCollisions\(clip, direction\)/);
  assert.match(multiTimeline, /function onClipHoverMove\(event\)/);
  assert.match(multiTimeline, /const ghost = node\.cloneNode\(true\)/);
  assert.match(multiTimeline, /node\.setPointerCapture\(event\.pointerId\)/);
  assert.match(multiTimeline, /drag\.ghost\.parentElement !== destination\) destination\.appendChild\(drag\.ghost\)/);
  assert.match(multiTimeline, /if \(media\.type === 'video' && requested === 'main'\) return 'main'/);
  assert.match(multiTimeline, /state\.firstMediaId \|\| mainClips\(\)\.length \? ensureTrack\('video'\)\.id : 'main'/);
  assert.match(multiTimeline, /const target = media\.type === 'video' \? \(state\.firstMediaId \|\| mainClips\(\)\.length \? 'video' : 'main'\) : 'photo'/);
  const availableTrackFn=multiTimeline.match(/function availableTrack\(media, requested\) \{[\s\S]*?\n  \}/)[0];
  const availableContext=vm.createContext({});
  vm.runInContext(`const state={firstMediaId:'first',tracks:[],clips:[]}; const mainClips=()=>[]; const ensureTrack=kind=>({id:kind+'-2'}); ${availableTrackFn}; this.available=availableTrack;`,availableContext);
  assert.equal(availableContext.available({type:'video'},null),'video-2','a secondary video defaults to the pre-created V2 overlay track');
  assert.equal(availableContext.available({type:'video'},'main'),'main','explicit drops onto V1 still remain on V1');
  assert.match(multiTimeline, /Math\.max\(0, \.\.\.mainClips\(\)\.map\(clipEnd\)\)/);
  assert.match(multiTimeline, /pushTrackCollisions\(drag\.clip, Math\.sign\(drag\.clip\.start - drag\.initialStart\)\)/);
  assert.match(multiTimeline, /if \(state\.initialized\) seekTo\(state\.timelineTime, wasPlaying\)/);
  assert.match(multiTimeline, /key: `clip:\$\{track\.id\}:\$\{item\.clipId\}`/);
  assert.match(styles, /\.mtl-clip\.mtl-drag-ghost/);
  assert.match(styles, /\.mtl-trim-handle[^}]*cursor: ew-resize/);
  assert.match(styles, /\.mtl-clip \{[^}]*touch-action: none/);
});

test('the question-mark dialog lists keyboard shortcuts without moving labels into the sidebar', () => {
  const dialog=html.match(/<section class="modalCard shortcutsDialog"[\s\S]*?<\/section>/)?.[0]||'';
  for(const key of ['Space','← / →','Shift + ← / →','↑ / ↓','Home / End','Delete / Backspace','Ctrl / ⌘ + Z','Ctrl / ⌘ + Y','Ctrl / ⌘ + Shift + Z','S','R','D','E','C','?','Esc']) assert.match(dialog,new RegExp(`<kbd>${key.replace(/[.*+?^${}()|[\]\\]/g,'\\$&')}<\/kbd>`));
  assert.match(html,/id="shortcuts-bar"[\s\S]*?id="shortcut-footer" class="shortcuts-bar"/);
  assert.match(styles,/\.shortcutList \{ display: grid; grid-template-columns: repeat\(2,minmax\(0,1fr\)\)/);
  assert.match(styles,/@media \(max-width: 600px\) \{ \.shortcutList \{ grid-template-columns: minmax\(0,1fr\)/);
  assert.match(script,/e\.key==='\?'[\s\S]*?shortcutsHelpBtn/);
  const sidebar=html.match(/<aside id="sidebar">([\s\S]*?)<\/aside>/)?.[1]||'';
  assert.doesNotMatch(sidebar,/<kbd>|keyboard shortcut/i);
  assert.match(dialog,/download confirmation, or timeline menu/);
});

test('the responsive UI keeps the accessible viewport and collapses timeline controls by device width', () => {
  assert.match(html, /name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"/);
  assert.match(styles, /@media \(min-width: 768px\) and \(max-width: 1100px\)[\s\S]*?grid-template-columns: minmax\(0,3fr\) minmax\(0,2fr\)[\s\S]*?grid-template-rows: minmax\(0,1fr\) 160px/);
  assert.match(styles, /@media \(max-width: 767px\)[\s\S]*?mainArea \{ inset: 0 0 108px/);
  assert.match(styles, /#mtl-add-clip \{ position: fixed;[^}]*width: 48px/);
  assert.match(styles, /#mtl-scroll \{ flex: 1 1 auto; min-height: 34px; height: 34px/);
  assert.match(multiTimeline, /node\.setPointerCapture\(event\.pointerId\)/);
});

test('jargon tooltips, section resets, active indicators, and mask wording remain accessible', () => {
  for(const label of ['Bloom','Dither','Hallation','Anamorphic','Luma Influence','Vibrance']) assert.match(html,new RegExp(`aria-label="About ${label}"[^>]*data-tooltip=`));
  assert.match(styles,/\.infoTip::after \{ content: attr\(data-tip\);[^}]*bottom: calc\(100% \+ 8px\)/);
  assert.match(script,/function resetSection\(sectionId\)/);
  assert.match(script,/document\.querySelectorAll\('\.effectGroup,\.creativeVignette\[data-group\]'\)/);
  assert.match(script,/group\.classList\.toggle\('section--active',dirty\)/);
  assert.match(html,/class="creativeVignette photo-only" data-group="vignette"[\s\S]*?data-reset="vignette"/);
  assert.match(html,/Finish mask on the preview to resume panning/);
  assert.match(html,/id="maskStateLabel"[^>]*>NO MASK/);
});

test('transitions expose six preview choices and render frame-synced preview effects', () => {
  for (const type of ['none', 'dissolve', 'fade-to-black', 'fade-from-white', 'slide-left', 'wipe']) {
    assert.match(html, new RegExp(`data-mtl-transition="${type}"`));
  }
  assert.match(html, /id="mtl-transition-duration" min="0\.1" max="2" step="0\.1" value="0\.5"/);
  assert.match(multiTimeline, /if \(!canTransition\(clip\)\) return false;[\s\S]*?clip\.transitionOut = \{ type: normalizedType, duration:/);
  assert.match(multiTimeline, /if \(normalizedType !== 'none'\)[\s\S]*?getTransitionSource\(state\.media\.get\(clip\.mediaId\), clip\.id, clip\.track\)[\s\S]*?getTransitionSource\(state\.media\.get\(incoming\.mediaId\), incoming\.id, clip\.track\)/);
  assert.match(multiTimeline, /function transitionAt\(time, trackName = 'main'\)/);
  const transitionSource = multiTimeline.match(/function transitionAt\(time, trackName = 'main'\) \{[\s\S]*?\n  \}/)[0];
  const transitionState = vm.createContext({});
  vm.runInContext(`const state={clips:[],tracks:[]}; const canTransition=()=>true; const mainClips=()=>state.clips.filter(c=>c.track==='main').sort((a,b)=>a.start-b.start); const clipDuration=c=>c.trimEnd-c.trimStart; const clipEnd=c=>c.start+clipDuration(c); const transitionInfo=c=>({type:c.transitionOut?.type||c.transition||'none',duration:c.transitionOut?.duration||0.5}); ${transitionSource}; this.setClips=clips=>state.clips=clips; this.at=transitionAt;`, transitionState);
  transitionState.setClips([{id:'a',track:'main',start:0,trimStart:0,trimEnd:2,transitionOut:{type:'dissolve',duration:0.5}},{id:'b',track:'main',start:2,trimStart:0,trimEnd:2,transitionOut:{type:'none',duration:0.5}}]);
  assert.equal(transitionState.at(1.5).progress, 0);
  assert.equal(transitionState.at(1.75).progress, 0.5);
  assert.equal(transitionState.at(2).progress, 1);
  assert.equal(transitionState.at(2.251), null);
  transitionState.setClips([{id:'short-a',track:'main',start:0,trimStart:0,trimEnd:0.2,transitionOut:{type:'dissolve',duration:0.5}},{id:'short-b',track:'main',start:0.2,trimStart:0,trimEnd:0.2,transitionOut:{type:'none',duration:0.5}}]);
  assert.equal(transitionState.at(0.1).duration,0.2, 'a transition cannot outlast either short clip');
  transitionState.setClips([{id:'o1',track:'video-2',start:0,trimStart:0,trimEnd:2,transitionOut:{type:'wipe',duration:0.5}},{id:'o2',track:'video-2',start:2,trimStart:0,trimEnd:2,transitionOut:{type:'none',duration:0.5}}]);
  assert.equal(transitionState.at(2, 'video-2').type, 'wipe');
  assert.match(multiTimeline, /transitionAt\(time, track\.id\)/);
  assert.match(multiTimeline, /drawTransitionEffect\(layer, entry\.transition, entry\.trackId\)/);
  assert.match(multiTimeline, /function getTransitionSource\(media, clipId, trackName = 'main'\)/);
  const transitionSourceFn = multiTimeline.match(/function getTransitionSource\(media, clipId, trackName = 'main'\) \{[\s\S]*?\n  \}/)[0];
  const transitionSourceContext = vm.createContext({ document: { createElement: () => ({ addEventListener() {}, load() {} }) } });
  vm.runInContext(`const transitionPreviewElements=new Map(); const transitionLayer=null; ${transitionSourceFn}; this.get=getTransitionSource; this.cache=transitionPreviewElements;`, transitionSourceContext);
  const testMedia = { id: 'same-media', type: 'video', src: 'blob:test' };
  assert.notEqual(transitionSourceContext.get(testMedia, 'left-split'), transitionSourceContext.get(testMedia, 'right-split'), 'split clips need independent transition frames');
  assert.equal(transitionSourceContext.get(testMedia, 'left-split'), transitionSourceContext.get(testMedia, 'left-split'));
  assert.match(multiTimeline, /function renderTransitionPreview\(\)/);
  assert.match(multiTimeline, /drawTransitionFrame\(ctx, incoming, 0, width, height, progress\)/);
  assert.match(multiTimeline, /transition\.type === 'slide-left'/);
  assert.match(multiTimeline, /transition\.type === 'wipe'/);
  assert.match(multiTimeline, /renderTransitionPreview\(\);/);
});

test('preview and overlay export share transition compositing and hold slide / wipe frames after the cut', () => {
  const drawFrame=multiTimeline.match(/function drawTransitionFrame\(ctx, element, x, width, height, alpha = 1\) \{[\s\S]*?\n  \}/)[0];
  const compose=multiTimeline.match(/function drawTransitionComposition\(ctx, transition, time, outgoing, incoming, width, height\) \{[\s\S]*?\n  \}/)[0];
  const context=vm.createContext({HTMLVideoElement:class HTMLVideoElement{}});
  vm.runInContext(`${drawFrame}; ${compose}; this.compose=drawTransitionComposition;`,context);
  const frame=(name)=>({name,naturalWidth:100,naturalHeight:50});
  const composeAt=(type,time,progress=0.5)=>{
    const ctx={globalAlpha:1,fillStyle:'',calls:[],drawImage(element,x){this.calls.push({name:element.name,x,alpha:this.globalAlpha});},fillRect(){this.calls.push({fill:this.fillStyle,alpha:this.globalAlpha});},clearRect(){},save(){},beginPath(){},rect(){},clip(){},restore(){}};
    context.compose(ctx,{type,cut:2,duration:0.5,progress},time,frame('outgoing'),frame('incoming'),100,50);
    return ctx.calls;
  };
  for(const type of ['slide-left','wipe']) {
    const calls=composeAt(type,2.1);
    assert.deepEqual(JSON.parse(JSON.stringify(calls)),[{name:'incoming',x:0,alpha:1}],`${type} remains fully visible after the cut`);
  }
  assert.equal(composeAt('dissolve',1.875,0.25)[1].alpha,0.25);
  assert.deepEqual(JSON.parse(JSON.stringify(composeAt('fade-to-black',1.875).at(-1))),{fill:'#000',alpha:0.5});
  assert.deepEqual(JSON.parse(JSON.stringify(composeAt('fade-from-white',2.125).at(-1))),{fill:'#fff',alpha:0.5});
  assert.equal((multiTimeline.match(/drawTransitionComposition\(/g)||[]).length,3,'preview and overlay export call the same compositing routine');
});

test('dissolve frames advance the incoming overlay and audio tracks cannot receive visual transitions', () => {
  const sourceTimeFn=multiTimeline.match(/function transitionSourceTime\(transition, clip, side, time\) \{[\s\S]*?\n  \}/)[0];
  const timeContext=vm.createContext({});
  vm.runInContext(`${sourceTimeFn}; this.map=transitionSourceTime;`,timeContext);
  const dissolve={type:'dissolve',cut:2,duration:0.5,progress:0.5};
  const outgoing={start:0,trimStart:0,trimEnd:2};
  const incoming={start:2,trimStart:4,trimEnd:6};
  assert.equal(timeContext.map(dissolve,incoming,'incoming',1.75),4.25, 'incoming dissolve frames advance during the blend in preview and overlay export');
  assert.equal(timeContext.map(dissolve,outgoing,'outgoing',1.75),1.75);
  const canTransitionFn=multiTimeline.match(/function canTransition\(clip\) \{[\s\S]*?\n  \}/)[0];
  const mediaContext=vm.createContext({});
  vm.runInContext(`const state={tracks:[{id:'main',kind:'video'},{id:'photo-1',kind:'photo'},{id:'audio',kind:'audio'}],media:new Map([['v',{type:'video'}],['p',{type:'image'}],['a',{type:'audio'}]])}; ${canTransitionFn}; this.can=canTransition;`,mediaContext);
  assert.equal(mediaContext.can({track:'main',mediaId:'v'}),true);
  assert.equal(mediaContext.can({track:'photo-1',mediaId:'p'}),true);
  assert.equal(mediaContext.can({track:'audio',mediaId:'a'}),false);
  assert.match(multiTimeline,/state\.tracks\.filter\(\(item\) => item\.kind === 'video' \|\| item\.kind === 'photo'\)/);
  assert.match(multiTimeline,/state\.tracks\.find\(\(track\) => track\.id === trackName\)\?\.kind === 'audio'/);
  assert.match(multiTimeline,/if \(!canTransition\(clip\)\) return false;/);
  assert.match(multiTimeline,/transition: transition\.type, transitionDuration: transition\.duration/);
  assert.match(multiTimeline,/transitionSourceTime\(transition, transition\.incoming, 'incoming', overlayTime\)/);
});

test('lane changes keep playback on the edited timeline and do not jump over overlay gaps', () => {
  const playSource = multiTimeline.match(/function play\(\) \{[\s\S]*?\n  \}/)[0];
  const playback = vm.createContext({});
  vm.runInContext(`const state={timelineTime:1,projectDuration:5,transportPlaying:false,clips:[{track:'main',start:3}]}; let gapCall=null,tickCount=0; const performance={now:()=>10}; const getMainAt=()=>null; const setGapAt=(at,autoplay)=>{gapCall={at,autoplay};}; const updateTransportButton=()=>{}; const ensureTick=()=>tickCount++; ${playSource}; this.run=play; this.gap=()=>gapCall; this.ticks=()=>tickCount;`, playback);
  playback.run();
  assert.deepEqual(JSON.parse(JSON.stringify(playback.gap())), {at:1,autoplay:true}, 'playback stays in the gap instead of jumping to the next V1 clip');
  assert.equal(playback.ticks(), 1);
  assert.doesNotMatch(multiTimeline, /getMainAt\(state\.timelineTime\) \|\| mainClips\(\)\.find/);
  assert.match(multiTimeline, /if \(state\.initialized\) seekTo\(state\.timelineTime, wasPlaying\)/);
  assert.match(multiTimeline, /key: `clip:\$\{track\.id\}:\$\{item\.clipId\}`/);
});

test('video editing shortcuts provide frame stepping, clip deletion, and reversible history without hijacking fields', () => {
  assert.match(multiTimeline,/target\?\.closest\('input,textarea,select,\[contenteditable="true"\],\[role="dialog"\]'\)/);
  assert.match(multiTimeline,/event\.shiftKey\) redo\(\); else undo\(\)/);
  assert.match(multiTimeline,/event\.key === 'Delete' \|\| event\.key === 'Backspace'[\s\S]*?deleteSelected\(\)/);
  assert.match(multiTimeline,/const step = event\.shiftKey \? 5 : 1 \/ FRAME_RATE/);
  assert.match(multiTimeline,/event\.key\.toLowerCase\(\) === 'y' \|\| event\.shiftKey/);
  assert.match(multiTimeline,/event\.key\.toLowerCase\(\) === 's'[\s\S]*?splitClip\(state\.selected, state\.timelineTime\)/);
  assert.match(multiTimeline,/target\?\.closest\('#mtl-playhead,#mtl-ruler-playhead,#cropFrame,#trimStartHandle,#trimEndHandle'\)/);
  assert.match(multiTimeline,/event\.key === 'Escape' && !target\?\.closest\('\[role=\"dialog\"\]'\)[\s\S]*?hideMenus\(\)/);
  assert.match(script,/if\(isVideo\) processVideo\(\); else downloadImage\(\)/);
  assert.match(html,/← \/ → <b>FRAME STEP<\/b>[\s\S]*?DEL <b>DELETE CLIP<\/b>[\s\S]*?⌘\/CTRL Z <b>UNDO<\/b>[\s\S]*?⌘\/CTRL SHIFT Z <b>REDO<\/b>/);
});

test('V2+ composite against the actual preview frame and keep playback running for overlay-only tails', () => {
  assert.match(multiTimeline, /overlayVideoElement\.src = src/);
  assert.match(multiTimeline, /media\.imageElement \|\| media\.overlayVideoElement \|\| media\.videoElement/);
  assert.match(multiTimeline, /const overlayVideo = media\.overlayVideoElement \|\| media\.videoElement/);
  assert.match(multiTimeline, /overlayLayer\.style\.left = `\$\{baseRect\.left - stageRect\.left\}px`/);
  assert.match(multiTimeline, /end < state\.projectDuration - 0\.025[\s\S]*?setGapAt\(end, true\)/);
  assert.match(multiTimeline, /else if \(state\.timelineTime >= state\.projectDuration\)/);
  assert.doesNotMatch(multiTimeline, /else if \(!state\.pendingMain \|\| state\.timelineTime >= state\.projectDuration\)/);
  assert.match(styles, /\.mtl-preview-overlay \{ position: absolute; z-index: 9; display: block;/);
});

test('multi-timeline export mapping preserves trims, gap frames, transition choices, and configured duration', () => {
  const mapper=multiTimeline.match(/function mapOutputTime\(outputTime, plan\) \{[\s\S]*?\n  \}/)[0];
  const state=vm.createContext({});
  vm.runInContext(`${mapper}\nthis.map=mapOutputTime;`,state);
  const a={index:0,start:0,end:2,trimStart:1,trimEnd:3,source:'a.mp4',transition:'dissolve'};
  const b={index:1,start:2,end:4,trimStart:4,trimEnd:6,source:'b.mp4',transition:'none'};
  a.next=b;
  assert.deepEqual(JSON.parse(JSON.stringify(state.map(1.75,{duration:4,segments:[a,b]}))),{sourceTime:2.75,source:'a.mp4',blendTime:4.25,blendSource:'b.mp4',blend:0.5,clipIndex:0,blackAlpha:0});
  const gap={index:1,start:2,end:3,gap:true,blackFrame:true};
  assert.equal(state.map(2.5,{duration:3,segments:[{index:0,start:0,end:2,trimStart:0,trimEnd:2,source:'a.mp4'},gap]}).gap,true);
  const slide={index:0,start:0,end:2,trimStart:0,trimEnd:2,source:'a.mp4',transition:'slide-left',transitionDuration:1};
  const incoming={index:1,start:2,end:4,trimStart:4,trimEnd:6,source:'b.mp4',transition:'none'};
  slide.next=incoming;
  assert.deepEqual(JSON.parse(JSON.stringify(state.map(1.75,{duration:4,segments:[slide,incoming]}))),{sourceTime:1.75,source:'a.mp4',blendTime:4.25,blendSource:'b.mp4',blend:0.5,transitionType:'slide-left',clipIndex:0,blackAlpha:0});
  slide.transition='wipe';
  assert.equal(state.map(1.75,{duration:4,segments:[slide,incoming]}).transitionType,'wipe');
  const fade={index:0,start:0,end:2,trimStart:0,trimEnd:2,source:'a.mp4',transition:'fade-to-black',transitionDuration:0.5};
  const fadeIn={index:1,start:2,end:4,trimStart:0,trimEnd:2,source:'b.mp4',transition:'none'};
  fade.next=fadeIn;
  assert.equal(state.map(1.875,{duration:4,segments:[fade,fadeIn]}).overlayAlpha,0.5);
  assert.equal(state.map(2.125,{duration:4,segments:[fade,fadeIn]}).overlayAlpha,0.5);
  fade.transitionDuration=0.8; fadeIn.transitionDuration=0.2;
  assert.ok(Math.abs(state.map(2.2,{duration:4,segments:[fade,fadeIn]}).overlayAlpha-0.5)<1e-9, 'the outgoing clip controls both halves of its transition duration');
  const fadeGap={index:1,start:2,end:3,gap:true,blackFrame:true};
  const afterGap={index:2,start:3,end:4,trimStart:0,trimEnd:1,source:'c.mp4',transition:'none'};
  assert.equal(state.map(3.1,{duration:4,segments:[fade,fadeGap,afterGap]}).overlayAlpha,0, 'transitions never leak across a timeline gap');
  fade.transition='fade-from-white';
  assert.equal(state.map(1.875,{duration:4,segments:[fade,fadeIn]}).overlayColor,'#fff');
  assert.match(multiTimeline,/Math\.min\(transition\.duration, clipDuration\(previousClip\), duration\)/);
  assert.match(script,/mapped\.transitionType\|\|'dissolve'/);
  assert.match(script,/mapped\.overlayColor\|\|'#000'/);
  assert.match(multiTimeline,/transitionAt\(overlayTime, track\.id\)/);
});

test('multi-timeline export plan honors transition duration and only overlaps adjacent dissolves', () => {
  const source=multiTimeline.match(/function getExportPlan\(clips = state\.clips\) \{[\s\S]*?\n  \}/)[0];
  const context=vm.createContext({});
  vm.runInContext(`const state={media:new Map()}; const clipDuration=c=>Math.max(0.1,c.trimEnd-c.trimStart); const clipEnd=c=>c.start+clipDuration(c); const transitionInfo=c=>({type:c?.transitionOut?.type||c?.transition||'none',duration:c?.transitionOut?.duration||0.5}); const getExportManifest=()=>({}); const getOverlaysAt=()=>[]; ${source}; this.setMedia=items=>state.media=new Map(items); this.plan=getExportPlan;`,context);
  const a={id:'a',mediaId:'ma',track:'main',start:0,trimStart:0,trimEnd:2,transition:'dissolve',transitionOut:{type:'dissolve',duration:1.2}};
  const b={id:'b',mediaId:'mb',track:'main',start:2,trimStart:0,trimEnd:2,transition:'none',transitionOut:{type:'none',duration:0.5}};
  context.setMedia([['ma',{type:'video',src:'a.mp4'}],['mb',{type:'video',src:'b.mp4'}]]);
  let plan=context.plan([a,b]);
  assert.equal(plan.duration,2.8);
  assert.equal(plan.segments[0].transitionDuration,1.2);
  assert.equal(plan.segments[0].next,plan.segments[1]);
  const wipe={...a,transition:'wipe',transitionOut:{type:'wipe',duration:1.2}};
  plan=context.plan([wipe,b]);
  assert.equal(plan.duration,4);
  assert.equal(plan.segments[0].next,plan.segments[1]);
  const separated={...b,start:3};
  plan=context.plan([wipe,separated]);
  assert.ok(plan.segments.some(segment=>segment.gap));
  assert.equal(plan.segments.find(segment=>!segment.gap).next,undefined);
});

test('FFmpeg stays dormant until video upload and export progress opens only on export', () => {
  const upload=script.match(/async function handleVideoFile\(file\)\{[\s\S]*?\n\}/)[0];
  assert.match(upload, /loadFFmpeg\(\)\.catch/);
  assert.match(script, /ff=await loadFFmpeg\(\)/);
  assert.doesNotMatch(script, /loadFFmpeg\(\)\.catch\(error=>console\.warn\('Video encoder preload failed/);
  assert.match(script, /progressWrap\.classList\.add\('show'\)/);
  assert.match(html, /id="exportProgress" role="dialog" aria-modal="true"/);
});

test('video export UI exposes only trimmed output, requested sizes, formats and quality with live encoding status', () => {
  for(const id of ['videoResolution','videoContainer','videoQuality','videoExportRange','processVideoBtn','longVideoWarning','progressEta']) assert.match(html,new RegExp(`id="${id}"`));
  for(const value of ['original','1080','720']) assert.match(html,new RegExp(`<option value="${value}"`));
  assert.doesNotMatch(html, /<option value="480">480p/);
  assert.doesNotMatch(html, /<option value="full">Full video/);
  assert.match(html, /id="videoExportRange" value="trimmed"/);
  const exportPanel=html.match(/<section id="videoExportPanel"[\s\S]*?<\/section>/)[0];
  assert.ok(exportPanel.indexOf('id="videoResolution"')<exportPanel.indexOf('<details'), 'resolution stays visible without expanding More video options');
  assert.match(exportPanel, /data-video-format="mp4"[\s\S]*?data-video-quality="high"[\s\S]*?id="videoResolution"/);
  assert.match(html, /id="processVideoBtn"[^>]*>⤓ Export Video/);
  assert.match(html, /Download ready/);
  assert.match(script, /const range='trimmed';[\s\S]*?social\.trimRange\(videoEl\.duration,videoTrim\.start,videoTrim\.end\)/);
  assert.match(script, /function videoOutputSize\(options,position,resolution\)/);
  assert.match(script, /social\.videoArgs\(\{fps,duration:count\/fps,container,quality,audio:false,output:segment\}\)/);
  assert.match(script, /ff\.on\('progress'/);
  assert.match(script, /setInterval\(updateExportEta,1000\)/);
  assert.match(script, /progressText\.textContent=`Encoding… \$\{pct\}%`/);
  assert.match(script, /downloadBlob\(out,filename\)/);
  assert.match(script, /Download started automatically/);
});

test('caption position keyframes interpolate across the clip and video output presets retain aspect ratio', () => {
  const caption=script.match(/function captionPositionAt\(time\)\{[\s\S]*?\n\}/)[0];
  const size=script.match(/function videoOutputSize\(options,position,resolution\)\{[\s\S]*?\n\}/)[0];
  const state=vm.createContext({captionKeyframes:[{time:0,position:{x:.2,y:.4}},{time:10,position:{x:.8,y:.6}}],captionPosition:{x:.5,y:.82}});
  vm.runInContext(`${caption}\nthis.at=captionPositionAt;`,state);
  assert.deepEqual(JSON.parse(JSON.stringify(state.at(5))),{x:.5,y:.5});
  const dimensions=vm.createContext({canvas:{width:1920,height:1080},social:{cropRatio:()=>16/9,cropRect:(w,h)=>({width:w,height:h})}});
  vm.runInContext(`${size}\nthis.size=videoOutputSize;`,dimensions);
  assert.deepEqual(JSON.parse(JSON.stringify(dimensions.size({}, {}, '720'))),{width:1280,height:720});
  assert.deepEqual(JSON.parse(JSON.stringify(dimensions.size({}, {}, 'original'))),{width:1920,height:1080});
});

test('a video can be dropped directly on the canvas and Back still returns to the existing drop zone', () => {
  assert.match(script, /canvasWrap\.addEventListener\('drop',e=>\{[\s\S]*?handleFiles\(e\.dataTransfer\.files\)/);
  const fn = script.match(/function backToDropZone\(\)\{[\s\S]*?\n\}/)[0];
  const calls=[];
  const elements={captionEnabled:{checked:true},captionText:{value:'A title'},processVideoBtn:{style:{display:'flex'}}};
  const state=vm.createContext({
    mediaBusy:false,exportBusy:false,fileLoadId:8,animId:12,isVideo:true,hasContent:true,
    currentPhoto:{},activePhotoIndex:0,showOriginal:true,splitPreview:true,cropEditing:true,maskPaintMode:'protect',captionPosition:{x:.2,y:.2},
    cancelAnimationFrame:id=>calls.push(['cancel',id]),unloadVideo:()=>calls.push(['unload']),clearPhotos:()=>calls.push(['clearPhotos']),
    beforeLabel:{classList:{remove:name=>calls.push(['label',name])}},clearSubjectMask:flag=>calls.push(['clearMask',flag]),renderCaptionKeyframeMarkers:()=>calls.push(['keyframes']),
    dropZone:{style:{}},canvasWrap:{style:{}},$:id=>elements[id],renderPhotoStrip:()=>calls.push(['strip']),updateSocialUI:()=>calls.push(['ui']),
  });
  vm.runInContext(`${fn}\nthis.back=backToDropZone;`,state); state.back();
  assert.equal(state.fileLoadId,9); assert.equal(state.animId,null); assert.equal(state.isVideo,false); assert.equal(state.hasContent,false);
  assert.equal(state.showOriginal,false); assert.equal(state.splitPreview,false); assert.equal(state.cropEditing,false);
  assert.equal(elements.captionEnabled.checked,false); assert.equal(elements.captionText.value,'');
  assert.equal(state.dropZone.style.display,'flex'); assert.equal(state.canvasWrap.style.display,'none');
  assert.equal(elements.processVideoBtn.style.display,'none');
  assert.ok(calls.some(c=>c[0]==='unload')); assert.ok(calls.some(c=>c[0]==='clearMask'&&c[1]===true));
});
