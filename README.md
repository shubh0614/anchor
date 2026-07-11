# ANCHOR

A personal, offline first, single user workout logger. Static site, no build step,
no framework, no backend. Vanilla HTML, CSS, and ES modules. Charts are hand rolled
inline SVG.

Log the set. Nothing else.

## Three laws

1. Do not lose data. Every set writes to both localStorage and IndexedDB. On load
   the fresher store heals the stale one. Clearing either store and reloading
   restores everything from the other.
2. Do not waste time. A logged set is one tap. A full session is about twenty taps
   and zero keystrokes. There are no text inputs in the logging flow.
3. Do not make the user think. The app reads the system date, renders today's
   session, prefills from last session, and decides on its own when to add weight.

## Files

```
index.html      app shell
app.js          all logic
storage.js      the durability layer (dual write, healing, export, import)
styles.css      all styling
plan.json       the program, swappable
manifest.json   PWA manifest
sw.js           service worker (offline shell cache)
icons/          app icons
test-storage.html  browser harness for the storage layer
```

## The program

`plan.json` is the whole program, including the training `rules`. The app hardcodes
no exercise names, days, rep ranges, day types, or rules: everything renders from
this file. To change the program, edit `plan.json` and push. History survives,
because every log is keyed by exercise `id`, never by name or position.

## Four pages, four colours

Bottom navigation: Today, Calendar, History, Plan. Colour carries meaning and never
decoration:

- Amber `#F0A93B`: you got stronger (the ADD WEIGHT rail, a personal best on a
  chart, a weight increase dot on the calendar).
- Ember `#FF7A59`: push days. Teal `#3FC1AC`: pull days. Driven by `dayType`.
- Violet `#8B7DD8`: bodyweight and measurements.

Buttons, headers, and navigation stay uncoloured.

## Progression

Double progression. When every logged set of an exercise reaches `repMax`, the app
flags it. The next time that exercise appears, the card shows an amber `ADD WEIGHT`
rail, the weight is pre-incremented by that exercise's increment, and reps reset to
`repMin`. The user just taps the check.

## The rules live in the app

The `rules` object in `plan.json` renders as a read only Plan page. Three of the
rules are scheduled events, not reference text: the week 1-2 ramp, the week 4 lateral
raise review, and the week 6 deload. The app computes the block week from the first
logged session and surfaces the right banner on the session screen by itself. During
a deload week it halves every displayed target set count. `Start new block` on the
Plan page resets the week counter without touching any logs.

## Form reference

Each exercise can carry up to three `cues` and an optional `video` link in
`plan.json`. They render only on the exercise detail page, reached by tapping the
exercise name. There is never a video control in the logging flow. The plan ships
with `video: null` everywhere: paste your own links into the JSON once.

## Calendar

A month grid, Monday to Sunday. Logged push days are ember, logged pull days are
teal, a weight increase gets an amber corner dot, Monday is neutral, today gets a
bone ring. Above it: current streak, longest, this month, adherence. A missed Monday
never breaks a streak, and a broken streak is shown, not scolded.

## Backup

The header `Export` button gives two files at once: a full re-importable JSON backup
and a flat CSV history. If more than seven days pass without an export, a persistent
amber strip appears at the top until you export. Import merges by session id and
shows a summary before committing.

## Verifying the storage layer

Open `test-storage.html` in a browser. Run the suite, or seed sessions, clear one
store, and reload to watch the app restore from the other and show
`Restored from backup.`

## Deploy to GitHub Pages

This repo serves straight from its files, no build.

1. Push to GitHub (already wired to `origin`):
   ```
   git add -A
   git commit -m "your message"
   git push
   ```
2. On GitHub: `Settings` then `Pages`. Under `Build and deployment`, set
   `Source` to `Deploy from a branch`, `Branch` to `main`, folder `/ (root)`, save.
3. Wait for the green check, then open `https://shubh0614.github.io/anchor/`.

## Add to your phone home screen

1. Open the Pages URL on your phone once (so the service worker caches the shell).
2. iPhone Safari: Share, then `Add to Home Screen`.
   Android Chrome: menu, then `Add to Home screen` or `Install app`.
3. Launch it from the icon. It runs full screen and works in airplane mode.

## Writing rule

No em dashes anywhere in this repository. Commas, colons, periods, or parentheses
instead. Hyphens in ranges like 6-10 are fine.
