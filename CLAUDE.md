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
Same-note re-plucks while the string rings (legato eighths): a ghost candidate with a >= 3 dB dip just before it, OR a >= 16 dB
click above 1.5 kHz, AND the level still within 4 dB 150 ms later, splits the note (a ghost instead dies away).

## Scoring against real tabs (`test/score_tab.js`)
`node test/score_tab.js samples/song.wav samples/song_ref.js [-v]` aligns detected pitches with a tab's pitch sequence (no timing
needed) and prints per-section correct / wrong(octave) / missed / extra and precision. Reference files are written by hand from the
owner's tabs and stay in samples/ (copyrighted). Decode MP3s like the browser does (Playwright OfflineAudioContext) at 48 and 44.1 kHz.
| song | file | found | precision |
|---|---|---|---|
| Come Together (Beatles) | samples/ct48.wav + ct_ref.js | 42.9% -> 54.9% (44.1k: 56.6%) | 67.5% -> 72.8% |
Biggest remaining losses: legato repeated eighths in the outro/solos (re-plucks invisible in the bass band), wrong pitches in the
riff (the high F3 tied note / G-A hammer read as a slide), octave errors. repluckClickDb 10 would give 59.5% but adds a doubtful
note to the Nov stem (14.66 s) - ask the owner.
Debug helper idea: spectrogram PNG with detected notes overlaid (numpy+matplotlib) is the best way to judge real files.

## Next ideas (in rough priority)
1. "Hear the tab": play the detected notes over the song to find mistakes by ear.
2. Click a note to cycle alternative fingerings and lock the chosen ones (`fingering.assign(notes, open, {locks})` already accepts locks).
3. Export ASCII tab / PDF; print layout.
4. MP3 input (browser can decode it; allow the type in `app.js`/`index.html`, then test on real mp3s).
5. 5-string / other tunings; triplet and swing grids; tempo changes.
6. Higher accuracy: trained model (e.g. Basic Pitch) offline in Python, with the web UI only displaying results.

## Generality (owner asked: are fixes only for these WAVs?)
Fixes target mechanisms (sample-rate dependence, octave tails, two-step attacks, ghost touches), each guarded by synthetic tests, but
thresholds were tuned on only TWO real stems (PTFM, the Nov 2026 stem). More real files with known tabs are the best next investment:
keep them in samples/ and re-run them after every analysis change.

## Known limits
Straight 16th grid at one tempo; steady tonal bleed ~10 dB under the bass can read as a low note; slides slower than ~6 semitones/s are
not detected; very soft or very fast re-attacks over a ringing note can still be missed (samplerate_test sweep: 34/42 shapes clean); slap vs pop is guessed from the string; fingering is the model's most comfortable choice, not a recording of a player.
