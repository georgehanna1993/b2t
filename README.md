# Lowline

A small browser based bass practice tool. Open `index.html` directly in a modern browser, upload an isolated WAV bassline, or try the built-in demo.

Audio playback uses the original file. Note, slap, and slide detection is a local estimate and may be inaccurate when other instruments overlap the bass.

## How the analysis works (`analysis.js`)

1. **Prepare** – mono mix, band-limit to the bass range, decimate to ~11 kHz.
2. **Onsets** – a log-energy envelope finds every note attack, so repeated notes stay separate.
3. **Pitch per note** – YIN proposes several pitch candidates per frame, and a Viterbi search picks the most
   continuous path (this removes octave flips and one-frame glitches). The path is then read for movement:
   a smooth glide is **one slide event** (start note + end note, never extra notes), an abrupt change of
   up to 5 semitones with no new attack is a **hammer-on / pull-off**, a bigger leap is a new note.
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
node test/realistic.js      # harder: synth bass + reverb + pumping + kick/hi-hat/pad bleed + long glides
OUT_WAV=stem.wav node test/realistic.js   # also writes that audio so you can try it in the browser
node test/make_wav.js a.wav # writes a mixed test bassline to try in the browser
node test/analyze_file.js my.wav out.json   # run the analyzer on ANY wav and print every note (stereo/mono, 16-bit)
```

### Known limits
- Steady tonal bleed (e.g. a pad chord) that is only ~10 dB below the bass can be read as a low note
  once the bass stops. Kick-drum thumps are filtered out; tonal bleed cannot be told apart from a note by pitch alone.
- Slides slower than ~6 semitones/second are not detected as slides.
- Wideband percussive bursts with no pitch (drum bleed) can show up as muted-note marks (x).
- Slap/pop detection uses an absolute brightness threshold (`slapBright`) that may need calibrating to your bass.
