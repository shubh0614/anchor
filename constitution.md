# ANCHOR

**A workout logger built for one lifter, one program, and fifty minutes.**

> Log the set. Nothing else.

---

## 0. Writing rule (applies to code, comments, UI copy, and this repo)

**Never use em dashes.** Not in UI text, not in code comments, not in the README, not anywhere. Use commas, colons, periods, or parentheses instead. Hyphens in ranges (6-10 reps) are fine.

---

## 1. What this is

A personal, single user, offline first web app for logging gym sessions against a fixed training program. It is hosted on GitHub Pages, installed to the phone home screen, and opened roughly six times a week for fifty minutes at a time.

It is not a social app, not a coaching app, not a general purpose fitness tracker. It does exactly one job: **record what was lifted, in as few taps as physically possible, and never lose it.**

## 2. The user

- One person. No accounts, no login, no server, no sync.
- An engineer, so a JSON file and a GitHub repo are comfortable primitives.
- Trains six days a week (Tuesday to Sunday), rests Monday.
- Sessions are capped at fifty to fifty five minutes. The app must never be the reason a session runs long.
- Logs **during rest periods**, standing at a machine, one thumb, possibly sweaty.

## 3. The three laws

Every design decision defers to these, in order.

1. **Do not lose data.** Ever. Under any circumstance. Data loss is the only unrecoverable failure this app can have.
2. **Do not waste time.** A logged set should cost one tap. A whole session should cost about twenty taps and zero keystrokes.
3. **Do not make the user think.** The app knows what day it is, what is next, what was lifted last week, and when to add weight. The user just confirms.

If a feature conflicts with any of these, the feature loses.

---

## 4. Architecture

### 4.1 Three way separation

```
index.html      the app shell
app.js          all logic
styles.css      all styling
plan.json       THE PROGRAM. Swappable.
manifest.json   PWA manifest
sw.js           service worker (offline)
```

Plus browser storage, which holds **the logs** and is never touched by a plan swap.

**The app knows nothing about exercises.** No hardcoded exercise names, no hardcoded days, no hardcoded rep ranges. Everything comes from `plan.json` at load. To change the program after sixteen weeks, the user replaces `plan.json`, pushes to GitHub, and the app renders the new program. History survives.

### 4.2 Why history survives a plan swap

**All logs are keyed by exercise `id`, never by name, never by position.**

```
smith_incline   is the id           (stable, never changes)
"Smith Incline Press"   is the name (display only, may change)
```

If v6 of the program renames "Smith Incline Press" to "Smith Incline Press (30 deg)", the id stays `smith_incline`, and sixteen weeks of history follows the exercise into the new plan. If an exercise is dropped from the plan, its history stays in storage (dormant, still exportable) and reappears intact if it ever returns.

**Never key anything by array index or display name.**

### 4.3 Tech

- Vanilla HTML, CSS, and JavaScript (ES modules). **No build step. No framework. No bundler.**
- Rationale: GitHub Pages serves static files, the app must open in under a second on a phone, and it must still work in five years without a dependency graveyard.
- Charts: hand rolled inline SVG. Do not pull in a charting library for two line charts.
- PWA: `manifest.json` plus a service worker that caches the shell so the app works with no signal. Apartment gym basements have no signal.
- Fonts: self host or use Google Fonts with a `preconnect`. If offline font loading is a problem, self host the woff2 files.

---

## 5. Data model

### 5.1 plan.json (the program)

```json
{
  "planVersion": "v5",
  "planName": "6-Day Apartment Gym",
  "restDay": "MON",
  "days": [
    {
      "dayId": 1,
      "dayType": "push",
      "weekday": "TUE",
      "title": "PUSH A",
      "subtitle": "Upper Chest",
      "blocks": [
        {
          "type": "anchor",
          "restSeconds": 150,
          "exercises": [
            {
              "id": "smith_incline",
              "name": "Smith Incline Press",
              "sets": 4,
              "repMin": 6,
              "repMax": 10,
              "increment": 2.5,
              "note": "Priority anchor. Straight sets."
            }
          ]
        },
        {
          "type": "superset",
          "restSeconds": 90,
          "exercises": [
            { "id": "incline_machine_press", "name": "Chest Press Machine (incline angle)", "sets": 3, "repMin": 8, "repMax": 12, "increment": 2.5 },
            { "id": "leg_extension", "name": "Leg Extension", "sets": 3, "repMin": 12, "repMax": 15, "increment": 5 }
          ]
        }
      ]
    }
  ]
}
```

**Block types:**

| type | meaning | UI behaviour |
|---|---|---|
| `anchor` | the heavy lift, straight sets, no pairing | rendered alone, long rest, visually distinct |
| `single` | a standalone exercise, not paired | rendered alone |
| `superset` | two exercises, alternated | rendered as a pair, rest fires after the second |
| `triset` | three exercises, alternated | rendered as a trio, rest fires after the third |

**Exercise fields:**

| field | type | purpose |
|---|---|---|
| `id` | string | **stable key.** Snake case. Never changes. |
| `name` | string | display only |
| `sets` | int | target working sets |
| `repMin` / `repMax` | int | the double progression window |
| `increment` | number (kg) | smallest jump for **this** exercise. Smith and barbell 2.5, cable and machine stacks 5, dumbbells 2.5. This matters. Do not use a global increment. |
| `note` | string, optional | shown small under the name |
| `video` | string (URL), optional | form reference. If absent, no video control renders. |
| `cues` | array of strings, optional | up to three short form cues. Shown as text on the exercise detail page. |

**Day fields:** each day also carries `dayType`, either `"push"` or `"pull"`. This is what drives the ember and teal colour system on the day header and the calendar. It comes from the plan file, so a future plan with different day types colours itself correctly with no code change.

### 5.2 Log entries (browser storage)

```json
{
  "sessionId": "2026-07-14_day1",
  "date": "2026-07-14",
  "dayId": 1,
  "planVersion": "v5",
  "startedAt": 1752480000000,
  "endedAt": 1752483120000,
  "entries": [
    {
      "exerciseId": "smith_incline",
      "skipped": false,
      "sets": [
        { "weight": 60, "reps": 10, "loggedAt": 1752480180000 },
        { "weight": 60, "reps": 9,  "loggedAt": 1752480360000 },
        { "weight": 60, "reps": 8,  "loggedAt": 1752480540000 },
        { "weight": 60, "reps": 8,  "loggedAt": 1752480720000 }
      ]
    },
    {
      "exerciseId": "leg_extension",
      "skipped": true,
      "skipReason": "machine occupied",
      "sets": []
    }
  ]
}
```

Also stored, separately:

```json
{
  "bodyweight": [ { "date": "2026-07-12", "kg": 67.4 } ],
  "measurements": [
    { "date": "2026-07-12", "waistCm": 76, "armCm": 35.5, "chestCm": 98, "shoulderCm": 115 }
  ],
  "settings": { "sound": false, "vibrate": true, "units": "kg" },
  "lastExportAt": 1752480000000
}
```

---

## 6. Data durability (law number one)

This is the part that must not be compromised.

### 6.1 Dual write

**Every single write goes to BOTH `localStorage` AND `IndexedDB`, synchronously on every set logged.**

- Not on session end. Not on a debounce. **On every set.** If the browser is killed mid session, at most one set is lost.
- On app load, read from both. If they disagree, take the one with the newer timestamp and immediately heal the other.
- If one store is empty and the other has data, restore the empty one from the full one and show a quiet toast: `Restored from backup.`

Rationale: localStorage is wiped by "clear site data", by aggressive iOS storage reclamation, and by the user cleaning their browser. IndexedDB usually survives that. Neither is trustworthy alone. Together they are good enough.

### 6.2 Export

A permanently reachable **Export** button (in the header, not buried in a settings page).

One tap gives **both**:
- `anchor-backup-YYYY-MM-DD.json` (complete dump, re-importable, includes plan version, all sessions, bodyweight, measurements, settings)
- `anchor-history-YYYY-MM-DD.csv` (flat: `date, dayId, exerciseId, exerciseName, setNumber, weight, reps, e1rm`)

### 6.3 Import

Drag or pick a JSON backup, and it restores everything. Merge by `sessionId`, do not blindly overwrite. Show a summary before committing: `This will add 42 sessions and update 3. Continue?`

### 6.4 The backup nag

If `lastExportAt` is more than seven days old, show a **persistent, non dismissible amber strip** at the top of the home screen:

> `Last backup: 12 days ago. Export now.`

It does not block use. It does not go away until an export happens. This is the single most important piece of UI in the app.

### 6.5 Never

- Never call `localStorage.clear()`.
- Never delete a log entry when an exercise leaves the plan.
- Never have a "reset all data" button without a typed confirmation (`type RESET to confirm`).

---

## 7. The core flow

### 7.1 Open the app

The app reads the system date, matches it to `weekday` in `plan.json`, and **immediately renders today's session.** No day picker, no menu, no home screen to navigate.

- Monday: a calm rest screen. `Rest day. Eat.` Plus the week's summary and any pending backup nag.
- If the user already logged today's session: show it in review state, with the option to keep adding.
- A small, quiet way to override the day exists (in case Tuesday's session happens on Wednesday). It is a secondary control, not the default path.

### 7.2 The session screen

A vertical stack of **blocks**, in order. Each block is a card. Supersets and trisets are visually grouped inside one card with a bracket or a shared rail, so the pairing is obvious without reading.

Each exercise inside a block shows:

- Name, and a small `4 x 6-10` target
- **Last session, prefilled:** `Last: 60 kg x 10, 9, 8, 8`
- A row of **set pills**, one per target set

### 7.3 The set pill (the signature interaction)

Each set pill is a wide, thumb sized row containing:

```
[  -  ]  60 kg  [  +  ]        [  -  ]  10  [  +  ]        [  ✓  ]
```

- Weight and reps are **prefilled from last session's corresponding set.**
- `+` and `-` step weight by that exercise's `increment` and reps by 1. **No text inputs. No keyboards. Ever.**
- Tapping `✓` commits the set. The pill fills with a left to right sweep and locks.
- **Committing a set immediately starts the rest timer** and immediately writes to storage.

The common case is: the numbers are already right, so you tap `✓` and nothing else. **One tap per set.**

### 7.4 Rest timer

- A slim bar pinned to the bottom of the viewport that **drains** left to right. Numeric countdown alongside it.
- Duration comes from the block's `restSeconds`.
- **Silent by default.** One vibration pulse when it hits zero (`navigator.vibrate`).
- Sound is an opt in toggle in settings, default off.
- Tap the bar to skip the rest. Long press to add thirty seconds.
- The timer must survive scrolling and stay visible.

### 7.5 Skip

Every exercise card has a small, low emphasis **Skip** control.

- Tapping it collapses the card, marks `skipped: true`, and moves on.
- Optionally attach a one tap reason from a fixed list: `machine busy`, `short on time`, `not feeling it`, `injury`. No free text. No judgement. No guilt copy.
- A skipped exercise is greyed, not hidden. It can be un-skipped by tapping again.
- Skipped exercises are excluded from progression logic (they do not break a streak, they simply have no data for that day).

### 7.6 Progression (the app decides, not the user)

At the end of a session, for each exercise:

**If every logged set reached `repMax`, the exercise is flagged for a weight increase.**

The next time that exercise appears:
- Its card shows an amber rail on the left edge and a badge: `ADD WEIGHT`
- The set pills are **prefilled with `lastWeight + increment`** and reps reset to `repMin`
- The user still just taps `✓`

The user never decides when to progress. The app tells them. This is the whole point of double progression, and it is the single biggest time and thinking saver in the app.

### 7.7 Session summary

When the last set is logged, or the user taps `End session`:

- Duration
- Sets logged, sets skipped
- **What went up** (amber list)
- **What stalled** (quiet list, no shaming language)
- One tap back to the history view

---

## 8. History and charts

### 8.1 Per exercise view

Tap any exercise name to open its history.

**The headline chart is a single line: estimated 1RM over time.**

```
e1RM = weight x (1 + reps / 30)
```

Take the best set of each session. One point per session. Smooth, monotonic-ish, and it absorbs the sawtooth that double progression creates.

**Do not plot weight and reps as two lines.** Double progression makes reps climb and then crash every time weight jumps. Two lines chasing each other in opposite directions teaches the user nothing. e1RM is the honest single signal.

Below the chart, a compact **table** of raw sessions:

| Date | Weight | Reps | e1RM |
|---|---|---|---|
| 14 Jul | 60 | 10, 9, 8, 8 | 80.0 |
| 07 Jul | 57.5 | 10, 10, 9, 9 | 76.7 |

That gives the trend at a glance and the detail on demand. A secondary toggle can switch the chart to **volume load** (`sets x reps x weight`) for anyone who wants it. e1RM is the default.

### 8.2 Body view

- Bodyweight line chart, weekly points, with a target gradient band showing roughly 0.25 kg per week.
- Measurements (waist, arm, chest, shoulder) as a small sparkline set.
- A weekly prompt for bodyweight. Every four weeks, a prompt for measurements. One tap to dismiss.

### 8.3 Week view

A simple grid: six days, green if logged, grey if not, showing which exercises went up. No streak counter, no fire emoji, no gamification. The logbook is the reward.

---

## 8A. The Plan page (the rules, in the app)

The training rules must live **inside the app**, not in a document the user has to go and find. At week five nobody remembers whether the deload is due.

### 8A.1 It comes from plan.json

The rules are **not hardcoded**. They live in a `rules` object inside `plan.json`, so that swapping the plan at week sixteen swaps the rules with it. A plan and its rules are one artifact.

```json
{
  "planVersion": "v5",
  "planName": "6-Day Apartment Gym",
  "restDay": "MON",
  "rules": {
    "howToRun": [
      { "title": "Anchor first", "body": "The anchor lift comes first, straight sets, 2 to 3 minutes rest, never supersetted. Priority anchors get 4 sets, everything else gets 3." },
      { "title": "Progression", "body": "Same weight across all sets. Hit the top of the rep range on every set and the app adds weight for you next session. That is the whole system." },
      { "title": "Effort", "body": "1 to 2 reps in reserve. Take 0 RIR only on the last set of an isolation. Never on a barbell." },
      { "title": "Supersets", "body": "A1, 30 seconds, B1, 90 seconds, repeat." },
      { "title": "Time", "body": "50 to 55 minutes. Push days are the long ones. Log while resting, never after." }
    ],
    "priorities": {
      "priority":   [["Upper chest","13","3x"],["Shoulder press","7","2x"],["Side delts","15","5x"],["Rear delts","12","4x"],["Biceps","12","4x"],["Triceps","12","4x"],["Abs","15","5x"]],
      "secondary":  [["Back","18","3x"]],
      "maintenance":[["Mid / flat chest","6","2x"],["Quads","6","2x"],["Hams / glutes","6","2x"],["Calves","3","1x"],["Forearms","3","1x"]]
    },
    "pressureValves": [
      "Cut the Day 2 lateral raise. Side delts drop to 12 sets, still 4x.",
      "Cut the Day 6 seated row.",
      "Drop a priority anchor from 4 sets to 3."
    ],
    "schedule": [
      { "weeks": [1, 2],  "kind": "ramp",   "title": "Ramp weeks",
        "body": "70 to 75 percent of what you think you can lift. Stop 2 to 3 reps short on everything. Non-negotiable. Week 3 you push." },
      { "weeks": [4],     "kind": "review", "title": "Lateral raise review",
        "body": "Check your lateral raise logs. If reps have stalled, elbows feel crunchy, or your shoulder aches on presses, cut the Day 2 lateral raise now. Do not wait for pain to become injury." },
      { "weeks": [6, 12, 18, 24], "kind": "deload", "title": "Deload week",
        "body": "Half the sets. 3 to 4 RIR. Same exercises. One week, then build back." }
    ],
    "measurements": {
      "bodyweight": "weekly",
      "waist": "biweekly",
      "arm_chest_shoulder": "monthly",
      "target": "About 0.25 kg per week. Not moving means add 200 to 300 kcal."
    }
  }
}
```

### 8A.2 The page itself

A **Plan** tab, reachable in one tap from anywhere. It is read only. It renders, in this order:

1. **This week.** A single line: `Week 4 of the block.` Plus any active rule for this week, rendered prominently (see 8A.3).
2. **How to run it.** The `howToRun` cards. Short, scannable.
3. **Priorities.** The three tier volume table (Priority, Secondary, Maintenance), colour coded only by weight of type, not by hue. Amber stays reserved for progression.
4. **Pressure valves.** A numbered list, in order. The user should be able to see at a glance what to cut first when recovery or time suffers.
5. **The schedule.** All scheduled events, with the current one marked.
6. **Measurements.** What to measure and how often.

No editing. The plan is a JSON file and a git push.

### 8A.3 Scheduled rules are events, not reference text

This is the part that matters.

The app computes **block week number** from the date of the first ever logged session (`week = floor(daysSinceFirstSession / 7) + 1`). It then checks `rules.schedule` on every app open.

If the current week matches a scheduled rule, a **banner appears at the top of the session screen**, before the first block, every day of that week:

```
WEEK 1 OF 2 . RAMP
70 to 75 percent. Stop 2 to 3 reps short. Non-negotiable.
```

```
WEEK 4 . LATERAL RAISE REVIEW
Check your lateral raise logs. Stalled reps, crunchy elbows, or an aching
shoulder on presses means cut the Day 2 lateral raise now.
                                            [ Open logs ]   [ Done ]
```

```
WEEK 6 . DELOAD
Half the sets. 3 to 4 RIR. Same exercises.
```

Behaviour:

- The **ramp** and **deload** banners are informational and persist all week. They cannot be dismissed, because they change how every set in that week should be performed.
- The **review** banner is actionable. `Open logs` jumps straight to the lateral raise history chart. `Done` dismisses it for the rest of the block and records the decision (`reviewed: week4_laterals`) in storage, so the user has a record of when they checked and what they chose.
- During a **deload** week, the app halves the displayed target set count for every exercise (rounding down, minimum 1) and shows the target reps with a quiet `deload` tag. It does not change the plan file. It is a rendering rule.

The user should never have to remember any of this. The app remembers.

### 8A.4 Block reset

A small control on the Plan page: `Start new block`. It resets the week counter to 1 without touching any log data. Used when a new `plan.json` is dropped in, or when the user simply wants to restart the cycle. Requires one confirmation tap.

---

## 8B. Form reference (video and cues)

### 8B.1 The rule that governs this

**A video link must never appear in the logging flow.** Not on a set pill, not on a block card, not anywhere on the session screen where a thumb is moving fast. During a session the user is logging, not learning. A play button on the logging path will eventually get tapped by accident, and worse, watched. That is how a fifty minute session becomes seventy.

### 8B.2 Where it lives

Tapping an **exercise name** (not the set pill, not the check) opens the **exercise detail page**. That page already exists: it is where the e1RM chart and the raw session table live. Form reference joins it there.

The detail page shows, in this order:

1. **Cues.** Up to three short lines from `cues` in `plan.json`. Plain text, no loading, readable in three seconds. This is what actually gets used on rep eight of a hard set.
2. **Watch form.** A single button, only rendered if `video` is present. It opens the URL in a new tab. **No embedded player, no iframe, no video library.** The app does not become a media app.
3. The e1RM chart.
4. The raw session table.

The cues matter more than the video. The video is for the first week. The cues are for the next sixteen.

### 8B.3 Populating it

The plan ships with `"video": null` on every exercise. The user pastes in their own links once, in the JSON file. This is deliberate:

- Links rot. A hardcoded library would be half dead inside a year.
- The user knows which coach they trust. The app should not choose for them.
- It is a `plan.json` field like everything else, so it swaps with the plan at week sixteen and needs no code change.

### 8B.4 What this is not

This is not an exercise library, a movement database, a search, or a player. It is a link and three lines of text, parked deliberately off the logging path.

---

## 9. Design

### 9.1 The thesis

**An instrument where colour carries meaning, never decoration.**

The app is built on graphite. Four hues exist, and each one has exactly one job. Nothing is coloured because it looked nice.

| hue | means | appears on |
|---|---|---|
| **Amber** `#F0A93B` | **you got stronger** | the ADD WEIGHT rail, a new personal best on a chart, a PR dot on the calendar |
| **Ember** `#FF7A59` | **push day** | Day 1, 3, 5 headers and their calendar cells |
| **Teal** `#3FC1AC` | **pull day** | Day 2, 4, 6 headers and their calendar cells |
| **Violet** `#8B7DD8` | **body, not lifts** | bodyweight and measurement charts |

Buttons are not coloured. Headers are not coloured. Navigation is not coloured. If a pixel is amber, the user got stronger. If a cell is ember, that was a push day. The eye learns the system in one session, and after that the calendar and the charts are readable without a legend.

This is the whole reason the colour is worth having. Decorative colour would make it look like every other fitness app and mean nothing.

### 9.2 Palette

```
--ink        #0E1014   page background, near black with a blue cast
--surface    #171A21   cards
--surface-2  #1F232C   raised, pressed
--line       #2A2F3A   hairlines, dividers
--bone       #E9E7E2   primary text, slightly warm so it does not glare at 6am
--steel      #8B93A1   secondary text, labels
--dim        #5A6170   tertiary, disabled

--signal     #F0A93B   AMBER.  progression only
--push       #FF7A59   EMBER.  push days only
--pull       #3FC1AC   TEAL.   pull days only
--body       #8B7DD8   VIOLET. bodyweight and measurements only

--signal-dim #6B4E1E
--push-dim   #5C2E22
--pull-dim   #1C4E46
--body-dim   #37305A
```

The `-dim` variants are for rails, unfilled states, and calendar cells that are scheduled but not yet logged. The full hue is reserved for the completed or earned state. A dim cell is a plan. A full cell is a fact.

Light mode is **not required.** This is used in a gym, at night, in a basement. Dark is correct.

### 9.3 Typography

Three roles, deliberately chosen so the app does not look like every other dashboard.

| role | face | use |
|---|---|---|
| **numerals** | `IBM Plex Mono` (500, 600) | every weight, rep, timer, and chart label. **Tabular figures.** Numbers are the hero of this app, so they get the characterful face, and they never shift as they change. |
| **display** | `Space Grotesk` (600) | day titles, exercise names, section headers |
| **body** | `Inter` (400, 500) | everything else, sparingly |

Set numerals large. A weight on a set pill should be readable at arm's length while you are catching your breath. Minimum 20px, ideally 24px.

### 9.4 Layout

- **Mobile first, 380px baseline.** This is the primary target and must be flawless.
- Everything interactive lives in the **bottom two thirds of the screen** (thumb zone). The rest timer is pinned to the bottom edge.
- Tap targets: **minimum 48x48px.** The `+`, `-`, and check controls should be generous. The user is sweaty and shaking.
- Tablet and laptop: the single column widens to a comfortable max of 640px and centres. On wide screens, the history chart may sit beside the table in two columns, and the calendar may show two months. **Do not build a desktop dashboard.** It is the same app, more comfortable.
- Bottom navigation, four items: **Today, Calendar, History, Plan.** Icons plus labels. The active item is bone, the inactive ones steel. Navigation is never coloured.
- Generous vertical rhythm. Cards separated by real space. The user is scanning, not reading.

### 9.5 Motion

Restrained and functional.

- The set pill fill on commit: a 180ms left to right sweep. This is the one moment of satisfaction in the app. Make it feel good.
- The rest timer drain: linear, continuous, no easing.
- Calendar cells fill on load with a 20ms stagger, top left to bottom right. Once, quietly, then still.
- Everything else: 120ms ease-out on state change, or nothing.
- Respect `prefers-reduced-motion` and cut all of it.
- **No confetti. No celebration animations. No badges.** The lifter is an adult.

### 9.6 Copy

- Plain, direct. `Add weight.` not `Time to level up!`
- Never motivational. Never congratulatory. Never guilt inducing.
- A skipped exercise says `Skipped`. It does not say `You can do better tomorrow!`
- A broken streak says nothing at all. The calendar simply shows an empty cell.
- Empty state on the very first session: `No history yet. Enter your working weights and the app takes over from here.`
- Rest day: `Rest day. Eat.`

---

## 9A. The Calendar page

A month grid. The point is that a glance tells the user what they actually did, without reading a single word.

### 9A.1 The grid

Standard month calendar, weeks running Monday to Sunday so that the rest day sits at the left edge and the training block reads as one unbroken run.

Each day cell is a rounded square, and its state is carried entirely by colour and fill.

| state | rendering |
|---|---|
| **Push day, logged** | solid ember, day number in ink |
| **Pull day, logged** | solid teal, day number in ink |
| **Scheduled, not yet reached** | dim outline in that day's hue, day number in steel |
| **Scheduled, missed** | hollow, hairline `--line` border, day number in dim |
| **Rest day (Monday)** | flat `--surface-2`, no border, day number in dim |
| **Today** | a bone ring around the cell, whatever its fill |
| **A weight increase happened that day** | a small **amber** dot in the top right corner of the cell |
| **Deload week** | the whole week row gets a subtle `--surface-2` band behind it, and a small `deload` label at the left |

That amber dot is the payoff of the colour system. Scanning a month, the user sees at once where progress actually clustered, and where it did not.

Tap any cell to open that session in read only detail: every exercise, every set, what went up, what was skipped.

### 9A.2 The record, above the grid

Four numbers, in IBM Plex Mono, large. No emoji, no flame, no exclamation marks.

```
CURRENT STREAK      LONGEST        THIS MONTH        ADHERENCE
     11 days         23 days         18 / 21            86%
```

Definitions, and they matter:

- **Streak** counts **scheduled sessions completed in a row.** Monday is a rest day and **never breaks a streak.** A deload week counts normally. A session counts as completed if **at least half of its exercises were logged and not skipped**, which means a genuinely short day still counts and the user is not punished for being honest about a bad session.
- **This month** is sessions completed over sessions scheduled so far this month, not the whole month. It does not count days that have not happened yet against the user.
- **Adherence** is the same ratio over the current block.
- **Longest** is all time.

Below the grid: a **twelve month heat strip**, one thin column per week, coloured by how many sessions were completed that week. This is the long view. It is where a lifter sees that the three weeks they missed in July were three weeks, not a catastrophe.

### 9A.3 What the calendar must not do

- **No streak notifications.** Ever.
- **No warnings about breaking a streak.** No `Do not break the chain!`. No `You are 2 days from your record!`
- **No penalty for a rest day, a deload, or an honest skip.**
- If the streak resets to zero, the app says nothing. The number is simply zero. The calendar shows the gap. That is enough, and it is the truth.

A streak in this app is a record of what happened, not a leash.

---

## 10. Accessibility and quality floor## 10. Accessibility and quality floor

- Visible keyboard focus on every control.
- All interactive elements are real buttons with accessible labels.
- `prefers-reduced-motion` respected.
- Contrast: bone on ink must clear WCAG AA. Steel on ink must clear AA for large text.
- Works with the phone screen locked and reopened mid session (state is in storage, not in memory).
- Works offline, fully, including charts.

---

## 11. Non goals

Do not build these. They are how this app dies.

- Accounts, login, sync, cloud, backend
- Social features, sharing, leaderboards
- Badges, confetti, streak notifications, `do not break the chain` pressure of any kind. The calendar records, it does not coerce.
- An exercise video library, a movement database, an embedded player, or a search. A single optional link per exercise in `plan.json`, opened in a new tab from the detail page. Nothing more.
- A plan builder or drag and drop editor. **The plan is a JSON file. Editing it is a text edit and a git push.**
- Calorie or macro tracking. That lives elsewhere.
- Notifications or reminders
- Anything that adds a tap between opening the app and logging a set

---

## 12. Acceptance criteria

The build is done when all of these are true.

1. Opening the app on a Tuesday shows Day 1, already rendered, with last week's weights prefilled, in under one second.
2. A full session can be logged with **zero keystrokes** and roughly twenty taps.
3. Logging a set writes to localStorage and IndexedDB before the animation finishes.
4. Killing the browser mid session and reopening loses at most one set.
5. Clearing localStorage and reloading restores every session from IndexedDB.
6. Replacing `plan.json` with a different program changes the app entirely, and all prior history remains attached to its exercises by id.
7. Hitting `repMax` on every set of an exercise causes `ADD WEIGHT` to appear, with the weight pre-incremented, the next time that exercise comes up.
8. Export produces a JSON file that, when imported into a cleared browser, restores everything exactly.
9. The backup nag appears after seven days without an export and does not disappear until one happens.
10. The rest timer starts automatically on set commit and vibrates once at zero.
11. It works with the phone in airplane mode.
12. It looks correct at 380px, 768px, and 1280px.
13. The Plan page renders every rule from `plan.json`, with nothing hardcoded.
14. On a ramp, review, or deload week, the correct banner appears on the session screen without the user going looking for it.
15. During a deload week, every exercise shows halved target sets.
16. Colour is never decorative. Amber appears only on progression, ember only on push days, teal only on pull days, violet only on body metrics. Navigation and buttons are uncoloured.
17. The calendar shows a month at a glance, with logged push days ember, logged pull days teal, an amber dot on any day a weight went up, and Monday neutral.
18. A missed Monday never breaks a streak.
19. No video control appears anywhere in the logging flow. Form cues and the video link live only on the exercise detail page, reached by tapping the exercise name.
20. There is not a single em dash anywhere in the repository.

---

## 13. The program: plan.json (v5)

This is the starting plan. Ship it as `plan.json`.

**It must also contain the `rules` object shown in section 8A.1.** The days array below and that rules object together form one complete `plan.json`. A plan and its rules ship as one file.

```json
{
  "planVersion": "v5",
  "planName": "6-Day Apartment Gym",
  "restDay": "MON",
  "days": [
    {
      "dayId": 1,
      "dayType": "push",
      "weekday": "TUE",
      "title": "PUSH A",
      "subtitle": "Upper Chest",
      "blocks": [
        { "type": "anchor", "restSeconds": 150, "exercises": [
          { "id": "smith_incline", "name": "Smith Incline Press", "sets": 4, "repMin": 6, "repMax": 10, "increment": 2.5, "note": "Priority anchor",
            "video": null,
            "cues": ["Bench at 30 degrees, not 45", "Elbows tucked to about 45 degrees", "Bar to upper chest, controlled negative"] }
        ]},
        { "type": "superset", "restSeconds": 90, "exercises": [
          { "id": "incline_machine_press", "name": "Chest Press Machine (incline angle)", "sets": 3, "repMin": 8, "repMax": 12, "increment": 2.5 },
          { "id": "leg_extension", "name": "Leg Extension", "sets": 3, "repMin": 12, "repMax": 15, "increment": 5 }
        ]},
        { "type": "superset", "restSeconds": 90, "exercises": [
          { "id": "pec_deck", "name": "Pec Deck Fly", "sets": 3, "repMin": 12, "repMax": 15, "increment": 5 },
          { "id": "db_lateral_raise", "name": "DB Lateral Raise", "sets": 3, "repMin": 12, "repMax": 20, "increment": 2.5 }
        ]},
        { "type": "superset", "restSeconds": 90, "exercises": [
          { "id": "overhead_cable_tricep", "name": "Overhead Cable Tricep Extension", "sets": 3, "repMin": 10, "repMax": 15, "increment": 2.5 },
          { "id": "cable_crunch", "name": "Cable Crunch", "sets": 3, "repMin": 12, "repMax": 15, "increment": 5 }
        ]}
      ]
    },
    {
      "dayId": 2,
      "dayType": "pull",
      "weekday": "WED",
      "title": "PULL A",
      "subtitle": "Back Width",
      "blocks": [
        { "type": "anchor", "restSeconds": 150, "exercises": [
          { "id": "lat_pulldown_wide", "name": "Lat Pulldown, wide", "sets": 3, "repMin": 6, "repMax": 10, "increment": 5 }
        ]},
        { "type": "superset", "restSeconds": 90, "exercises": [
          { "id": "close_grip_row", "name": "Close-Grip Row", "sets": 3, "repMin": 8, "repMax": 12, "increment": 5 },
          { "id": "leg_raise", "name": "Hanging / Lying Leg Raise", "sets": 3, "repMin": 12, "repMax": 15, "increment": 0 }
        ]},
        { "type": "superset", "restSeconds": 90, "exercises": [
          { "id": "rear_delt_pec_deck", "name": "Rear Delt Pec Deck", "sets": 3, "repMin": 15, "repMax": 20, "increment": 5 },
          { "id": "db_lateral_raise", "name": "DB Lateral Raise", "sets": 3, "repMin": 12, "repMax": 20, "increment": 2.5 }
        ]},
        { "type": "superset", "restSeconds": 90, "exercises": [
          { "id": "ez_bar_curl", "name": "EZ Bar Curl", "sets": 3, "repMin": 8, "repMax": 12, "increment": 2.5 },
          { "id": "overhead_cable_tricep", "name": "Overhead Cable Tricep Extension", "sets": 3, "repMin": 10, "repMax": 15, "increment": 2.5 }
        ]}
      ]
    },
    {
      "dayId": 3,
      "dayType": "push",
      "weekday": "THU",
      "title": "PUSH B",
      "subtitle": "Shoulders",
      "blocks": [
        { "type": "anchor", "restSeconds": 150, "exercises": [
          { "id": "shoulder_press_machine", "name": "Shoulder Press Machine", "sets": 4, "repMin": 6, "repMax": 10, "increment": 5, "note": "Priority anchor" }
        ]},
        { "type": "superset", "restSeconds": 90, "exercises": [
          { "id": "cable_lateral_raise", "name": "Cable Lateral Raise", "sets": 3, "repMin": 12, "repMax": 15, "increment": 2.5 },
          { "id": "incline_machine_press", "name": "Chest Press Machine (incline angle)", "sets": 3, "repMin": 8, "repMax": 12, "increment": 2.5 }
        ]},
        { "type": "superset", "restSeconds": 90, "exercises": [
          { "id": "barbell_rdl", "name": "Barbell RDL", "sets": 3, "repMin": 8, "repMax": 12, "increment": 5 },
          { "id": "ez_skullcrusher", "name": "EZ Bar Skullcrusher", "sets": 3, "repMin": 8, "repMax": 12, "increment": 2.5, "note": "Lying. No core bracing after RDLs." }
        ]},
        { "type": "superset", "restSeconds": 90, "exercises": [
          { "id": "rear_delt_cable_fly", "name": "Rear Delt Cable Fly", "sets": 3, "repMin": 15, "repMax": 20, "increment": 2.5 },
          { "id": "lying_leg_raise", "name": "Lying Leg Raise", "sets": 3, "repMin": 12, "repMax": 15, "increment": 0 }
        ]}
      ]
    },
    {
      "dayId": 4,
      "dayType": "pull",
      "weekday": "FRI",
      "title": "PULL B",
      "subtitle": "Back Thickness + Arms",
      "blocks": [
        { "type": "anchor", "restSeconds": 150, "exercises": [
          { "id": "barbell_row", "name": "Barbell Row", "sets": 3, "repMin": 6, "repMax": 10, "increment": 2.5, "note": "2 RIR. Strict. Torso 45 deg." }
        ]},
        { "type": "superset", "restSeconds": 90, "exercises": [
          { "id": "seated_row_wide", "name": "Seated Row, wide grip", "sets": 3, "repMin": 10, "repMax": 12, "increment": 5 },
          { "id": "reverse_pec_deck", "name": "Reverse Pec Deck", "sets": 3, "repMin": 15, "repMax": 20, "increment": 5 }
        ]},
        { "type": "superset", "restSeconds": 90, "exercises": [
          { "id": "incline_db_curl", "name": "Incline DB Curl", "sets": 3, "repMin": 10, "repMax": 12, "increment": 2.5 },
          { "id": "db_lateral_raise", "name": "DB Lateral Raise", "sets": 3, "repMin": 12, "repMax": 20, "increment": 2.5 }
        ]},
        { "type": "superset", "restSeconds": 90, "exercises": [
          { "id": "cable_crunch", "name": "Cable Crunch", "sets": 3, "repMin": 12, "repMax": 15, "increment": 5 },
          { "id": "reverse_barbell_curl", "name": "Reverse Barbell Curl", "sets": 3, "repMin": 12, "repMax": 15, "increment": 2.5 }
        ]}
      ]
    },
    {
      "dayId": 5,
      "dayType": "push",
      "weekday": "SAT",
      "title": "PUSH C",
      "subtitle": "Chest + Shoulders",
      "blocks": [
        { "type": "anchor", "restSeconds": 150, "exercises": [
          { "id": "smith_bench", "name": "Smith Bench Press", "sets": 3, "repMin": 8, "repMax": 12, "increment": 2.5, "note": "Smith catches are your spotter" }
        ]},
        { "type": "single", "restSeconds": 120, "exercises": [
          { "id": "smith_hip_thrust", "name": "Smith Hip Thrust", "sets": 3, "repMin": 10, "repMax": 15, "increment": 5, "note": "Do it now. Bar and bench are still yours." }
        ]},
        { "type": "superset", "restSeconds": 90, "exercises": [
          { "id": "machine_shoulder_press", "name": "Machine Shoulder Press", "sets": 3, "repMin": 8, "repMax": 12, "increment": 5 },
          { "id": "leg_extension", "name": "Leg Extension", "sets": 3, "repMin": 15, "repMax": 20, "increment": 5 }
        ]},
        { "type": "triset", "restSeconds": 90, "exercises": [
          { "id": "low_to_high_fly", "name": "Low-to-High Cable Fly", "sets": 3, "repMin": 12, "repMax": 15, "increment": 2.5 },
          { "id": "db_lateral_raise", "name": "DB Lateral Raise", "sets": 3, "repMin": 15, "repMax": 20, "increment": 2.5 },
          { "id": "cable_pushdown", "name": "Cable Tricep Pushdown", "sets": 3, "repMin": 12, "repMax": 15, "increment": 2.5 }
        ]}
      ]
    },
    {
      "dayId": 6,
      "dayType": "pull",
      "weekday": "SUN",
      "title": "PULL C",
      "subtitle": "Back + Rear Delts + Arms",
      "blocks": [
        { "type": "anchor", "restSeconds": 150, "exercises": [
          { "id": "lat_pulldown_neutral", "name": "Lat Pulldown, neutral", "sets": 3, "repMin": 8, "repMax": 12, "increment": 5 }
        ]},
        { "type": "superset", "restSeconds": 90, "exercises": [
          { "id": "seated_row_close", "name": "Seated Row, close grip", "sets": 3, "repMin": 10, "repMax": 15, "increment": 5 },
          { "id": "cable_crunch", "name": "Cable Crunch", "sets": 3, "repMin": 12, "repMax": 15, "increment": 5 }
        ]},
        { "type": "superset", "restSeconds": 90, "exercises": [
          { "id": "face_pull", "name": "Cable Face Pull", "sets": 3, "repMin": 15, "repMax": 20, "increment": 2.5 },
          { "id": "zottman_curl", "name": "Zottman Curl", "sets": 3, "repMin": 10, "repMax": 12, "increment": 2.5 }
        ]},
        { "type": "superset", "restSeconds": 90, "exercises": [
          { "id": "db_hammer_curl", "name": "DB Hammer Curl", "sets": 3, "repMin": 10, "repMax": 15, "increment": 2.5 },
          { "id": "smith_calf_raise", "name": "Smith Calf Raise", "sets": 3, "repMin": 15, "repMax": 20, "increment": 5 }
        ]}
      ]
    }
  ]
}
```

Note: `"increment": 0` on bodyweight exercises (leg raises) means the weight stepper is hidden and only reps are logged.

Note: every exercise ships with `"video": null` and an optional `cues` array. Only `smith_incline` is shown fully populated above, as the shape reference. Add `"video": null` and a `cues` array to every exercise in the file. The user fills the URLs in themselves, once.

---

## 14. Build order

Build in this sequence. Do not move on until each is solid.

1. **Storage layer.** Dual write to localStorage and IndexedDB, read with healing, export, import. Test by clearing each store independently. This is the foundation and it is the only thing that cannot be fixed later.
2. **plan.json loader and renderer.** Today's day appears on open. Nothing hardcoded.
3. **Set pill and logging.** One tap commits. Prefill from history.
4. **Rest timer.**
5. **Progression engine.** `ADD WEIGHT` badge and pre-incremented prefill.
6. **Skip.**
7. **History and e1RM charts.**
8. **Bodyweight and measurements.**
9. **The backup nag.**
10. **The Plan page and the scheduled rule banners.** Week counter, ramp, review, deload.
11. **The Calendar page.** Month grid, colour by day type, amber PR dots, the four record numbers, the twelve month strip.
12. **PWA shell, offline, manifest, home screen icon.**
13. **Polish.** Motion, the fill sweep, spacing, the colour discipline.

## 15. Deployment

Static files on GitHub Pages, served from `/docs` or the `gh-pages` branch. No build step means `git push` is the deploy. Open the URL on the phone once, then Add to Home Screen.

## 16. Github
Repo link to push code - https://github.com/shubh0614/anchor.git
dont use emdash or ai slog anywhere dont mention pushed by claude code or sonnet or somthing like this in commit message. push code after every step.