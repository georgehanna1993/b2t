# Lowline

A browser based bass practice tool. Open `index.html` directly in a modern browser (or host it on GitHub Pages),
upload an isolated WAV bassline, or try the built-in demo. Everything runs locally, nothing is uploaded.

## What you get

A tab that reads like Guitar Pro / Songsterr output:
TAB clef, time signature, tempo, bar lines and numbers, rhythm stems / beams / rests under the staff,
hammer-on / pull-off slurs (H / P), legato slides, slide-in / slide-out, slap S / pop P, dead notes x,
ties, vibrato, optional left-hand finger numbers. Drag the waveform (playing or paused) and the tab and
playhead follow. See the LEGEND under the tab in the app for every mark.

## How it works

| file | job |
|---|---|
| `analysis.js` | audio -> notes: onsets, YIN pitch + Viterbi path, glides / jumps, slap, dead notes, vibrato |
| `fingering.js` | notes -> string + fret + finger the way a bassist would play them |
| `rhythm.js` | tempo + downbeat estimation, 16th-note quantization, bars, note values, rests, ties |
| `tabview.js` | draws the notation |
| `app.js` | player, waveform, options |

### Analysis (`analysis.js`)
1. mono mix, band-limit to the bass range, decimate to ~11 kHz
2. onsets from a log-energy envelope (repeated notes stay separate)
3. per note: YIN proposes pitch candidates, a Viterbi search picks the most continuous path (kills octave flips);
   the path is read for movement: smooth glide = ONE slide (landing note, or slide-out if it runs off the end of the note,
   or slide-in if it starts the note), abrupt change <= 5 semitones with no energy bump = hammer-on / pull-off
4. slap / pop from attack brightness, dead notes from pitchless transients, vibrato from regular 3.5-9.5 Hz pitch wobble
5. global tuning offset and lone-octave-glitch repair

### Fingering (`fingering.js`) - rules taken from standard bass technique
- hand position = fret under the index finger, covers 4 frets (one finger per fret); one fret outside is a cheap stretch
- a full position shift costs by distance, and much more when the notes are fast
- open strings welcome in fast lines, mildly avoided in slow ones
- hammer-ons / pull-offs / slides stay on one string; a repeated pitch stays on the same string and fret
- **repeated phrases get the same fingering every time**: each phrase is solved once, every candidate fingering is tried on all
  copies in the context of the whole song, and the cheapest wins (partial copies are matched too)

### Rhythm (`rhythm.js`)
Tempo is found by scoring how well the onsets sit on a 16th-note grid (with a prior around 105 BPM), the downbeat is where the
longest notes land. You can type a tempo, pick a time signature (4/4, 3/4, 2/4, 6/8, 12/8) or move the bar lines by a beat in Options.

## Tests
```
node test/all.js                           # everything
node test/run.js                           # synthetic basslines with known notes (slides, hammer-ons, slap, slide-in/out, vibrato...)
node test/realistic.js                     # synth bass + reverb + pumping + kick/hi-hat/pad bleed + long glides
node test/fingering_test.js                # bass-technique rules, repeated-phrase consistency, speed
node test/rhythm_test.js                   # tempo detection, bars fully filled, ties, time signatures
node test/analyze_file.js my.wav out.json  # run the analyzer on ANY wav and print every note
```

## Known limits
- Rhythm is a straight 16th grid at one tempo. Triplets / swing and tempo changes are not notated (use Options to adjust the tempo).
- Steady tonal bleed (a pad chord ~10 dB under the bass) can be read as a low note once the bass stops. Kick thumps are filtered out.
- Slides slower than ~6 semitones/second are not detected as slides. Drum bleed can show up as dead-note marks (x).
- Slap/pop uses an absolute brightness threshold (`slapBright`) that may need calibrating to your bass; slap vs pop is guessed from the string.
- Fingering is the most comfortable one by the model above, not a recording of what a particular player did.
