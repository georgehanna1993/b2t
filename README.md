# Lowline

A small browser based bass practice tool. Open `index.html` directly in a modern browser, upload an isolated WAV bassline, or try the built-in demo.

Audio playback uses the original file. Note, slap, and slide detection is a local estimate and may be inaccurate when other instruments overlap the bass.

## How the analysis works (`analysis.js`)

1. **Prepare** – mono mix, band-limit to the bass range, decimate to ~11 kHz.
2. **Onsets** – a log-energy envelope finds every note attack, so repeated notes stay separate.
3. **Pitch per note** – YIN is run *after* the attack transient. Each note is split into pitch plateaus:
   a gradual glide is a **slide**, an instant jump with no new attack is a **hammer-on / pull-off**.
4. **Techniques** – **slap/pop** from attack brightness (energy above 1.5 kHz in the first 30 ms);
   **muted/ghost notes** from transients with no pitch.
5. **Cleanup** – global tuning offset is removed, lone octave glitches are repaired.
6. **Fretting** – a Viterbi search picks string/fret per note so the hand moves as little as possible.

Tunable thresholds live in `CFG` at the top of `analysis.js`. After analysing a file, run
`lowlineDebug.notes` in the browser console to inspect every note's features
(hover a note in the tab to see its attack brightness – use it to calibrate `slapBright` on your own bass).

## Tests

```
node test/run.js            # synthetic basslines with known notes, prints accuracy
node test/make_wav.js a.wav # writes a mixed test bassline to try in the browser
```
