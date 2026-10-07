# arena-film

A private, static WebGL 2 photo and video editor with an Instagram workflow. Image uploads open **Photo Mode**; video uploads open **Video Mode** automatically, without a reload. Dropping a new file on the canvas replaces the current media, and **Back** returns to the landing drop zone. Serve the **whole repository** through a web server, for example:

```sh
python3 -m http.server 8000 --bind 0.0.0.0
```

The editor lives in `index.html`, with dependency-free crop, settings-link, ZIP, and video-command helpers in `social-tools.js`. HEIC decoding, portrait detection, and video encoding load only when needed. There is no upload API: media, masks, rendering, and downloads stay in the browser.

## Instagram export

The **Instagram Export** panel adds one-click formats without removing original-size PNG downloads:

| Format | Aspect | Exact output |
| --- | --- | --- |
| Square post | 1:1 | 1080 × 1080 |
| Portrait post | 4:5 | 1080 × 1350 |
| Story / Reel | 9:16 | 1080 × 1920 |
| Landscape | 1.91:1 | 1080 × 566 |
| Original | Source aspect | Source dimensions |

Pick a format and **drag the crop frame** to reposition it. Touch dragging works too; arrow keys fine-tune the crop, and Shift moves faster. Center resets the framing. Done framing hides the guides without losing the crop. Output dimensions update immediately. Images fill the chosen aspect without distortion; smaller sources are upscaled when necessary to meet the exact output dimensions. Oversized source photos are reduced only if they exceed the device's GPU size limits.

Export **JPG at 80–100% quality** (92% by default) or lossless **PNG**. The header Export button opens these photo settings; with a video loaded, it directly starts the selected Reel export. The original **Original-size PNG** action and `D` shortcut bypass the crop and keep the full rendered image. Preview zoom, crop guides, and UI labels never appear in normal exports.

### Before / after content

Enable **Export a before / after pair** for two matching, side-by-side crops: original on the left, edited on the right. Layouts are square **1080 × 1080**, landscape **2160 × 1080 (2:1)**, or story **1080 × 1920**. The crop frame shows the region used for each half. Before / After labels can be turned off. The separate **split preview** button compares the original and edited halves live without affecting normal exports. Pair export is for photos; videos retain their normal full-frame Before / After and split preview.

## Carousel consistency

Upload **up to 10 photos** together. A numbered thumbnail strip below the preview provides quick switching; **Add** appends within the ten-photo limit, and **Remove** removes the selected photo. A successful new main upload replaces the collection; failed imports keep the current media. Mixed photo/video selections are rejected without destroying the current collection.

**Edits are linked by design**: a preset, slider adjustment, effect switch, or pasted settings apply to every photo. Apply to all confirms the current shared edit. Each photo keeps its **own crop position and subject mask**, so switching cannot move another photo's subject or copy its mask. **Carousel ZIP** renders all photos through the same WebGL pipeline and exports numbered JPGs or PNGs in upload order. ZIP creation is local and dependency-free. Exports temporarily lock the controls, support cancellation, and restore the selected photo and preview state afterward.

Background-only dithering waits for each photo's mask during ZIP export. If no protected subject is available, that photo skips background dithering rather than unexpectedly dithering the entire image; the export status reports this.

## Presets and effects

There are **32 built-in looks** plus saved custom presets. The original six remain as quick-pick cards with tone-curve grade swatches; six feed favorites, six color stories, and the new **IG Looks** pack are grouped in **More presets**. Saved custom looks appear as cards in their own **Saved** section. The original Golden Hour remains separate from the IG pack's Golden Hour.

**IG Looks (14):** Moody Dark, Golden Hour, Clean Minimal, Dreamy Pastel, Punchy Vibrant, Film Fade, B&W Editorial, Neon Night, Soft Skin, Café Cream, Coastal Blue, Direct Flash, Terracotta, and Sage Green. Neon Night uses a new signed **Highlight Tint** control for genuine magenta highlights; negative tint adds green. At 0, this addition leaves the original looks unchanged.

All **44 effect sliders** run from −100 to +100 with neutral 0. Red adds an effect; white reduces or reverses it (charcoal in light mode). Numeric readouts show the exact value; click one to open a bounded field for precise entry. Negative Bloom and Hallation subtract glow, negative Grain inverts its noise, negative Sharpen softens, and negative Vignette Strength brightens edges. Color & Light includes exposure, contrast, saturation, temperature, selective vibrance, lifted/crushed blacks, teal/plum shadows, icy/amber highlights, and green/magenta highlight tint. Double-click any effect slider to reset it to 0; `R` resets all effect values and returns dithering to Full photo.

Each effect has an ON/OFF switch that bypasses rendering without erasing values. Its chevron expands the advanced controls. All built-in looks leave **sharpening and dithering at 0**; manual settings and custom presets remain available. Preset transitions retain **340 ms**. Saved looks remember effect switches and Dither scope, persist in `film_lab_presets_v4`, and can be selected or deleted from their Saved cards or the More presets selector. Older presets load newer controls at 0, preserving legacy translations and migrations.

### Dither and grain

Dither is a separate signed effect: negative intensity produces a monochrome print, positive produces a color print, and 0 leaves the image unchanged. Color Steps and Dot Size adjust the pattern. Choose **Full photo** or **Background only**. Background Only lazily uses the locally bundled [MediaPipe Selfie Segmentation](vendor/mediapipe-selfie/README.md) model to protect **people**; Protect and Erase brushes handle other subjects or corrections. Detection and brushes never upload the photo.

Painting pauses drag-to-pan and hides crop guides so the two drag modes cannot conflict; wheel/button zoom still work. Tap Done painting to resume panning. On phones, selecting a brush brings the photo into view. Masks belong to their photo, survive carousel switching, and reset when that photo is replaced or Clear Mask is used. Saved looks and shared settings remember scope, not photo-specific masks. Dither and halftone are photo-only effects and are not available in Video Mode. Background-only masking is unavailable for videos.

Photo grain is **still**, regardless of Grain Speed, including old presets and exports. Grain Speed continues to animate video grain.

## Reels trim and video export

Upload a video to enter **Video Mode**. The workspace places the WebGL preview and playback controls above the editing timeline, with the editor sidebar on the right. The original trim, sampled thumbnails, decoded audio waveform (when the browser supports the codec), ruler, zoomable scrubbing, quick 15s / 30s / 60s trims, and playback controls remain available. Clips longer than 60 seconds show a performance warning; the initial selected region is limited to 60 seconds.

The additive multi-track editor starts with **V1 / V2**, **PHOTO 1 / PHOTO 2**, and a locked audio lane. The media pool's **+ Add** action appends media without replacing the first-upload preview video. Drag clips across tracks, frame-snap edits, trim or split at the playhead, and use undo / redo history. Visual tracks support **None / hard cut, Dissolve, Fade to black, Fade from white, Slide left, and Wipe**, with adjustable duration; audio cannot receive visual transitions. Preview playback follows the edited timeline, and multi-clip / multi-track transitions are mapped into export. Playback supports Space, current/total time, volume/mute, and **0.5× / 1× / 1.5× / 2×** speeds.

A single **Text & Captions** layer can be styled with font, size, and color, dragged on the preview, shown or hidden for the clip, and positioned with simple timeline keyframes. Captions are composited into video output. Dropping another video onto the canvas replaces the current clip.

### Delivery presets

Choose a **frame**: Original, 720p, 1080p, or 4K; **24 / 30 / 60 fps**; a **bitrate** of Economy (4 Mbps), Standard (8), High (16), or Max (28); **MP4 / WebM**; and **Low / Medium / High** frame quality. The panel shows the exact **output size, frame rate, bitrate, and an estimated file size** for the current edit, and the export progress dialog reports the same numbers while it encodes. The chosen frame rate drives the encoder, so trim boundaries resolve to that frame's precision. Output dimensions are padded to even values where needed for the codec, and a cropped or resized frame is scaled from the unrounded crop, so a 4K vertical Reel is exactly 2160 × 3840.

### Aspect presets and auto-reframe

**9:16, 1:1, 4:5, and 16:9** pills crop the exported Reel to a platform's shape, and a draggable **focus dot** chooses which part of the frame survives the crop — drag it on the preview, or use **Centre** to reset it. **Auto-reframe** analyses the current frame's saliency and puts the focus point on the busiest region. The pills and the sidebar's own crop row are the same setting in both directions, and the export uses exactly the frame the panel reports.

### Stabilisation and looks

Stabilisation is an optional **second pass over the finished file** with a strength slider: the editor asks the engine for `vidstab` when the build has it and falls back to `deshake` otherwise. Audio is copied through untouched, and if the engine cannot stabilise at all the export finishes normally and says so instead of failing.

The **Look / LUT** panel applies any `.cube` LUT — the same registry the Grade tab fills — to **one clip or the whole timeline**, with a strength slider (0–100%). A clip's own look wins over the timeline look, and the export resolves the look per clip, so a look on one clip only touches that clip. The strength is mixed in the grading shader, so 0% is exactly the ungraded pixel. Import a LUT in either panel and both lists update.

### Audio lane

The Audio panel draws the clip's decoded **waveform** with the volume automation on top. Set **gain**, **fade in**, **fade out**, **volume keyframes** at the playhead, a one-click **Normalise** (`loudnorm`), and **background-noise reduction** (`afftdn`, 3–30 dB) with room / HVAC / street presets. **Record voice** captures a take with the microphone (MediaRecorder) and mixes it into the export under the source audio; recorded takes are listed with their timing and can be removed. Everything is local: no audio is uploaded. Recorded audio keeps the audio path alive even when **Keep source audio** is off.

Video exports preserve the source aspect ratio unless an aspect preset is chosen. MP4 uses H.264 with AAC source audio when present; WebM uses VP8 with Opus. Skip source audio in More video options. All applicable WebGL effects remain active in video export, while Dither/Halftone are unavailable in Video Mode. Preview zoom never affects output framing.

After a video upload succeeds, the app initializes one shared instance of the locally bundled [ffmpeg.wasm wrapper/worker](vendor/ffmpeg/README.md) and downloads the single-threaded core from a CDN in the background (**about 31 MB**, internet required). Nothing is initialized for photo-only sessions, and the progress dialog stays hidden until export begins. WebCodecs `VideoFrame` uploads are used where supported, with a video-element/canvas fallback. Two-second encoding sections bound raw-frame memory; for one continuous segment, source audio is read from the uploaded Blob through WORKERFS where available and joined at the selected offset. Original audio is omitted when timeline gaps or transitions make the edit non-contiguous. The shared progress dialog shows encoding percentage and an estimated time remaining; completed exports download automatically and the Video Export status reports completion. Temporary frames, sections, and worker files are cleaned up after success, failure, or cancellation. Longer, high-resolution clips with heavy effects can take several minutes on slower devices; Cancel export restores the preview.

## Copy, paste, and look links

**Copy settings** copies a portable snapshot of every effect value, effect switch, Dither scope, and crop/photo export option. A browser-storage copy survives reloads if the system clipboard is unavailable. **Paste settings** accepts copied settings or a look link, falling back to the stored browser copy. It does not replace uploaded media or masks.

**Share this look as a link** encodes the current settings in a versioned `#look=v1.…` URL hash. Opening the link restores the look before an upload; the recipient supplies their own photos. Links include **no photos, masks, per-photo crop positions, or video trim points**. Values and versions are validated; invalid links leave the current edit unchanged. Changing edits does not rewrite an existing shared link until Share is pressed again.

## Uploads, preview, and style

Photos support JPG, PNG, HEIC, and HEIF, including uppercase extensions and empty MIME types. When native HEIC/HEIF decoding is unavailable, the locally bundled [heic2any 0.0.4](vendor/LICENSE.heic2any.md) decoder converts the first photo frame to PNG in the browser, with a CDN decoder fallback. Conversion is cached within the carousel, and stale imports cannot replace a newer upload. Other browser-decodable image types can also be opened.

Hover and scroll to zoom from **50% to 500%**, or use the − / + buttons on desktop or touch. Pinch with two fingers to zoom around the gesture midpoint; drag to pan when zoomed, and click the percentage to reset to fit. Desktop double-click opens the picker when no mask brush is active; touch double-taps never trigger the picker, and crop-frame gestures do not reopen it. Zoom changes the preview only, never the export pixels.

The Juwain Haque header keeps the portfolio's **24px / 40px / 64px** gutters. On phones, header actions move behind one **···** menu, while the editor controls become a draggable bottom sheet with Looks, Adjust, and Export tabs; swipe up or tap the handle to expand it and swipe down or tap again to minimize it. The **Looks** view opens first, **Adjust** groups controls into Basic, Creative, and Technical clusters, and **Export** focuses on the relevant photo or video settings. Video retains its existing playback, speed, volume, and looping controls, plus a compact scrubber below the preview. Hold the canvas pill to compare with the original. The icon-only sun/moon control switches dark/light UI without changing media pixels, saves `film_lab_theme`, and defaults to dark. The portfolio-style dot-and-ring cursor leaves the native cursor available and is disabled for touch and reduced motion. New panels retain the flat black/white/red aesthetic.

## Installable app and mobile use

Film Lab can be installed from Chrome/Edge on Android and desktop, or from Safari's Share menu on iPhone/iPad (**Add to Home Screen**). After the page has been open for 30 seconds, an install banner appears when the browser supports installation; dismissing it is remembered on that device. The app shell, interface scripts, and icons are available offline after the service worker has installed. Large media-processing assets (FFmpeg, MediaPipe, and TFLite models) are intentionally not cached, so exporting or mask inference may still need their first network load.

The PWA icons are generated without dependencies using `node scripts/generate-icons.cjs`. The deployment is hosted below `/film-lab/`; the manifest and service worker resolve the start page and scope relative to the page itself (`./`), so the same files also load unchanged from an Electron desktop build and from a Capacitor Android app.


| Shortcut | Action |
| --- | --- |
| Space | Video: play / pause · Photo: compare before / after |
| ← / → | Video: one frame · focused playhead: 0.1s · focused trim handle: 1/120 of clip duration |
| Shift + ← / → | Video: five seconds · focused playhead: one second · crop moves 5× · trim handle: 1/30 of clip duration |
| ↑ / ↓ | Move a focused crop frame vertically |
| Home / End | Move a focused timeline playhead or trim handle to its start / end |
| Delete / Backspace | Delete the selected video clip |
| Ctrl / ⌘ + Z | Undo the last video timeline edit |
| Ctrl / ⌘ + Y or Shift + Ctrl / ⌘ + Z | Redo the last video timeline edit |
| S | Split the selected video clip at the playhead |
| R | Reset adjustments |
| D | Export the active media: video Reel or photo PNG |
| E | Expand / collapse adjustment sections |
| C | Open / close the crop panel |
| ? | Open this shortcuts help · Esc closes dialogs and menus |

Shortcuts do not hijack text fields or native selects; Space still activates a focused button. They are listed in the question-mark dialog and the bottom shortcut bar.

## Desktop and Android builds

The same static files ship as a native desktop app (Electron, packaged for Windows/macOS/Linux via electron-builder) and as an Android APK (Capacitor). Nothing in the editor changes: `index.html` and `manifest.json` use relative asset paths, so they load from `file://`, from GitHub Pages, from the app's own loopback origin, and from `https://localhost` inside the APK.

```sh
npm install
npm run electron          # run the desktop app in dev mode
npm run build:linux       # or build:win / build:mac → dist-electron/
npm run web:stage         # stage the app shell into www/ for Capacitor
npm run android:sync      # stage, then npx cap sync android
```

Pushing a `v*` tag builds all three desktop installers through `.github/workflows/build.yml`. See [README-BUILD.md](README-BUILD.md) for prerequisites, the Android Studio/Gradle APK steps, and the notes on how the packaged apps load the site.

## Tests

```sh
node --test tests/*.test.cjs
```

Dependency-free tests cover signed controls, legacy/IG presets, crop geometry, exact output dimensions, before/after layouts, ZIP integrity, settings links, trim/encoding commands, HEIC import races, cursor, themes, and zoom. Browser validation also checks desktop/mobile touch framing, carousel consistency/cancellation, per-photo masks, saved effect switches, clipboard fallback across reloads, and real MP4/AAC and WebM encoding. Neutral output and all 18 pre-existing looks have been checked pixel-for-pixel against the preceding build.
