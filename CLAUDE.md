# Lowline (repo: b2t) - project guide for Claude Code

A browser-only bass-tab tool. The user uploads an isolated bass WAV; the app finds the notes, chooses a comfortable
fingering, quantizes the rhythm and draws a Guitar-Pro-style tab that follows the audio. No build step, no dependencies:
open `index.html` (or host on GitHub Pages). Everything runs locally in the browser.

## Layout
| file | job |
|---|---|
| `analysis.js` | audio -> notes (onsets, YIN + Viterbi pitch path, glides/jumps, slap, dead notes, vibrato). All thresholds live in `CFG` |
| `fingering.js` | notes -> string/fret/finger. Bass-technique cost model + **repeated phrases get identical fingering** |
| `rhythm.js` | tempo + downbeat estimate, 16th-grid quantization, bars, note values, rests, ties |
| `tabview.js` | draws the notation (SVG + buttons): bars, stems/beams, slurs, slides, S/P, ties, vibrato |
| `app.js` | player, waveform (drag to scrub, playing or paused), options |
| `test/` | `all.js` runs everything; `analyze_file.js my.wav` prints every note of any WAV |

Modules are UMD-style globals (`LowlineAnalysis`, `LowlineFingering`, `LowlineRhythm`, `LowlineTabView`) and also `require()`-able in Node.

## Commands
- `node test/all.js` - all suites (must stay green)
- `node test/analyze_file.js samples/song.wav out.json` - analyze a real file (put real WAVs in `samples/`, which is git-ignored)
- Browsers resample to the device rate: also check real files at 48 kHz (override `AudioContext` with `{sampleRate:48000}` in Playwright).
- UI checks: Playwright (python) driving `file:///.../index.html` works well; set files with `#fileInput`.

## How we work (important)
- The owner (George) plays bass. He wants: expert-level comfortable fingering, identical fingering for repeated phrases, and notation
  that follows Guitar Pro conventions. MP3 support is planned for later.
- Every analysis change is validated on BOTH synthetic tests and the owner's real files. Never claim accuracy that was not measured.
- Each bug gets a regression test, and the test must be shown to FAIL on the old code (`sed` a copy of the old logic) before it is trusted.
- Real stems differ from clean synthetic audio: notes can start from digital silence with a slow fade-in, kick/pad/hi-hat bleed,
  reverb, sidechain pumping, long glides. Test against that, not just clean sines.
- Commit small, descriptive commits. The repo's history is all authored by the owner via uploads of earlier versions of this code.

## State (Nov 2026)
Done: onset-based analysis, glide/jump segmentation, slide-in/out, legato, slap/pop, dead notes, vibrato, fingering engine,
rhythm engine, full notation renderer, tempo/time-signature controls, playhead line, drag-to-scrub.
Latest fixes: onset loudness gate now looks at the note body (notes that start from digital silence were dropped, which removed
the D2 pickup from some repeats of Play That Funky Music); dead notes must be within 19 dB of the loudest notes; very short quiet blips
are dropped; slap brightness skips the start-click of notes that begin from silence (threshold 0.18).
Onset size test also accepts a rise measured over ~30 ms (`onsetLookMs`), so results no longer flip with the decode rate
(Chrome decodes at the device rate, often 48 kHz; at 48 kHz the open E before the A1 in PTFM was lost). `test/samplerate_test.js`.
Stem artifacts (`test/stem_artifacts_test.js`): jump detection measures steps between real voiced frames, not across bridged
gaps (an F#1->B1 hammer-on lost its F#1); an octave-UP tail with no pluck (<8 dB rise) is folded into the note (B1 ending as 'B2');
a dead note <70 ms before a pitched note is dropped (two-step attack); a short loud hit with no settled pitch becomes a dead note.
Ghost notes over a ringing note: an energy bump >= 3 dB (odL) while the note is loud and > 120 ms old, inside a pitched note that
keeps its pitch, with a >= 5 dB short-term rise, adds an 'x' and ends the host note there. An attack on a ringing note that yields no
pitched note is also an 'x'. Measured: owner's ghosts 5.2-5.6 dB; realistic.js swells 2.1-4.3 dB. Synthetic ghosts are only caught
in a narrow band (~5-5.5 dB bump): bigger reads as a re-pluck, smaller is ignored.
Fret-touch blip: a +-1 semitone pitch change with no pluck (<= 110 ms) between two notes of one pitch is dropped - the fretting
finger landing on a ringing open E sounds F for a moment (AOBTD: 17 false F1s).
Notes below the lowest open string (5-string / drop-tuned parts on a 4-string) are fingered an octave up (`n.octaveUp`, '8va' mark
over the fret) instead of being drawn as an open string; tested in fingering_test.js #9.
A slide too long for any one string (e.g. E3 gliding 2 octaves to E1) is drawn as a slide-out from the start note (`n.slideCut`)
instead of a negative end fret; fingering_test.js #11.
Options: 5-string tuning (B E A D G; tabview draws `openMidis.length` strings) and an Octave select (-1/0/+1) that
moves every pitched note (and slide targets) before fingering; `octaveApplied` in app.js tracks it, reset on each new file.
Same-note re-plucks while the string rings (legato eighths): a ghost candidate with a >= 3 dB dip just before it, OR a >= 16 dB
click above 1.5 kHz, AND the level still within 4 dB 150 ms later, splits the note (a ghost instead dies away).

UI (Nov 2026 redesign, "record sleeve": green #0f3d2e / cream #f3ead3 / tomato #e8553b, Archivo + Archivo Black + JetBrains Mono).
Settings live in a slide-in "View & settings" panel (floating button; bottom sheet on phones). Defaults: tab only, no rhythm
stems, no bar numbers. "Tab + notation" adds a bass-clef staff (written an octave up, beamed per beat). Clicking a tab number,
a notation head or any mark (H/P, slide, slap, vibrato; `.mark-hit` boxes) plays just that note (`playClip` in app.js).

Full songs (Nov 2026): "Full song" mode separates the bass in the browser with HTDemucs v4 before analysis
(`separate-worker.js` + `vendor/demucs.js` (bakkot/demucs-js, MIT, bass-only overlap-add) + `vendor/ort` (onnxruntime-web 1.22)
+ `models/htdemucs_w16.onnx` (weights stored fp16, cast to fp32 on load: 90.5 MB, output = full model, 84 dB SNR)). Model is cached
with the Cache API. WebGPU first, else multi-threaded WASM (needs cross-origin isolation: `coi-serviceworker.js`). `?cpu=1` forces WASM.
Player gets a Bass only / Full mix switch. Memory: the model needs ~3 GB of browser RAM on the CPU path regardless of
song length or threads (measured). Owner's laptop (Dynabook, Intel Gen12 iGPU, 31 GB, Chrome 156) restarts the page mid-run, most
likely a GPU timeout on the iGPU (chrome applies exit_on_context_lost there). If a run dies during '(GPU)' separation, that browser
switches to CPU automatically (localStorage lowlineGpuCrashed); View & settings -> Separation: Auto / GPU / CPU. WEIGHTS ARE META'S, PERSONAL/RESEARCH USE ONLY (models/README.txt).
Measured on Come Together full mix vs tab: own stem 56.6% found / 73.2% precision; Demucs bass 52.6% / 77.6% (fp16 weights identical;
int8 52.3% / 77.7% but audibly different, 15.5 dB). Speed: headless WASM, 3 threads: 30 s of audio in ~90 s; real-GPU speed not measured.

Playback: at 100% speed audio plays from the decoded AudioBuffer through Web Audio (`startWA`, `nowTime`, `curPos` in app.js):
instant start after seek/drag/pause (the <audio> element lagged on real devices). Slowed speeds use <audio> (pitch preserved).
Footer shows a version label (bump it on UI releases) so the owner can tell a cached page from the new one.

## Scoring against real tabs (`test/score_tab.js`)
`node test/score_tab.js samples/song.wav samples/song_ref.js [-v]` aligns detected pitches with a tab's pitch sequence (no timing
needed) and prints per-section correct / wrong(octave) / missed / extra and precision. Reference files are written by hand from the
owner's tabs and stay in samples/ (copyrighted). Decode MP3s like the browser does (Playwright OfflineAudioContext) at 48 and 44.1 kHz.
| song | file | found | precision |
|---|---|---|---|
| Come Together (Beatles) | samples/ct48.wav + ct_ref.js | 42.9% -> 54.9% (44.1k: 56.6%) | 67.5% -> 72.8% |
| Another One Bites the Dust (Queen) | samples/ab48.wav + ab_ref.js | 89.8% (44.1k: 89.3%) | 87.9% -> 91.5% (44.1k: 92.4%) |
AOBTD tab is "one pass of the main parts": riff shapes from the tab, repeat counts from the stem's section layout. Remaining
losses there: chorus bars (C C C C# D) partly misread, a few doubled/merged 16ths.
Biggest remaining losses: legato repeated eighths in the outro/solos (re-plucks invisible in the bass band), wrong pitches in the
riff (the high F3 tied note / G-A hammer read as a slide), octave errors. repluckClickDb 10 would give 59.5% but adds a doubtful
note to the Nov stem (14.66 s) - ask the owner.
Debug helper idea: spectrogram PNG with detected notes overlaid (numpy+matplotlib) is the best way to judge real files.

## Next ideas (in rough priority)
1. "Hear the tab": synth the detected notes over the song (clicking a note already plays its clip of the recording).
2. Click a note to cycle alternative fingerings and lock the chosen ones (`fingering.assign(notes, open, {locks})` already accepts locks).
3. Export ASCII tab / PDF; print layout.
4. (done) Full-song bass separation; MP3 / m4a / ogg / flac input via decodeAudioData; files up to 10 min.
5. Other tunings (6-string, custom); triplet and swing grids; tempo changes.
6. Higher accuracy: trained model (e.g. Basic Pitch) offline in Python, with the web UI only displaying results.

## Generality (owner asked: are fixes only for these WAVs?)
Fixes target mechanisms (sample-rate dependence, octave tails, two-step attacks, ghost touches), each guarded by synthetic tests, but
thresholds were tuned on only TWO real stems (PTFM, the Nov 2026 stem). More real files with known tabs are the best next investment:
keep them in samples/ and re-run them after every analysis change.

## Known limits
Straight 16th grid at one tempo; steady tonal bleed ~10 dB under the bass can read as a low note; slides slower than ~6 semitones/s are
not detected; very soft or very fast re-attacks over a ringing note can still be missed (samplerate_test sweep: 34/42 shapes clean); slap vs pop is guessed from the string; fingering is the model's most comfortable choice, not a recording of a player.
