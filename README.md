# Custom Fit

A simple, local-first gym tracker: log sessions and lifts, see which muscle groups are next in your rotation, and track your body weight. No accounts, no cloud, no build step: just files you open in a browser.

## What it does

- **Home**: today's top 3 muscle groups to train next, a one-tap Start (or Resume) Workout shortcut, and a quick body weight log: all without leaving the screen.
- **Train**: start a session, add exercises, log sets (weight × reps). Matches or beats to your best are flagged live. Bests and PRs are tracked per exercise *and* variation, so a rope pushdown and a straight-bar pushdown each keep their own record.
- **Rotation**: every muscle group's "days since last trained" is ranked on Home and Progress, so you always know what's next.
- **Progress**: a one-stop trends screen: Strength Index, muscle rotation, personal records, and per-exercise trend lines (estimated 1RM and session volume).
- **Strength Index**: a single "are you stronger than when you started tracking" number (100 = your early baseline, rises as your lifts improve), plus a per-muscle-group breakdown so you can see which muscle groups are progressing fastest. See "How the Strength Index works" below for the reasoning.
- **Weight**: its own tab with a stock-app-style trend chart: filterable by 1W/2W/1M/3M/6M/1Y/All (defaults to 2W, 1W is the shortest window), plus quick logging (one entry per day; logging again updates it) and a full history list.
- **Muscle groups**: Chest, Back, Shoulders, Biceps, Triceps, Legs (a general lower-body category), Quads, Abs, and Cardio. Compound leg lifts (squats, deadlifts, lunges, etc.) are tagged both "Legs" and "Quads" where relevant, so you can track either the broad or the specific view.
- **Cardio**: tracked as its own rotation category with a starter set of exercises (Running, Cycling, Rowing Machine, Jump Rope, Elliptical, Stair Climber) logged the same way as lifts: it's excluded from the Strength Index since 1RM doesn't apply to it.
- **Settings**: manage your exercise library and muscle groups, and export/import a full JSON backup.

Everything is stored locally on your device in IndexedDB: nothing leaves your phone.

## How the Strength Index works

Exercises live at wildly different absolute weights (a 40kg curl vs. a 140kg squat), so they can't just be summed to get a meaningful "total". Instead, each exercise variation's own best-estimated-1RM history (one point per day) is converted to "% of its baseline", where the baseline is the strongest of its first two logged days: so a tentative first session doesn't set an artificially low bar, and a rope pushdown and a straight-bar pushdown are measured against their own numbers. A lift needs at least two days of history before it counts. The overall Strength Index is the average of those normalized values across every strength lift you've logged (cardio excluded); the per-muscle-group breakdown on Progress does the same thing but only for exercises tagged to that muscle. It's a relative trend, not an absolute strength score: the number itself doesn't mean much, but its direction over time does.

## Running it on your phone

The app is a set of plain files (no npm, no build). Easiest paths, in order of effort:

### Option A, quickest: on this computer (no installs needed)
This folder already includes `serve.ps1`, a zero-install local server (uses .NET, built into Windows: no Python or Node required).

1. Right-click in this folder and choose **Open in Terminal** (or open PowerShell and `cd` into this folder).
2. Run once per PowerShell session:
   ```
   Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass -Force
   ```
3. Then run:
   ```
   .\serve.ps1
   ```
4. Open `http://localhost:8080` in Chrome on this computer, or `http://<this-computer's-IP>:8080` from your phone (same Wi-Fi).
5. Tap Share → **Add to Home Screen** (iOS) or the browser menu → **Install app** (Android) for a full-screen app icon.

### Option B, a real URL (recommended if you'll use it daily)
Deploy the folder to a free static host so it has a stable HTTPS address you can open from anywhere:
- **Netlify Drop**: go to app.netlify.com/drop and drag this folder in: you get a URL instantly.
- **GitHub Pages**: push this folder to a repo and enable Pages in settings.
- **Vercel**: `vercel` CLI or drag-and-drop deploy.

Then open that URL on your phone and Add to Home Screen. Because it registers a service worker, it keeps working with no signal after the first load.

## Data & backups

All data lives in your browser's IndexedDB, scoped to whichever URL you open the app from. That means:
- If you switch hosting URLs, your data won't follow automatically: use **Settings → Export backup**, then **Import backup** on the new install.
- Clearing your browser's site data / "clear browsing data" will wipe it: export a backup occasionally, especially before doing that.
- Uninstalling the home-screen icon does **not** delete the data (it's tied to the browser, not the icon): but uninstalling/reinstalling the browser itself would.

## Making it multi-user (for friends, later)

The code is deliberately structured so this is a small, contained change. Every piece of the app calls a single `Repo` object in `app.js` (see the comment at the top of the file) for all reads/writes: nothing else touches IndexedDB directly. To add friends later:

1. Stand up a small backend (a free-tier Supabase or Firebase project is the least work: both give you a database plus auth in a few lines).
2. Rewrite the inside of `Repo`'s methods to call that backend's API instead of `indexedDB.*` calls.
3. Everything else: views, rotation math, PR detection, rendering: is unaffected, since it never knows where the data actually lives.

Until then, **Export backup / Import backup** in Settings is your manual way to move data between devices or hand a friend a starting point.

## Project structure

```
index.html      app shell + PWA meta tags
styles.css      all styling (dark, mobile-first)
app.js          the entire app: data layer, views, rotation/PR logic
manifest.json   installable PWA config
sw.js           offline caching (service worker)
serve.ps1       zero-install local server (Windows/.NET)
icons/          home-screen icons
```

## Ideas for later (not built, just food for thought)

- **Rest timer** between sets, with a subtle vibration/sound when it's up.
- **Warm-up set suggestions** based on your last working weight for an exercise.
- **Plate calculator**: punch in a target weight, get the plates to load per side.
- **Weekly recap notification**: "Legs" hasn't been hit in 9 days: via a scheduled check if you want it pushed to you rather than checked manually.
