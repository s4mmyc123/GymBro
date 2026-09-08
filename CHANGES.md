# Review notes: bug-hunt round 2

Four QA agents each attacked one area of the app (Train, Settings/data,
Home/Progress, Protein/Weight/shell). This file lists every change made in
response, in plain language, so you can review each one. Nothing here changes
what a feature does; each entry is a bug, a crash, or a logic inconsistency.

Each section heading carries the date it was written.

Legend: **[UI]** you would have hit this in normal use. **[Import]** only
reachable through a hand-edited or corrupted backup file. **[Latent]** would
bite a future change.

---

## 1. Data layer (`app.js`, the `Repo` object)  (7 Sep 2026)

### 1.1 Every record is shape-checked on the way out of the database  [Import]
Four separate crashes were reported from hand-edited backups: a session with
no `entries`, an entry with no `sets`, an exercise or muscle group with no
`name`, and a protein amount stored as text. Each one either hung the app on
"Loading…" or made a tab unreachable. Now each list function
(`listExercises`, `listSessions`, `listProtein`, `listBodyweight`,
`listMuscleGroups`) runs records through a normaliser. Missing arrays become
empty arrays, invalid numbers become blank, out-of-range frequencies are
clamped, and a record with no id, name, or valid date is dropped from the
list instead of breaking a view. Nothing is rewritten in the database.

### 1.2 Import validates first, then writes everything in one transaction  [Import]
Before: records were written one store at a time with no checks, so a bad
file could half-apply, report success on `{}` or `"hi"`, and leave a broken
record behind. Now the file must be an object with at least one known array,
every record is normalised up front (photos are decoded up front too), and
all writes happen in a single IndexedDB transaction. A bad file imports
completely or not at all. Settings are only accepted for known keys with
valid values, so a protein goal of `0` or `"abc"` can no longer get in.

### 1.3 Muscle groups merge by name on import  [UI]
Erase all data re-seeds the nine default groups. Importing a backup then
added them again under different ids, so Chest, Back, and so on appeared
twice everywhere. Incoming groups whose name matches an existing one
(case-insensitive) are now skipped. Exercises reference groups by name, so
nothing is lost.

### 1.4 Erase all data no longer deletes the next import  [UI]
The one-time cleanup that removed the old built-in exercise library runs
whenever a `builtinsCleared` flag is missing. Erase cleared that flag, so an
exercise imported straight afterwards without an `isCustom` field was
deleted on the next reload. Erase now re-sets the flag, and imported
exercises are marked custom. Erase also clears all stores in one transaction.

### 1.5 Database version changes are no longer blocked forever  [Latent]
The open connection had no `onversionchange` handler, so any future schema
bump, or even a delete of the database from another tab, would wait forever
behind the running app. The connection now closes itself when asked and
reopens on the next call. The one-tab-blocking case now reports an error
instead of hanging.

### 1.6 Sanity ceilings for numbers  [UI]
New constants cap a single set value at 10000, a protein entry or goal at
5000 g, and a body weight or goal at 1000 kg. These are deliberately far
above anything real. They exist so that a stray `1e9` cannot flatten every
chart. Values above the cap are rejected with a message (see section 4).

## 2. Calculations (`app.js`, domain helpers)  (7 Sep 2026)

### 2.1 Negative numbers no longer count as lifts or PRs  [UI]
Typing `-50` for weight was accepted, saved, shown as "Best -50kg × 5" and
announced as a new PR. The checks used "is the value truthy", which -50 is.
A new `isLiftSet` helper requires both weight and reps to be greater than
zero, and every best-set, PR, and history calculation uses it. Section 4
covers rejecting the input itself.

### 2.2 Two sessions on the same day are now in the right order  [UI]
Sessions are stored newest-first. The history and trend code re-sorted by
date only, and a stable sort kept two same-day sessions in reverse time
order. Result: a morning 50 kg and an evening 60 kg on the same day read as
60 then 50, the "since first log" pill said +0% instead of +20%, and the
trend line dipped. A shared `chronological` helper now sorts by date then
start time, and every history, PR, and best-set function uses it.

### 2.3 PR dates agree everywhere  [UI]
Personal Records showed the date a record was first set, but the "Best per
variation" list and the "Best:" pill on the detail screen showed the date of
the latest tie. All three now walk sessions oldest-first, so a tie keeps the
original date.

### 2.4 Exercise history is one row per calendar day  [UI]
The comment in the code said "one best set per session" but the loop
produced one row per entry. Logging two variations of one exercise in the
same workout produced two rows for one date and a false dip in the trend.
Now each day contributes one row: the best set across every entry and
session of that exercise on that day, with the volume summed. (The first
version of this fix grouped by session; the verification pass showed that
two same-day sessions then collapsed into a single Strength Index point, so
grouping by day is the consistent choice for the charts and the index.)

### 2.5 Future-dated sessions clamp to "Today"  [Import]
A session dated in the future rendered "-3 days ago" with a negative bar
width. The days-ago helper is now floored at zero.

### 2.6 Strength Index eligibility is by metric, not by any Cardio tag  [UI]
An exercise tagged both Cardio and Legs and tracked by weight × reps (a sled
push, say) was thrown out of the index entirely because one tag was Cardio.
Now an exercise counts when it is tracked by weight × reps and is not tagged
only with non-strength groups.

### 2.7 Protein streak is uncapped and cheaper  [UI]
The streak loop stopped at 367 days regardless of data. It now stops at the
first missed day, with a ten-year ceiling as a guard only. Daily totals are
built once into a map rather than re-filtering the whole log per day.

### 2.8 History for an exercise whose metric changed  [UI]
Changing an exercise from weight × reps to Time in Settings made its old sets
render as "0 min". Weight × reps sets now live in the strength history and
other sets in the generic history, regardless of the exercise's current
metric. Section 3 covers the detail screen that shows both.

## 3. Screens (`app.js`, view functions)  (7 Sep 2026)

### 3.1 "Matches/beats your best" now updates as you type  [UI]
The hint was only computed during a full re-render, so it appeared after
you added another set or switched tabs, never while typing. It was also only
ever shown under the last set. Each set now has its own hint holder that is
refreshed on every keystroke, without re-rendering the page (which would
steal focus from the input), and any qualifying set shows it.

### 3.2 "Last time" is formatted in the metric it was logged with  [UI]
After changing an exercise from weight × reps to Time, the Train screen
showed the previous 120×3 as "0 min". The previous entry now carries its
own metric, and ghost placeholders in the inputs only appear when the
metrics match.

### 3.3 Exercise detail shows both kinds of history  [UI]
The detail screen picked one layout by the exercise's current metric, which
hid a whole history after a metric change. It now shows a strength section
when any weight × reps sets exist and a generic section when any time,
distance, or reps-only sets exist, with an "Other logged sets" label when
both are present. A single-metric exercise looks exactly as before.

### 3.4 Home protein card cannot divide by zero  [Import]
The percent ring guards against a zero goal, and totals are rounded to one
decimal so `0.1 + 0.2` prints as 0.3 rather than 0.30000000000000004.

### 3.5 Empty state when there are no muscle groups  [UI]
The Home and Progress rotation cards rendered only a heading. They now say
"No muscle groups yet — add some in Settings."

### 3.6 Progress "This week" excludes future dates and deleted groups  [UI]
It counted sessions dated after today and muscle groups that no longer
exist, so it disagreed with the Home week strip.

### 3.7 Strength Index waits for two data points  [UI]
With one exercise logged once, the card showed "100 / +0%" while its own
empty-state text said it needed a couple of sessions. Both the overall
number and the per-muscle rows now need at least two points.

### 3.8 Weight chart x-axis is proportional to time  [UI]
Points were spaced evenly by index, so a weigh-in from a year ago and one
from last week sat side by side on the 1Y view. The x position is now the
elapsed time from the first point, and the middle date label is the point
nearest the centre, shown only if it is clear of the ends.

### 3.9 Name length limits and orphan tags  [UI]
Exercise names are capped at 60 characters, muscle groups and variations at
30, so a pasted paragraph can no longer force the whole page to scroll
sideways. Rotation labels wrap. When editing an exercise tagged with a
since-deleted muscle group, that tag now appears as a selected chip so it
can be removed. Before, it was invisible but still counted.

## 4. Buttons and input (`app.js`, event handlers and boot)  (7 Sep 2026)

### 4.1 One click at a time  [UI]
Tapping Add or Save three times quickly created three identical exercises
or muscle groups, because each handler waited on the database and the
duplicate check read stale state. The click handler now ignores clicks
while a previous one is still running.

### 4.2 Set inputs reject non-positive numbers with a message  [UI]
Values are stored only when they are a real number above zero and within
the ceiling. On leaving the field an unusable value is cleared and a toast
says "Sets need a positive number". Inputs also carry `min="0"`.

### 4.3 Protein, weight, and goal buttons explain a rejected value  [UI]
Zero, negative, empty, or oversize input used to do nothing silently. Each
case now shows a short toast saying what is wrong. Typing text into the
weight goal field used to clear the goal, because the browser reports text
in a number field as an empty value. That case is now detected and reported
instead.

### 4.4 Train form state no longer leaks into Settings  [UI]
Opening "New exercise" inside a workout and then reaching Settings via the
keyboard left the Settings form in Train mode, which could create a
duplicate exercise on save. Leaving the Train tab now closes the picker and
its form, and the Settings add and edit buttons clear the Train flags.
Text typed in the Settings form survives switching tabs; the Train sheet's
form is discarded on leaving Train, since the sheet itself closes.

### 4.5 Erase all data clears the in-progress workout  [UI]
The draft stayed in memory referencing deleted exercises and re-saved itself
on the next keystroke. Erase now drops the draft, closes any open sheet or
form, and stops the rest timer.

### 4.6 Editing an exercise that was deleted meanwhile  [UI]
Save used to throw silently. It now says "That exercise no longer exists"
and closes the form. Deleting the exercise whose edit form is open closes
the form too.

### 4.7 Duplicate exercise names are refused  [UI]
Same rule as muscle groups: case-insensitive, with an "Already in your
library" toast. Renaming an exercise to its own name is still allowed.

### 4.8 Honest toasts  [UI]
Creating an exercise with variations from inside a workout said "Added to
library + workout" before a variation was picked. It now says to pick one.
The Finish toast shows both the PR count and the number of exercises
skipped for having no sets, rather than one or the other.

### 4.9 Muscle group frequency is clamped to 1 to 14 whole numbers  [UI]
Add and inline edit both use the same rule, and the inline field shows the
value that was actually saved.

### 4.10 Import feedback  [UI]
The toast now reports what was imported, for example "Imported 40
sessions, 12 exercises · 3 muscle groups already existed", and distinguishes
"not a We Go Gym backup" from an unreadable file. Picking the same file
twice in a row works.

### 4.11 Boot  [Import]
The in-progress draft is put through the same shape checks as a stored
session before being restored, so a corrupt draft cannot show "Invalid Date
/ NaN min". The first render is inside the error guard, so any failure shows
the error screen rather than "Loading…" forever.

## 5. Shell files  (7 Sep 2026)

- `styles.css`: protein bar container is tall enough that a 150 g and a
  160 g day no longer render at the same height. Inputs are 16px, which
  stops iOS zooming into a focused field.
- `index.html`: removed `maximum-scale=1` (pinch-zoom works again; the 16px
  inputs make it unnecessary). The Apple home-screen icon now points at the
  180px icon that was already in the folder but unused.
- `manifest.json`: icons are listed once as `any` and once as `maskable`,
  as Chrome recommends, instead of the combined value.
- `sw.js`: cache bumped to v12 and the Apple icon added to the offline list.

## 6. Reported but deliberately not changed  (7 Sep 2026)

These are behaviour decisions rather than defects. They are yours to call.

- **Strength Index with a tiny first set.** A first-ever set of 0.001 kg
  makes every later percentage astronomical. Any fix means choosing a
  different baseline (best of the first week, say), which changes what the
  number means.
- **Decimal reps.** 2.5 reps is accepted. Rejecting it is a validation
  choice, not a bug.
- **Import is a merge, not a replace.** The README describes it that way.
  Sessions and exercises with the same id are overwritten, others are added.
- **Future-dated sessions still appear in Recent sessions and Personal
  Records** with their stated date. Only the day-count and week totals were
  clamped.

## 7. Housekeeping  (7 Sep 2026)

- Removed `viewRotationFull`, a view function nothing called. The rotation
  list it rendered lives on the Home and Progress tabs via `rotationListHTML`.

## 8. Second verification round  (7 Sep 2026)

After the fixes above, four fresh agents re-tested every area against the
new build. All reported bugs were confirmed fixed with no regressions. They
raised the following, all now addressed.

### 8.1 Import merge kept the wrong frequency  [UI]  (regression from 1.3)
Skipping a muscle group whose name already existed meant a restored backup
lost your frequencies and colours to the re-seeded defaults. A name match
now keeps the existing id but takes the backup's frequency and colour. The
import toast reports "N muscle groups updated".

### 8.2 Editing an exercise without renaming it  [Import]
Two exercises with the same name can arrive via import. The duplicate-name
check then blocked saving either one, even to change a photo. The check now
runs only when the name actually changes.

### 8.3 Lifts logged on a single day no longer feed the Strength Index  [UI]
A one-off lift sat at 100 forever and dragged the average toward "no
change". A lift needs two days of history before it counts.

### 8.4 Photo removal  [UI]
The handler to delete a photo existed but nothing rendered a button for it.
The edit form now shows Remove next to Change photo when a photo is saved.

### 8.5 Imported long names  [Import]
Names longer than the input limits are cut to the same limits on read, and
rows in Settings, Train, and the picker wrap rather than widening the page.

### 8.6 Smaller items
- A set value above the ceiling now says "Sets can't be more than 10000"
  rather than "positive number".
- Clearing an inline frequency field keeps the previous value instead of
  resetting to 2.
- Typed text in the exercise form survives every click, including adding or
  deleting a muscle group.
- The import summary lists every kind of record imported, and says "Nothing
  new in that backup" when there was none.
- Numeric settings in a backup are stored as numbers even if the file had
  them as text. Photos for exercises that do not exist are skipped.
- Weight chart date labels include the year when the range spans more than
  about ten months.
- The one-click-at-a-time guard releases itself after five seconds, so a
  handler stuck on a promise cannot freeze every button.
- Any unexpected error inside a click or change handler now shows "Something
  went wrong — try again, or reload the app" instead of failing silently.

### 8.7 Reported, left as is
- 1Y is today plus the 364 days before it, consistent with the other ranges.
- Invalid records hidden by the normaliser stay in the database untouched.
- A half-filled set (reps but no weight) is still saved and counted in
  "sets logged"; it is excluded from bests and PRs. Pre-existing behaviour.

## 9. Strength Index baseline (your call from section 6)  (7 Sep 2026)

Each exercise variation now has its own series, and its baseline is the
strongest estimated 1RM among its first two logged days rather than the
first day alone. A cautious first session no longer inflates every later
percentage, and a rope pushdown is measured against rope history rather
than the straight bar's. The overall index and the per-muscle rows average
those per-variation series. A lift still needs two days of history to
count, so on its second day a lift sits at or below 100 and moves from
there. The card text and the README paragraph describe the new rule. The
"+X% since first log" pill on an exercise's detail screen is unchanged: it
is a different, literal figure.

## 10. Tap a photo to enlarge it  (7 Sep 2026)

Every exercise photo (Train, the picker, Settings, Personal Records, Lift
progress, and the detail screen) now opens full-screen when tapped. Tap
anywhere or press Escape to close, and the phone's pinch-zoom works on the
enlarged image. New photos are stored at up to 1200px on the long edge
(was 480px) so they look sharp at full screen; existing photos keep their
current size until replaced via Edit exercise. Service worker cache
bumped to v13 because index.html changed.

## 11. Home shows Resume Workout when one is in progress  (7 Sep 2026)

The Home button read "Start Workout" even with a session open. It now
reads "Resume Workout" with the exercise count and elapsed time, in the
orange accent instead of green, whenever a workout is in progress.

## 12. New sets start blank  (7 Sep 2026)

"+ Add set" no longer copies the previous set's weight and reps into the
new row. The row starts empty; last session's numbers remain visible as
grey placeholders for reference only.

## 13. Buttons no longer squash beside inputs  (8 Sep 2026)

On a phone the Save and Add buttons next to full-width inputs (Settings
protein goal, Protein tab, Home) were squeezed until their labels wrapped
into "Sav / e" and "Ad / d", and the Weight tab's Update button became a
vertical column of letters. Buttons now never shrink or wrap; the input
beside them gives way instead. The Weight tab's change-over-range pill
moved to its own line under the big number so it no longer collides with
the input.

## 14. Words no longer split across lines  (8 Sep 2026)

Exercise names in a workout could break mid-word ("Pulldo / wn") when the
photo, the variation tag, and the Remove button competed for the row. The
rule that allowed long imported names to wrap was too aggressive. Text now
wraps at spaces; a single word only breaks if it is wider than the whole
container. In a workout the exercise name stays whole and the variation
tag moves to its own line when the row is tight. A scan of Home, Train,
Progress, Settings, and the picker at phone width found no remaining split
words and no sideways overflow.

## 15. The orange tag means the variation, only  (8 Sep 2026)

In a workout the orange tag next to an exercise name showed either the
variation you picked or, for exercises not tracked by weight × reps, the
measurement type ("Reps only (bodyweight)"). Two meanings in one style. The
measurement tag is gone from the workout screen: the set row already shows
a single reps, min, or km box, which says the same thing. The measurement
type is still listed in grey in the picker, in Settings, and on the
exercise's detail screen.

## 16. Units shown inside each set box  (8 Sep 2026)

Every set input now shows its unit on the right, inside the box: kg and
reps for lifts, reps for bodyweight exercises, min for time, km for
distance. It stays visible while you type, so "8" reads as "8 reps"
without a separate tag. Last session's numbers still appear as grey
placeholders when the box is empty.

## 17. Protein tracking removed  (8 Sep 2026)

The Protein tab, the Today's protein card on Home, the protein chart on
Progress, and the protein goal in Settings are gone, along with the quick
add chips, the streak, and the ring. The database moves to version 3,
which deletes the protein store and the stored goal on first open, so no
protein data remains on the device. Backups no longer include protein;
an older backup that still has a protein section imports fine with that
section ignored. The nav now has five tabs. Descriptions in the README,
manifest, and page metadata were updated to match.
