/* =========================================================================
   We Go Gym — local-first gym tracker
   Plain JS, no build step, no external dependencies.

   ARCHITECTURE NOTE (for future multi-user / friends scaling):
   All persistence goes through the `Repo` object below. Every other part of
   the app calls Repo.* methods and never touches IndexedDB directly. If you
   later want to add a shared backend (e.g. Supabase/Firebase/a small REST
   API) so friends can use this too, you only need to rewrite the inside of
   Repo's methods to call that backend instead of IndexedDB — the rest of
   the app (views, rendering, rotation/PR logic) stays untouched.
   ========================================================================= */

(function () {
  "use strict";

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------
  // Muscle groups are fully user-managed (see the Settings tab) — each one
  // has a name, a target weekly frequency, and a color assigned from this
  // palette when it's created. Defaults below are only used to seed a
  // starting list for new installs; the user can rename the concept
  // entirely by deleting/adding groups afterwards.
  const MUSCLE_COLOR_PALETTE = [
    "#f97316", "#38bdf8", "#a78bfa", "#f472b6", "#fb7185", "#60a5fa", "#4ade80", "#fbbf24", "#ef4444",
    "#2dd4bf", "#facc15", "#c084fc", "#fb923c", "#34d399"
  ];
  const DEFAULT_MUSCLE_GROUPS = [
    { name: "Chest", color: "#f97316" }, { name: "Back", color: "#38bdf8" },
    { name: "Shoulders", color: "#a78bfa" }, { name: "Biceps", color: "#f472b6" },
    { name: "Triceps", color: "#fb7185" }, { name: "Legs", color: "#60a5fa" },
    { name: "Quads", color: "#4ade80" }, { name: "Abs", color: "#fbbf24" },
    { name: "Cardio", color: "#ef4444" }
  ];
  const DEFAULT_FREQUENCY = 2; // times per week

  // Muscle groups that aren't about lifting heavier over time — excluded from the Strength Index.
  const NON_STRENGTH_GROUPS = ["Cardio"];

  // Retired tags, folded into "Legs" — kept only so already-seeded exercise
  // records can be migrated on load (see migrateLegacyMuscleGroups below).
  const REMOVED_MUSCLE_GROUPS = ["Hamstrings", "Glutes", "Calves"];

  // The exercise library is fully user-built — you add each exercise
  // yourself (with muscle groups, optional variations and an optional photo).
  // The old pre-seeded defaults were retired; clearBuiltinExercises below
  // removes them once from devices that had them.

  // What a set logs depends on the exercise's metric. Only "weight_reps"
  // feeds Best/PRs/the Strength Index (est. 1RM needs both a weight and a
  // rep count) — the others just record their raw numbers per set.
  const METRIC_TYPES = {
    weight_reps: { label: "Weight × reps", fields: [
      { key: "weight", unit: "kg", placeholder: "kg", inputMode: "decimal" },
      { key: "reps", unit: "reps", placeholder: "reps", inputMode: "numeric" }
    ] },
    reps_only: { label: "Reps only (bodyweight)", fields: [
      { key: "reps", unit: "reps", placeholder: "reps", inputMode: "numeric" }
    ] },
    time: { label: "Time", fields: [
      { key: "minutes", unit: "min", placeholder: "min", inputMode: "decimal" }
    ] },
    distance: { label: "Distance", fields: [
      { key: "distance", unit: "km", placeholder: "km", inputMode: "decimal" }
    ] }
  };
  const DEFAULT_METRIC = "weight_reps";

  function metricFields(metric) {
    return (METRIC_TYPES[metric] || METRIC_TYPES[DEFAULT_METRIC]).fields;
  }
  function emptySet(metric) {
    const set = {};
    metricFields(metric).forEach((f) => (set[f.key] = ""));
    return set;
  }
  function formatSetValue(set, metric) {
    if (metric === "weight_reps") return `${set.weight || 0}×${set.reps || 0}`;
    if (metric === "reps_only") return `${set.reps || 0} reps`;
    if (metric === "time") return `${set.minutes || 0} min`;
    if (metric === "distance") return `${set.distance || 0} km`;
    return "";
  }

  const DB_NAME = "ironLogDB";
  const DB_VERSION = 2;
  const todayStr = () => new Date().toISOString().slice(0, 10);
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // -----------------------------------------------------------------------
  // Repo: all persistence lives behind this API (see architecture note top)
  // -----------------------------------------------------------------------
  const Repo = (function () {
    let dbPromise = null;

    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);
        req.onupgradeneeded = () => {
          const db = req.result;
          if (!db.objectStoreNames.contains("exercises")) {
            db.createObjectStore("exercises", { keyPath: "id" });
          }
          if (!db.objectStoreNames.contains("sessions")) {
            const s = db.createObjectStore("sessions", { keyPath: "id" });
            s.createIndex("date", "date");
          }
          if (!db.objectStoreNames.contains("protein")) {
            const p = db.createObjectStore("protein", { keyPath: "id" });
            p.createIndex("date", "date");
          }
          if (!db.objectStoreNames.contains("settings")) {
            db.createObjectStore("settings", { keyPath: "key" });
          }
          if (!db.objectStoreNames.contains("photos")) {
            db.createObjectStore("photos", { keyPath: "exerciseId" });
          }
          if (!db.objectStoreNames.contains("bodyweight")) {
            db.createObjectStore("bodyweight", { keyPath: "date" });
          }
          if (!db.objectStoreNames.contains("muscleGroups")) {
            db.createObjectStore("muscleGroups", { keyPath: "id" });
          }
        };
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
      return dbPromise;
    }

    function tx(store, mode) {
      return open().then((db) => db.transaction(store, mode).objectStore(store));
    }

    function reqToPromise(req) {
      return new Promise((resolve, reject) => {
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      });
    }

    function getAll(store) {
      return tx(store, "readonly").then((os) => reqToPromise(os.getAll()));
    }
    function put(store, value) {
      return tx(store, "readwrite").then((os) => reqToPromise(os.put(value)));
    }
    function del(store, key) {
      return tx(store, "readwrite").then((os) => reqToPromise(os.delete(key)));
    }
    function get(store, key) {
      return tx(store, "readonly").then((os) => reqToPromise(os.get(key)));
    }

    async function ensureSeeded() {
      const goal = await get("settings", "proteinGoal");
      if (!goal) await put("settings", { key: "proteinGoal", value: 150 });
    }

    // One-time cleanup: remove the old pre-seeded exercise library so the
    // user can build their own from scratch. Custom exercises are kept, and
    // past sessions keep their logged history (they store name snapshots).
    async function clearBuiltinExercises() {
      const done = await get("settings", "builtinsCleared");
      if (done) return;
      const exercises = await getAll("exercises");
      for (const ex of exercises) {
        if (!ex.isCustom) {
          await del("exercises", ex.id);
          await del("photos", ex.id);
        }
      }
      await put("settings", { key: "builtinsCleared", value: true });
    }

    // One-time cleanup: exercises seeded before Hamstrings/Glutes/Calves were
    // retired still have those tags stored. Strip them and make sure "Legs"
    // is present instead, so rotation/Strength Index don't reference groups
    // that no longer exist. Past *sessions* keep their original snapshot —
    // only the exercise library itself is migrated.
    async function migrateLegacyMuscleGroups() {
      const exercises = await getAll("exercises");
      for (const ex of exercises) {
        if (!ex.muscleGroups.some((mg) => REMOVED_MUSCLE_GROUPS.includes(mg))) continue;
        const cleaned = ex.muscleGroups.filter((mg) => !REMOVED_MUSCLE_GROUPS.includes(mg));
        if (!cleaned.includes("Legs")) cleaned.push("Legs");
        await put("exercises", Object.assign({}, ex, { muscleGroups: cleaned }));
      }
    }

    // One-time seed: give new installs a starting muscle group list (with
    // frequency + color already set) that the user is then free to edit,
    // delete from, or add to in Settings.
    async function ensureMuscleGroupsSeeded() {
      const done = await get("settings", "muscleGroupsSeeded");
      if (done) return;
      const existing = await getAll("muscleGroups");
      if (existing.length === 0) {
        for (const mg of DEFAULT_MUSCLE_GROUPS) {
          await put("muscleGroups", { id: uid(), name: mg.name, frequency: DEFAULT_FREQUENCY, color: mg.color });
        }
      }
      await put("settings", { key: "muscleGroupsSeeded", value: true });
    }

    return {
      init: () => open().then(ensureSeeded).then(clearBuiltinExercises).then(migrateLegacyMuscleGroups).then(ensureMuscleGroupsSeeded),

      // Muscle groups — fully user-managed (see Settings)
      listMuscleGroups: () => getAll("muscleGroups").then((l) => l.sort((a, b) => a.name.localeCompare(b.name))),
      addMuscleGroup: (name, frequency) => getAll("muscleGroups").then((existing) =>
        put("muscleGroups", { id: uid(), name, frequency, color: MUSCLE_COLOR_PALETTE[existing.length % MUSCLE_COLOR_PALETTE.length] })
      ),
      updateMuscleGroup: (mg) => put("muscleGroups", mg),
      deleteMuscleGroup: (id) => del("muscleGroups", id),

      // Exercises
      listExercises: () => getAll("exercises").then((l) => l.sort((a, b) => a.name.localeCompare(b.name))),
      addExercise: (name, muscleGroups, variations, metric) =>
        put("exercises", { id: uid(), name, muscleGroups, variations: variations || [], metric: metric || DEFAULT_METRIC, isCustom: true }),
      updateExercise: (ex) => put("exercises", ex),
      deleteExercise: (id) => del("exercises", id),

      // Sessions
      listSessions: () => getAll("sessions").then((l) => l.sort((a, b) => b.date.localeCompare(a.date) || (b.startedAt - a.startedAt))),
      saveSession: (session) => put("sessions", session),
      deleteSession: (id) => del("sessions", id),

      // Protein
      listProtein: () => getAll("protein").then((l) => l.sort((a, b) => b.loggedAt - a.loggedAt)),
      addProtein: (amount, note) => put("protein", { id: uid(), date: todayStr(), amount, note: note || "", loggedAt: Date.now() }),
      deleteProtein: (id) => del("protein", id),

      // Settings
      getSetting: (key, fallback) => get("settings", key).then((r) => (r ? r.value : fallback)),
      setSetting: (key, value) => put("settings", { key, value }),

      // Photos (one per exercise, stored as a compressed Blob)
      listPhotos: () => getAll("photos"),
      getPhoto: (exerciseId) => get("photos", exerciseId),
      setPhoto: (exerciseId, blob) => put("photos", { exerciseId, blob }),
      deletePhoto: (exerciseId) => del("photos", exerciseId),

      // Body weight (one entry per day — logging again the same day overwrites it)
      listBodyweight: () => getAll("bodyweight").then((l) => l.sort((a, b) => a.date.localeCompare(b.date))),
      setBodyweight: (date, weight) => put("bodyweight", { date, weight, loggedAt: Date.now() }),
      deleteBodyweight: (date) => del("bodyweight", date),

      // Export / Import (manual backup today; becomes the seed for real sync later)
      async exportAll() {
        const [exercises, sessions, protein, photos, bodyweight, muscleGroups] = await Promise.all([
          getAll("exercises"), getAll("sessions"), getAll("protein"), getAll("photos"), getAll("bodyweight"), getAll("muscleGroups")
        ]);
        const settingsList = await getAll("settings");
        // Blobs can't be JSON-stringified directly — encode as base64 data URLs for export.
        const photosEncoded = await Promise.all(photos.map((p) => new Promise((resolve) => {
          const reader = new FileReader();
          reader.onload = () => resolve({ exerciseId: p.exerciseId, dataUrl: reader.result });
          reader.readAsDataURL(p.blob);
        })));
        return { exportedAt: new Date().toISOString(), exercises, sessions, protein, settings: settingsList, photos: photosEncoded, bodyweight, muscleGroups };
      },
      async importAll(data) {
        if (data.exercises) for (const e of data.exercises) await put("exercises", e);
        if (data.sessions) for (const s of data.sessions) await put("sessions", s);
        if (data.protein) for (const p of data.protein) await put("protein", p);
        if (data.settings) for (const s of data.settings) await put("settings", s);
        if (data.bodyweight) for (const b of data.bodyweight) await put("bodyweight", b);
        if (data.muscleGroups) for (const m of data.muscleGroups) await put("muscleGroups", m);
        if (data.photos) {
          for (const p of data.photos) {
            if (!p.dataUrl) continue;
            const blob = await (await fetch(p.dataUrl)).blob();
            await put("photos", { exerciseId: p.exerciseId, blob });
          }
        }
      },
      async clearAll() {
        const db = await open();
        for (const store of ["exercises", "sessions", "protein", "settings", "photos", "bodyweight", "muscleGroups"]) {
          await new Promise((res, rej) => {
            const r = db.transaction(store, "readwrite").objectStore(store).clear();
            r.onsuccess = res; r.onerror = () => rej(r.error);
          });
        }
        await ensureSeeded();
        await ensureMuscleGroupsSeeded();
      }
    };
  })();

  // -----------------------------------------------------------------------
  // Domain helpers
  // -----------------------------------------------------------------------
  function daysAgo(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    const now = new Date(todayStr() + "T00:00:00");
    return Math.round((now - d) / 86400000);
  }

  function fmtDaysAgo(n) {
    if (n === 0) return "Today";
    if (n === 1) return "Yesterday";
    return n + " days ago";
  }

  // Most recent session entry for an exercise — powers "last time" hints
  // while logging (sessions list is sorted newest-first). Pass a variation
  // string ("" = no variation) to only match that variation, so e.g. rope
  // and straight-bar pushdowns keep separate histories.
  function lastEntryForExercise(sessions, exerciseId, variation) {
    for (const s of sessions) {
      for (const entry of s.entries) {
        if (entry.exerciseId !== exerciseId) continue;
        if (variation !== undefined && (entry.variation || "") !== variation) continue;
        if (entry.sets.some((x) => Object.values(x).some((v) => v))) return { date: s.date, sets: entry.sets };
      }
    }
    return null;
  }

  // Best set for one exercise + variation combination (same filtering rule)
  function bestSetForVariation(sessions, exerciseId, variation) {
    let best = null;
    for (const s of sessions) {
      for (const entry of s.entries) {
        if (entry.exerciseId !== exerciseId) continue;
        if ((entry.variation || "") !== variation) continue;
        for (const set of entry.sets) {
          if (!set.weight || !set.reps) continue;
          const orm = estOneRM(set.weight, set.reps);
          if (!best || orm > best.orm) best = { orm, weight: set.weight, reps: set.reps, date: s.date };
        }
      }
    }
    return best;
  }

  function greeting() {
    const h = new Date().getHours();
    if (h < 5) return "Late night session?";
    if (h < 12) return "Good morning";
    if (h < 18) return "Good afternoon";
    return "Good evening";
  }

  function estOneRM(weight, reps) {
    if (!weight || !reps) return 0;
    return weight * (1 + reps / 30);
  }

  // Build a map: muscleGroup -> { lastDate, daysSince } from session history
  // Each muscle group's target frequency (times/week) implies a target rest
  // interval (7 / frequency days) — daysSince is compared against that
  // interval, rather than a fixed threshold, so a muscle trained often (e.g.
  // 4x/week) shows overdue sooner than one trained rarely (e.g. 1x/week).
  function computeRotation(sessions) {
    const groups = state.muscleGroups;
    const last = {};
    groups.forEach((mg) => (last[mg.name] = null));
    for (const s of sessions) {
      for (const entry of s.entries) {
        for (const mg of entry.muscleGroups || []) {
          if (!(mg in last)) continue;
          if (!last[mg] || s.date > last[mg]) last[mg] = s.date;
        }
      }
    }
    return groups.map((mg) => {
      const daysSince = last[mg.name] ? daysAgo(last[mg.name]) : Infinity;
      const interval = 7 / (mg.frequency || 1);
      return {
        muscle: mg.name,
        frequency: mg.frequency || 1,
        lastDate: last[mg.name],
        daysSince,
        overdueRatio: daysSince === Infinity ? Infinity : daysSince / interval
      };
    }).sort((a, b) => b.overdueRatio - a.overdueRatio);
  }

  // Thresholds are fractions of the target interval (7 / frequency days),
  // not fixed day counts — e.g. at 2x/week (3.5-day interval), day 3 is
  // already 0.86 of the way there, so it shows as "upcoming" (orange)
  // rather than waiting until the interval is actually reached.
  function rotationColor(overdueRatio) {
    if (overdueRatio === Infinity || overdueRatio >= 1.5) return "bad";
    if (overdueRatio >= 0.75) return "warn";
    return "good";
  }

  const ROTATION_STATUS_COLORS = { good: "var(--good)", warn: "var(--warn)", bad: "var(--bad)" };

  // Shared row markup for the three places rotation renders (Home, full
  // Muscle rotation card, Progress tab's inline copy). Bar color reflects
  // training urgency relative to each muscle's own target frequency — not
  // the muscle's identity — so green/orange/red always means
  // recently-done/upcoming/overdue.
  function rotationItemHTML(r) {
    const pct = r.overdueRatio === Infinity ? 100 : Math.min(100, Math.round((r.overdueRatio / 1.5) * 100));
    const status = rotationColor(r.overdueRatio);
    return `
      <div class="rotation-item" style="margin-bottom:10px">
        <span class="small" style="width:78px">${r.muscle}<div class="small muted" style="font-weight:400">${r.frequency}x/wk</div></span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${ROTATION_STATUS_COLORS[status]}"></div></div>
        <span class="pill ${status}">${r.daysSince === Infinity ? "Never" : fmtDaysAgo(r.daysSince)}</span>
      </div>
    `;
  }

  // Best set (by est 1RM) per exercise across all sessions
  function bestSetsByExercise(sessions) {
    const best = {};
    for (const s of sessions) {
      for (const entry of s.entries) {
        for (const set of entry.sets) {
          const orm = estOneRM(set.weight, set.reps);
          if (!best[entry.exerciseId] || orm > best[entry.exerciseId].orm) {
            best[entry.exerciseId] = { orm, weight: set.weight, reps: set.reps, date: s.date };
          }
        }
      }
    }
    return best;
  }

  // Chronological history entries (weight/reps/1RM/volume) for one exercise
  function exerciseHistory(sessions, exerciseId) {
    const history = [];
    for (const s of sessions) {
      for (const entry of s.entries) {
        if (entry.exerciseId !== exerciseId) continue;
        let sessionVolume = 0;
        let sessionBestOrm = 0, sessionBestSet = null;
        for (const set of entry.sets) {
          if (!set.weight || !set.reps) continue;
          sessionVolume += set.weight * set.reps;
          const orm = estOneRM(set.weight, set.reps);
          if (orm > sessionBestOrm) { sessionBestOrm = orm; sessionBestSet = set; }
        }
        if (sessionBestSet) {
          history.push({ date: s.date, weight: sessionBestSet.weight, reps: sessionBestSet.reps, orm: sessionBestOrm, volume: sessionVolume });
        }
      }
    }
    history.sort((a, b) => a.date.localeCompare(b.date));
    return history;
  }

  // Flat, chronological log of every set for a non-weight_reps exercise
  // (time / distance / reps-only) — no "best" concept, just the raw numbers.
  function genericSetHistory(sessions, exerciseId) {
    const history = [];
    for (const s of sessions) {
      for (const entry of s.entries) {
        if (entry.exerciseId !== exerciseId) continue;
        const metric = entry.metric || DEFAULT_METRIC;
        for (const set of entry.sets) {
          if (!Object.values(set).some((v) => v)) continue;
          history.push({ date: s.date, set, metric });
        }
      }
    }
    history.sort((a, b) => a.date.localeCompare(b.date));
    return history;
  }

  // Sorted list of {exerciseId, best, date} — most recent PR first — for a "Personal Records" overview
  function recentPRs(sessions) {
    const bestSoFar = {};
    const prEvents = [];
    for (const s of sessions.slice().sort((a, b) => a.date.localeCompare(b.date))) {
      for (const entry of s.entries) {
        for (const set of entry.sets) {
          if (!set.weight || !set.reps) continue;
          const orm = estOneRM(set.weight, set.reps);
          if (!bestSoFar[entry.exerciseId] || orm > bestSoFar[entry.exerciseId].orm) {
            bestSoFar[entry.exerciseId] = { orm, weight: set.weight, reps: set.reps, date: s.date, exerciseName: entry.exerciseName };
          }
        }
      }
    }
    for (const exId in bestSoFar) prEvents.push({ exerciseId: exId, ...bestSoFar[exId] });
    prEvents.sort((a, b) => b.date.localeCompare(a.date));
    return prEvents;
  }

  // -----------------------------------------------------------------------
  // Strength Index — a single relative-progress number, since exercises use
  // wildly different absolute weights (a 40kg curl and a 140kg squat) and
  // can't be summed directly. Each exercise's own best-estimated-1RM history
  // is normalized to "% of its own first logged value" (so every exercise
  // starts at 100), then those normalized series are averaged together —
  // across all exercises for the overall index, or across only the
  // exercises tagged to one muscle group for that group's index. A rising
  // number means you're moving more weight than when you started tracking,
  // regardless of which specific lifts drove it.
  // -----------------------------------------------------------------------
  function normalizedExerciseSeries(sessions, exerciseId) {
    const history = exerciseHistory(sessions, exerciseId);
    if (history.length === 0 || !history[0].orm) return [];
    const base = history[0].orm;
    return history.map((h) => ({ date: h.date, value: (h.orm / base) * 100 }));
  }

  // Averages multiple {date,value} series into one timeline, carrying each
  // series' last known value forward so exercises trained less often don't
  // drop out between their own sessions.
  function mergeSeriesAverage(seriesList) {
    const allDates = Array.from(new Set(seriesList.flatMap((s) => s.map((p) => p.date)))).sort();
    const merged = [];
    for (const date of allDates) {
      let sum = 0, count = 0;
      for (const s of seriesList) {
        let v = null;
        for (const p of s) { if (p.date <= date) v = p.value; else break; }
        if (v !== null) { sum += v; count++; }
      }
      if (count > 0) merged.push({ date, value: sum / count });
    }
    return merged;
  }

  function computeStrengthIndex(sessions, exercises) {
    const strengthExercises = exercises.filter((ex) => !ex.muscleGroups.some((mg) => NON_STRENGTH_GROUPS.includes(mg)));

    const overallSeries = mergeSeriesAverage(
      strengthExercises.map((ex) => normalizedExerciseSeries(sessions, ex.id)).filter((s) => s.length > 0)
    );

    const byMuscle = {};
    for (const mgObj of state.muscleGroups) {
      const mg = mgObj.name;
      if (NON_STRENGTH_GROUPS.includes(mg)) continue;
      const series = strengthExercises
        .filter((ex) => ex.muscleGroups.includes(mg))
        .map((ex) => normalizedExerciseSeries(sessions, ex.id))
        .filter((s) => s.length > 0);
      byMuscle[mg] = series.length > 0 ? mergeSeriesAverage(series) : null;
    }
    return { overallSeries, byMuscle };
  }

  // -----------------------------------------------------------------------
  // Photos — compressed client-side before storage so IndexedDB stays small.
  // A 480px-wide JPEG at 0.75 quality is typically 20-80KB, so even a full
  // library of 50+ exercise photos stays in the low single-digit MBs.
  // -----------------------------------------------------------------------
  function compressImage(file, maxDim, quality) {
    maxDim = maxDim || 480; quality = quality || 0.75;
    return new Promise((resolve, reject) => {
      const img = new Image();
      const url = URL.createObjectURL(file);
      img.onload = () => {
        let { width, height } = img;
        if (width > height && width > maxDim) { height = Math.round(height * (maxDim / width)); width = maxDim; }
        else if (height > maxDim) { width = Math.round(width * (maxDim / height)); height = maxDim; }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        canvas.getContext("2d").drawImage(img, 0, 0, width, height);
        canvas.toBlob((blob) => {
          URL.revokeObjectURL(url);
          if (blob) resolve(blob); else reject(new Error("compression failed"));
        }, "image/jpeg", quality);
      };
      img.onerror = () => { URL.revokeObjectURL(url); reject(new Error("could not read image")); };
      img.src = url;
    });
  }

  // -----------------------------------------------------------------------
  // Tiny render / router utilities
  // -----------------------------------------------------------------------
  const appEl = document.getElementById("app");
  const toastEl = document.getElementById("toast");
  let toastTimer = null;

  function toast(msg, isPR) {
    toastEl.textContent = msg;
    toastEl.className = "toast show" + (isPR ? " pr" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (toastEl.className = "toast"), 2200);
    if (isPR) vibrate([40, 60, 40]);
  }

  function vibrate(pattern) {
    if (navigator.vibrate) { try { navigator.vibrate(pattern); } catch (e) { /* no-op */ } }
  }

  // ---------------------------------------------------------------------
  // Rest timer — lives outside the render cycle in its own fixed pill so
  // it survives re-renders and keeps counting on any tab. Tap to cancel.
  // ---------------------------------------------------------------------
  const restEl = document.getElementById("rest-timer");
  let restTimer = null; // { endsAt, total, interval }

  function startRest(seconds) {
    stopRest(true);
    restTimer = { endsAt: Date.now() + seconds * 1000, total: seconds, interval: setInterval(tickRest, 250) };
    restEl.classList.add("show");
    tickRest();
  }

  function tickRest() {
    if (!restTimer) return;
    const left = Math.max(0, Math.ceil((restTimer.endsAt - Date.now()) / 1000));
    if (left <= 0) {
      stopRest(true);
      toast("Rest over — next set!");
      vibrate([80, 80, 80]);
      return;
    }
    const m = Math.floor(left / 60), s = left % 60;
    const pct = Math.round((1 - left / restTimer.total) * 100);
    restEl.innerHTML = `<span class="rt-bar" style="width:${pct}%"></span><span class="rt-text">Rest · ${m}:${String(s).padStart(2, "0")} <span class="rt-cancel">✕</span></span>`;
  }

  function stopRest(silent) {
    if (restTimer) clearInterval(restTimer.interval);
    restTimer = null;
    restEl.classList.remove("show");
    if (!silent) toast("Rest timer cancelled");
  }

  restEl.addEventListener("click", () => stopRest());

  // Live "NN min" elapsed pill while a session is active (updates in place,
  // no full re-render needed)
  setInterval(() => {
    const el = document.getElementById("session-elapsed");
    if (el && state.activeSession) el.textContent = sessionElapsedText();
  }, 15000);

  function icon(name) {
    const icons = {
      home: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9.5 12 3l9 6.5V21a1 1 0 0 1-1 1h-5v-7H9v7H4a1 1 0 0 1-1-1Z"/></svg>',
      train: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M6.5 6.5v11M17.5 6.5v11M2 10v4M22 10v4M6.5 12h11"/></svg>',
      chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19V9M12 19V5M20 19v-7"/></svg>',
      drop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11Z"/></svg>',
      gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
      plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M12 5v14M5 12h14"/></svg>',
      back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
      camera: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 8h3l2-2h6l2 2h3v11a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V8Z"/><circle cx="12" cy="14" r="3.2"/></svg>',
      scale: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M12 8.5v3.2l2.6 1.8"/></svg>'
    };
    return icons[name] || "";
  }

  // Selectable time windows for the Weight tab chart. Shortest is 1 week —
  // the smallest granularity that still shows a meaningful trend.
  const WEIGHT_RANGES = [
    { key: "1w", label: "1W", days: 7 },
    { key: "2w", label: "2W", days: 14 },
    { key: "1m", label: "1M", days: 30 },
    { key: "3m", label: "3M", days: 90 },
    { key: "6m", label: "6M", days: 180 },
    { key: "1y", label: "1Y", days: 365 },
    { key: "all", label: "All", days: Infinity }
  ];

  const routes = ["home", "train", "progress", "protein", "weight", "settings"];
  let state = {
    route: "home",
    exercises: [],
    sessions: [],
    protein: [],
    proteinGoal: 150,
    bodyweight: [],
    muscleGroups: [],
    weightRange: "2w",   // defaults to 2 weeks, per WEIGHT_RANGES above
    photoUrls: {},       // exerciseId -> object URL for its photo (if any)
    activeSession: null,  // in-memory in-progress workout
    progressDetail: null  // exerciseId being viewed in detail
  };

  function photoThumb(exerciseId, size) {
    size = size || 34;
    const url = state.photoUrls[exerciseId];
    if (!url) return "";
    return `<img src="${url}" alt="" style="width:${size}px;height:${size}px;border-radius:8px;object-fit:cover;flex-shrink:0" />`;
  }

  async function refreshPhotoUrls() {
    for (const key in state.photoUrls) URL.revokeObjectURL(state.photoUrls[key]);
    const photos = await Repo.listPhotos();
    const map = {};
    for (const p of photos) map[p.exerciseId] = URL.createObjectURL(p.blob);
    state.photoUrls = map;
  }

  async function loadAll() {
    const [exercises, sessions, protein, proteinGoal, bodyweight, muscleGroups] = await Promise.all([
      Repo.listExercises(), Repo.listSessions(), Repo.listProtein(), Repo.getSetting("proteinGoal", 150), Repo.listBodyweight(), Repo.listMuscleGroups()
    ]);
    state.exercises = exercises;
    state.sessions = sessions;
    state.protein = protein;
    state.proteinGoal = proteinGoal;
    state.bodyweight = bodyweight;
    state.muscleGroups = muscleGroups;
    await refreshPhotoUrls();
  }

  function navTo(route) {
    state.route = route;
    state.progressDetail = null;
    render();
  }

  // -----------------------------------------------------------------------
  // Views
  // -----------------------------------------------------------------------
  // Last-7-days consistency strip: one dot per day, lit if a session was logged
  function weekDotsHTML() {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      days.push({
        label: d.toLocaleDateString(undefined, { weekday: "narrow" }),
        trained: state.sessions.some((s) => s.date === ds),
        isToday: i === 0
      });
    }
    const count = days.filter((d) => d.trained).length;
    return `
      <div class="week-dots">
        ${days.map((d) => `<div class="wd${d.trained ? " on" : ""}${d.isToday ? " today" : ""}"><span class="dot"></span><span class="wd-label">${d.label}</span></div>`).join("")}
        <span class="small muted" style="margin-left:auto">${count} day${count === 1 ? "" : "s"} this week</span>
      </div>`;
  }

  function sessionDurationPill(s) {
    if (!s.endedAt || !s.startedAt) return "";
    const mins = Math.round((s.endedAt - s.startedAt) / 60000);
    if (mins < 1 || mins > 600) return "";
    return `<span class="pill">${mins} min</span>`;
  }

  const PROTEIN_QUICK_ADDS = [10, 20, 30, 40];
  function proteinQuickChips() {
    return `<div class="chip-row" style="margin-top:8px">${PROTEIN_QUICK_ADDS.map((g) =>
      `<span class="chip" data-quick-protein="${g}">+${g}g</span>`).join("")}</div>`;
  }

  function viewHome() {
    const rotation = computeRotation(state.sessions);
    const todayProtein = state.protein.filter((p) => p.date === todayStr());
    const totalToday = todayProtein.reduce((a, p) => a + p.amount, 0);
    const pct = Math.min(100, Math.round((totalToday / state.proteinGoal) * 100));
    const circumference = 2 * Math.PI * 40;
    const dash = (pct / 100) * circumference;

    const recent = state.sessions.slice(0, 3);

    return `
      <div class="view">
        <div class="card">
          <h2>This week</h2>
          ${weekDotsHTML()}
          <button class="btn primary block" data-nav="train" style="margin-top:10px">Start Workout</button>
        </div>

        <div class="card">
          <h2>Today's protein <span class="link" data-nav="protein">Log →</span></h2>
          <div class="row" style="align-items:center">
            <div class="ring-wrap">
              <svg width="96" height="96" viewBox="0 0 96 96">
                <circle cx="48" cy="48" r="40" stroke="#1c2540" stroke-width="10" fill="none"/>
                <circle cx="48" cy="48" r="40" stroke="${pct >= 100 ? "var(--good)" : "var(--accent)"}" stroke-width="10" fill="none"
                  stroke-dasharray="${dash} ${circumference}" stroke-linecap="round"/>
              </svg>
              <div class="ring-label"><span class="num">${pct}%</span><span class="lbl">of goal</span></div>
            </div>
            <div style="flex:1">
              <div style="font-size:22px;font-weight:800">${totalToday}g <span class="muted" style="font-size:13px;font-weight:600">/ ${state.proteinGoal}g</span></div>
              <div class="row" style="margin-top:10px;gap:6px;justify-content:flex-start">
                <input type="number" inputmode="numeric" id="custom-protein-amount" placeholder="grams" style="width:90px" />
                <button class="btn sm primary" id="add-custom-protein">Add</button>
              </div>
              ${proteinQuickChips()}
            </div>
          </div>
        </div>

        <div class="card">
          ${bodyWeightMini()}
        </div>

        <div class="card">
          <h2>Muscle rotation <span class="link" data-nav="progress">Muscle detail →</span></h2>
          ${rotation.map(rotationItemHTML).join("")}
        </div>

        <div class="card">
          <h2>Recent sessions</h2>
          ${recent.length === 0 ? `<div class="empty">No sessions logged yet.</div>` :
            recent.map((s) => {
              const mgs = Array.from(new Set(s.entries.flatMap((e) => e.muscleGroups || [])));
              return `<div class="row"><div><div style="font-weight:700">${fmtDate(s.date)}</div>
                <div class="small muted">${mgs.join(", ") || "—"}</div></div>
                <span style="display:flex;gap:5px">${sessionDurationPill(s)}<span class="pill">${s.entries.length} ex</span></span></div>`;
            }).join("")}
        </div>
      </div>
    `;
  }

  function fmtDate(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric" });
  }

  function viewRotationFull() {
    const rotation = computeRotation(state.sessions);
    return `
      <div class="view">
        <div class="card">
          <h2>Muscle group rotation</h2>
          <div class="small muted" style="margin-bottom:10px">Ranked by longest time since last trained.</div>
          ${rotation.map(rotationItemHTML).join("")}
        </div>
      </div>
    `;
  }

  function viewTrain() {
    if (!state.activeSession) {
      return `
        <div class="view">
          <div class="card">
            <h2>Start a workout</h2>
            <div class="small muted" style="margin-bottom:12px">Add exercises and log sets as you go. Finish when done.</div>
            <button class="btn primary block" id="start-session">Start New Session</button>
          </div>
        </div>
      `;
    }
    const s = state.activeSession;
    return `
      <div class="view">
        <div class="card">
          <h2>${fmtDate(s.date)}
            <span style="display:flex;gap:5px;align-items:center">
              <span class="pill" id="session-elapsed">${sessionElapsedText()}</span>
              <span class="pill">${s.entries.length} exercise${s.entries.length === 1 ? "" : "s"}</span>
            </span>
          </h2>
          ${s.entries.map((entry, ei) => exerciseBlock(entry, ei)).join("")}
          <button class="btn ghost block" id="add-exercise-btn">+ Add exercise</button>
        </div>
        <div class="card rest-card">
          <h2>Rest timer</h2>
          <div class="btn-row">
            ${[60, 90, 120, 180].map((sec) => `<button class="btn sm" data-rest="${sec}">${sec >= 120 ? (sec / 60) + " min" : sec + "s"}</button>`).join("")}
          </div>
        </div>
        <div id="add-exercise-panel">${addExerciseOpen ? addExercisePanel() : ""}</div>
        <div class="btn-row">
          <button class="btn danger" style="flex:1" id="discard-session">Discard</button>
          <button class="btn primary" style="flex:2" id="finish-session">Finish Session</button>
        </div>
      </div>
    `;
  }

  function sessionElapsedText() {
    if (!state.activeSession) return "";
    const mins = Math.floor((Date.now() - state.activeSession.startedAt) / 60000);
    return mins + " min";
  }

  function exerciseBlock(entry, ei) {
    const v = entry.variation || "";
    const metric = entry.metric || DEFAULT_METRIC;
    const isStrength = metric === "weight_reps";
    const best = isStrength ? bestSetForVariation(state.sessions, entry.exerciseId, v) : null;
    const prev = lastEntryForExercise(state.sessions, entry.exerciseId, v);
    const fields = metricFields(metric);
    return `
      <div class="exercise-block" data-entry="${ei}">
        <div class="ex-title">
          <strong style="display:flex;align-items:center;gap:8px">${photoThumb(entry.exerciseId, 28)}${entry.exerciseName}${v ? `<span class="variation-tag">${v}</span>` : ""}${!isStrength ? `<span class="variation-tag">${METRIC_TYPES[metric].label}</span>` : ""}</strong>
          <button class="btn sm danger" data-remove-exercise="${ei}">Remove</button>
        </div>
        <div class="small muted" style="margin-bottom:8px">${entry.muscleGroups.join(", ")}</div>
        ${prev || best ? `
        <div class="ex-stats">
          ${prev ? `<div class="ex-stat"><span class="ex-stat-label">Last · ${fmtDaysAgo(daysAgo(prev.date))}</span><span class="ex-stat-value">${prev.sets.map((x) => formatSetValue(x, metric)).join(", ")}</span></div>` : ""}
          ${best ? `<div class="ex-stat best"><span class="ex-stat-label">Best</span><span class="ex-stat-value">${best.weight}kg × ${best.reps}</span></div>` : ""}
        </div>` : ""}
        ${entry.sets.map((set, si) => {
          const orm = isStrength ? estOneRM(set.weight, set.reps) : 0;
          const isPR = isStrength && best && orm >= best.orm && set.weight > 0;
          const ghost = prev && prev.sets[si] ? prev.sets[si] : null;
          return `
          <div class="set-row${fields.length === 1 ? " single" : ""}">
            <span class="idx">${si + 1}</span>
            ${fields.map((f) => `<input type="number" inputmode="${f.inputMode}" placeholder="${ghost && ghost[f.key] ? ghost[f.key] : f.placeholder}" value="${set[f.key] || ""}" data-set-field="${ei}:${si}:${f.key}" />`).join("")}
            <button class="del" data-remove-set="${ei}:${si}" aria-label="remove set">×</button>
          </div>
          ${isPR && si === entry.sets.length - 1 ? `<div class="small" style="color:var(--accent);margin:-2px 0 6px">Matches/beats your best</div>` : ""}
        `; }).join("")}
        <button class="btn sm ghost" data-add-set="${ei}">+ Add set</button>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // Exercise picker — a bottom-sheet popup with search + muscle filter.
  // Three modes: pick exercise → (optional) pick variation → or create new.
  // ---------------------------------------------------------------------
  function addExercisePanel() {
    let inner;
    if (trainFormOpen) {
      inner = customExerciseForm();
    } else if (pickingVariationFor) {
      inner = variationChooserContent();
    } else {
      inner = pickerContent();
    }
    return `
      <div class="sheet-wrap">
        <div class="sheet-backdrop" data-close-add></div>
        <div class="sheet">${inner}</div>
      </div>
    `;
  }

  function variationChooserContent() {
    const ex = state.exercises.find((e) => e.id === pickingVariationFor);
    if (!ex) return "";
    return `
      <div class="sheet-title"><h2 style="margin:0">${ex.name}</h2><span class="link" data-close-add>Close</span></div>
      <div class="small muted" style="margin-bottom:12px">Which variation? Each keeps its own last-time and best numbers.</div>
      ${ex.variations.map((vName) => `<div class="pick-row" data-pick-variation="${vName}"><span>${vName}</span><span class="chev">›</span></div>`).join("")}
      <div class="pick-row" data-pick-variation=""><span>Standard <span class="small muted">— no variation</span></span><span class="chev">›</span></div>
    `;
  }

  function exerciseListHTML() {
    const q = pickerSearch.toLowerCase();
    const matches = state.exercises.filter((ex) =>
      ex.name.toLowerCase().includes(q) &&
      (pickerFilter === "All" || ex.muscleGroups.includes(pickerFilter))
    );
    if (matches.length === 0) return `<div class="empty">No exercises match.</div>`;
    const showHeaders = pickerFilter === "All";
    const grouped = {};
    for (const ex of matches) {
      const key = showHeaders ? (ex.muscleGroups[0] || "Other") : "";
      grouped[key] = grouped[key] || [];
      grouped[key].push(ex);
    }
    return Object.keys(grouped).sort().map((mg) => `
      ${mg ? `<div class="small muted" style="margin:10px 2px 6px">${mg}</div>` : ""}
      ${grouped[mg].map((ex) => `
        <div class="pick-row" data-pick-exercise="${ex.id}">
          <span style="display:flex;align-items:center;gap:10px">${photoThumb(ex.id, 32)}
            <span>${ex.name}${ex.variations && ex.variations.length ? `<div class="small muted">${ex.variations.join(" · ")}</div>` : ""}${(ex.metric || DEFAULT_METRIC) !== "weight_reps" ? `<div class="small muted">${METRIC_TYPES[ex.metric].label}</div>` : ""}</span>
          </span>
          <span style="display:flex;align-items:center;gap:8px"><span class="small muted">${ex.muscleGroups.join(", ")}</span><span class="chev">›</span></span>
        </div>
      `).join("")}
    `).join("");
  }

  function pickerContent() {
    if (state.exercises.length === 0) {
      return `
        <div class="sheet-title"><h2 style="margin:0">Add exercise</h2><span class="link" data-close-add>Close</span></div>
        <div class="empty">Your exercise library is empty — create your first exercise right here.</div>
        <button class="btn primary block" id="train-new-exercise-btn">+ New exercise</button>
      `;
    }
    const groups = state.muscleGroups.map((mg) => mg.name).filter((mg) => state.exercises.some((ex) => ex.muscleGroups.includes(mg)));
    return `
      <div class="sheet-title"><h2 style="margin:0">Add exercise</h2><span class="link" data-close-add>Close</span></div>
      <div class="field" style="margin-top:10px">
        <input type="text" id="exercise-search" placeholder="Search exercises…" value="${pickerSearch.replace(/"/g, "&quot;")}" />
      </div>
      <div class="chip-row" style="margin-bottom:10px">
        <span class="chip${pickerFilter === "All" ? " selected" : ""}" data-picker-filter="All">All</span>
        ${groups.map((g) => `<span class="chip${pickerFilter === g ? " selected" : ""}" data-picker-filter="${g}">${g}</span>`).join("")}
      </div>
      <div id="exercise-list" class="sheet-scroll">${exerciseListHTML()}</div>
      <button class="btn ghost block" id="train-new-exercise-btn" style="margin-top:10px;flex-shrink:0">+ New exercise</button>
    `;
  }

  function viewProgress() {
    if (state.progressDetail) return viewProgressDetail(state.progressDetail);
    const best = bestSetsByExercise(state.sessions);
    const used = state.exercises.filter((ex) => best[ex.id]);
    const prs = recentPRs(state.sessions).slice(0, 5);

    // This week snapshot
    const now = new Date();
    const weekAgo = new Date(now); weekAgo.setDate(weekAgo.getDate() - 6);
    const weekAgoStr = weekAgo.toISOString().slice(0, 10);
    const thisWeekSessions = state.sessions.filter((s) => s.date >= weekAgoStr);
    const setsThisWeek = thisWeekSessions.reduce((a, s) => a + s.entries.reduce((b, e) => b + e.sets.length, 0), 0);
    const musclesThisWeek = new Set(thisWeekSessions.flatMap((s) => s.entries.flatMap((e) => e.muscleGroups || []))).size;

    return `
      <div class="view">
        <div class="card">
          <h2>This week</h2>
          <div class="grid-3">
            <div><div style="font-size:20px;font-weight:800">${thisWeekSessions.length}</div><div class="small muted">workouts</div></div>
            <div><div style="font-size:20px;font-weight:800">${setsThisWeek}</div><div class="small muted">sets logged</div></div>
            <div><div style="font-size:20px;font-weight:800">${musclesThisWeek}</div><div class="small muted">muscle groups</div></div>
          </div>
        </div>

        <div class="card">
          ${strengthIndexCard()}
        </div>

        <div class="card">
          <h2>Protein <span class="link" data-nav="protein">Log →</span></h2>
          ${proteinBarsHTML(computeProteinWeek())}
        </div>

        <div class="card">
          <h2>Muscle rotation</h2>
          ${viewRotationFullInner()}
        </div>

        <div class="card">
          <h2>Personal records</h2>
          ${prs.length === 0 ? `<div class="empty">No PRs yet — log a session to start tracking.</div>` :
            prs.map((pr) => `
              <div class="row list-tap" data-view-exercise="${pr.exerciseId}">
                <span style="display:flex;align-items:center;gap:8px">${photoThumb(pr.exerciseId)}<span>${pr.exerciseName}<div class="small muted">${fmtDate(pr.date)}</div></span></span>
                <span class="pill good">${pr.weight}kg × ${pr.reps}</span>
              </div>
            `).join("")}
        </div>

        <div class="card">
          <h2>Lift progress</h2>
          ${used.length === 0 ? `<div class="empty">Log a session to start tracking lifts.</div>` :
            used.sort((a, b) => a.name.localeCompare(b.name)).map((ex) => `
              <div class="row list-tap" data-view-exercise="${ex.id}">
                <span style="display:flex;align-items:center;gap:8px">${photoThumb(ex.id)}${ex.name}</span>
                <span class="pill good">${best[ex.id].weight}kg × ${best[ex.id].reps}</span>
              </div>
            `).join("")}
        </div>
      </div>
    `;
  }

  function viewRotationFullInner() {
    const rotation = computeRotation(state.sessions);
    return rotation.map(rotationItemHTML).join("");
  }

  function viewProgressDetail(exId) {
    const ex = state.exercises.find((e) => e.id === exId);
    if (!ex) { state.progressDetail = null; return viewProgress(); }
    const metric = ex.metric || DEFAULT_METRIC;
    const photoUrl = state.photoUrls[exId];
    const photoHTML = photoUrl ? `<img src="${photoUrl}" alt="${ex.name}" style="width:100%;max-height:180px;object-fit:cover;border-radius:12px;margin:8px 0" />` : "";

    if (metric !== "weight_reps") {
      // Non-strength metrics just log their raw numbers — no Best/PR/1RM (see METRIC_TYPES note above).
      const field = metricFields(metric)[0];
      const history = genericSetHistory(state.sessions, exId);
      return `
        <div class="view">
          <button class="btn sm ghost" data-back-progress style="align-self:flex-start">${icon("back")} Back</button>
          <div class="card">
            <div class="row" style="align-items:center;margin-bottom:4px"><h2 style="margin:0">${ex.name}</h2></div>
            ${photoHTML}
            <div class="small muted" style="margin-bottom:10px">${ex.muscleGroups.join(", ")} · ${METRIC_TYPES[metric].label}</div>
            ${history.length > 1 ? `<div class="small muted" style="margin-bottom:2px">${field.unit} trend</div>${sparkline(history.map((h) => Number(h.set[field.key]) || 0))}` : ""}
            ${history.length === 0 ? `<div class="empty">No sets logged for this exercise yet.</div>` :
              `<div style="margin-top:10px">${history.slice().reverse().map((h) => `
                <div class="row"><span class="small">${fmtDate(h.date)}</span><span class="small">${formatSetValue(h.set, metric)}</span></div>
              `).join("")}</div>`}
          </div>
        </div>
      `;
    }

    const history = exerciseHistory(state.sessions, exId); // one best-set-per-session entries, chronological
    const best = history.reduce((m, h) => (!m || h.orm > m.orm ? h : m), null);
    const first = history[0];
    const delta = first && best && first.orm > 0 ? Math.round(((best.orm - first.orm) / first.orm) * 100) : null;

    return `
      <div class="view">
        <button class="btn sm ghost" data-back-progress style="align-self:flex-start">${icon("back")} Back</button>
        <div class="card">
          <div class="row" style="align-items:center;margin-bottom:4px">
            <h2 style="margin:0">${ex.name}</h2>
          </div>
          ${photoHTML}
          <div class="small muted" style="margin-bottom:10px">${ex.muscleGroups.join(", ")}</div>
          <div class="btn-row" style="margin-bottom:12px">
            ${best ? `<span class="pill good">Best: ${best.weight}kg × ${best.reps} (${fmtDate(best.date)})</span>` : ""}
            ${delta !== null ? `<span class="pill ${delta >= 0 ? "good" : "bad"}">${delta >= 0 ? "+" : ""}${delta}% since first log</span>` : ""}
          </div>
          ${history.length > 1 ? `<div class="small muted" style="margin-bottom:2px">Estimated 1RM trend</div>${sparkline(history.map((h) => h.orm))}` : ""}
          ${history.length > 1 ? `<div class="small muted" style="margin:10px 0 2px">Session volume (weight × reps)</div>${sparkline(history.map((h) => h.volume))}` : ""}
          ${history.length === 0 ? `<div class="empty">No sets logged for this exercise yet.</div>` :
            `<div style="margin-top:10px">${history.slice().reverse().map((h) => `
              <div class="row"><span class="small">${fmtDate(h.date)}</span><span class="small">${h.weight}kg × ${h.reps} <span class="muted">(~${Math.round(h.orm)}kg 1RM)</span></span></div>
            `).join("")}</div>`}
        </div>
      </div>
    `;
  }

  function sparkline(values) {
    const w = 300, h = 44, pad = 4;
    const max = Math.max(...values), min = Math.min(...values);
    const range = max - min || 1;
    const pts = values.map((v, i) => {
      const x = pad + (i / (values.length - 1)) * (w - pad * 2);
      const y = h - pad - ((v - min) / range) * (h - pad * 2);
      return `${x},${y}`;
    });
    return `<svg class="sparkline" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none">
      <polyline points="${pts.join(" ")}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
    </svg>`;
  }

  // Bigger line chart with axis labels — used for body weight and Strength Index trends
  function trendChart(points, formatValue, color) {
    const w = 300, h = 100, padX = 8, padY = 16;
    color = color || "var(--accent)";
    const values = points.map((p) => p.value);
    const max = Math.max(...values), min = Math.min(...values);
    const range = max - min || 1;
    const pts = values.map((v, i) => {
      const x = padX + (i / (values.length - 1)) * (w - padX * 2);
      const y = padY + (1 - (v - min) / range) * (h - padY * 2);
      return { x, y };
    });
    const line = pts.map((p) => `${p.x},${p.y}`).join(" ");
    const dots = pts.map((p) => `<circle cx="${p.x}" cy="${p.y}" r="2.5" fill="${color}" />`).join("");
    return `
      <div class="small muted" style="text-align:right;margin-bottom:2px">${formatValue(max)}</div>
      <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;display:block">
        <polyline points="${line}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        ${dots}
      </svg>
      <div class="row small muted" style="margin-top:2px">
        <span>${formatValue(min)} · ${fmtDate(points[0].date)}</span>
        <span>${fmtDate(points[points.length - 1].date)}</span>
      </div>
    `;
  }

  // Compact version for Home — quick log only, no chart (the chart lives on the Weight tab)
  function bodyWeightMini() {
    const history = state.bodyweight;
    const todayEntry = history.find((e) => e.date === todayStr());
    const latest = history[history.length - 1];
    return `
      <h2>Body weight <span class="link" data-nav="weight">Trend →</span></h2>
      <div class="row" style="align-items:center">
        <div style="font-size:22px;font-weight:800">${latest ? latest.weight + "kg" : "—"}</div>
        <div style="display:flex;gap:6px;align-items:center">
          <input type="number" inputmode="decimal" step="0.1" id="bodyweight-input" placeholder="kg" value="${todayEntry ? todayEntry.weight : ""}" style="width:80px" />
          <button class="btn primary sm" id="save-bodyweight">${todayEntry ? "Update" : "Log"}</button>
        </div>
      </div>
    `;
  }

  function fmtShortDate(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString(undefined, { day: "numeric", month: "short" });
  }

  // Entries within the selected WEIGHT_RANGES window (history must be date-ascending)
  function filterBodyweightRange(history, rangeKey) {
    const opt = WEIGHT_RANGES.find((r) => r.key === rangeKey) || WEIGHT_RANGES[1];
    if (opt.days === Infinity) return history.slice();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (opt.days - 1));
    const cutoffStr = cutoff.toISOString().slice(0, 10);
    return history.filter((e) => e.date >= cutoffStr);
  }

  function rangeSelectorHTML(selected) {
    return `<div class="range-tabs">${WEIGHT_RANGES.map((r) =>
      `<button class="${r.key === selected ? "active" : ""}" data-weight-range="${r.key}">${r.label}</button>`
    ).join("")}</div>`;
  }

  // Stock-app-style area chart: gradient fill under the line, gridlines with
  // value labels, a marker on the latest point, and a few date labels along
  // the bottom rather than one per data point.
  function weightAreaChart(points) {
    const w = 320, h = 170, padX = 6, padTop = 16, padBottom = 22;
    const values = points.map((p) => p.weight);
    const rawMin = Math.min(...values), rawMax = Math.max(...values);
    const span = rawMax - rawMin || 1;
    const pad = span * 0.2 || 1;
    const min = rawMin - pad, max = rawMax + pad;
    const range = max - min || 1;

    const xAt = (i) => padX + (points.length === 1 ? (w - padX * 2) / 2 : (i / (points.length - 1)) * (w - padX * 2));
    const yAt = (v) => padTop + (1 - (v - min) / range) * (h - padTop - padBottom);

    const linePts = points.map((p, i) => `${xAt(i)},${yAt(p.weight)}`).join(" ");
    const areaPts = `${xAt(0)},${h - padBottom} ${linePts} ${xAt(points.length - 1)},${h - padBottom}`;

    const gridVals = [max - pad * 0.3, (max + min) / 2, min + pad * 0.3];
    const gridLines = gridVals.map((v) => {
      const y = yAt(v);
      return `<line x1="${padX}" y1="${y}" x2="${w - padX}" y2="${y}" stroke="var(--border)" stroke-width="1"/>
        <text x="${padX}" y="${y - 4}" font-size="9" fill="var(--text-dim)">${v.toFixed(1)}</text>`;
    }).join("");

    const labelIdxs = points.length > 2 ? [0, Math.floor((points.length - 1) / 2), points.length - 1] : points.map((_, i) => i);
    const xLabels = labelIdxs.map((i) => {
      const anchor = i === 0 ? "start" : i === points.length - 1 ? "end" : "middle";
      return `<text x="${xAt(i)}" y="${h - 6}" font-size="9.5" fill="var(--text-dim)" text-anchor="${anchor}">${fmtShortDate(points[i].date)}</text>`;
    }).join("");

    const last = points[points.length - 1];

    return `
      <svg viewBox="0 0 ${w} ${h}" style="width:100%;height:${h}px;display:block">
        <defs>
          <linearGradient id="weightGradient" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stop-color="var(--accent)" stop-opacity="0.35"/>
            <stop offset="100%" stop-color="var(--accent)" stop-opacity="0"/>
          </linearGradient>
        </defs>
        ${gridLines}
        <polygon points="${areaPts}" fill="url(#weightGradient)" stroke="none"/>
        <polyline points="${linePts}" fill="none" stroke="var(--accent)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/>
        <circle cx="${xAt(points.length - 1)}" cy="${yAt(last.weight)}" r="3.5" fill="var(--accent)"/>
        ${xLabels}
      </svg>
    `;
  }

  function viewWeight() {
    const fullHistory = state.bodyweight;
    const filtered = filterBodyweightRange(fullHistory, state.weightRange);
    const todayEntry = fullHistory.find((e) => e.date === todayStr());
    const latest = fullHistory[fullHistory.length - 1];
    const rangeFirst = filtered[0];
    const hasTrend = rangeFirst && latest && filtered.length > 1;
    const delta = hasTrend ? Math.round((latest.weight - rangeFirst.weight) * 10) / 10 : null;
    const pct = hasTrend && rangeFirst.weight ? Math.round((delta / rangeFirst.weight) * 1000) / 10 : null;

    return `
      <div class="view">
        <div class="card">
          <h2>Body weight</h2>
          <div class="row" style="align-items:flex-end;margin-bottom:2px">
            <div>
              <div style="font-size:30px;font-weight:800">${latest ? latest.weight + "kg" : "—"}</div>
              ${delta !== null ? `<span class="pill">${delta > 0 ? "+" : ""}${delta}kg${pct !== null ? ` (${pct > 0 ? "+" : ""}${pct}%)` : ""} over selected range</span>` : ""}
            </div>
            <div style="display:flex;gap:6px;align-items:center">
              <input type="number" inputmode="decimal" step="0.1" id="bodyweight-input" placeholder="kg" value="${todayEntry ? todayEntry.weight : ""}" style="width:88px" />
              <button class="btn primary sm" id="save-bodyweight">${todayEntry ? "Update" : "Log"}</button>
            </div>
          </div>
          ${rangeSelectorHTML(state.weightRange)}
          ${filtered.length > 1 ? weightAreaChart(filtered) :
            filtered.length === 1 ? `<div class="empty">Only one weigh-in in this range — widen the range or log again tomorrow.</div>` :
            `<div class="empty">No weigh-ins in this range yet.</div>`}
        </div>

        <div class="card">
          <h2>History</h2>
          ${fullHistory.length === 0 ? `<div class="empty">No weigh-ins yet — log today's above to get started.</div>` :
            fullHistory.slice().reverse().slice(0, 20).map((e) => `
              <div class="row"><span class="small">${fmtDate(e.date)}</span>
                <span class="small">${e.weight}kg <button class="btn sm danger" data-del-bodyweight="${e.date}" style="margin-left:8px">Delete</button></span></div>
            `).join("")}
        </div>
      </div>
    `;
  }

  function strengthIndexCard() {
    const { overallSeries, byMuscle } = computeStrengthIndex(state.sessions, state.exercises);
    const latest = overallSeries.length ? Math.round(overallSeries[overallSeries.length - 1].value) : null;
    const delta = latest !== null ? latest - 100 : null;

    const breakdown = state.muscleGroups.map((mg) => mg.name).filter((mg) => !NON_STRENGTH_GROUPS.includes(mg)).map((mg) => {
      const series = byMuscle[mg];
      const d = series && series.length ? Math.round(series[series.length - 1].value - 100) : null;
      return { mg, delta: d };
    }).sort((a, b) => {
      if (a.delta === null) return 1;
      if (b.delta === null) return -1;
      return b.delta - a.delta;
    });

    return `
      <h2>Strength Index</h2>
      <div class="small muted" style="margin-bottom:10px">A rough "are you moving more weight than when you started" score — averages each lift's growth vs. its own first logged set, so exercises at very different weights can be compared fairly.</div>
      ${latest === null ? `<div class="empty">Log a couple of sessions for the same lifts to start seeing this.</div>` : `
        <div class="row" style="align-items:flex-end;margin-bottom:10px">
          <div>
            <div style="font-size:26px;font-weight:800">${latest}</div>
            <span class="pill ${delta >= 0 ? "good" : "bad"}">${delta >= 0 ? "+" : ""}${delta}% since you started tracking</span>
          </div>
        </div>
        ${overallSeries.length > 1 ? trendChart(overallSeries, (v) => Math.round(v), "#a78bfa") : ""}
      `}
      <div style="margin-top:14px">
        ${breakdown.map((b) => `
          <div class="rotation-item" style="margin-bottom:10px">
            <span class="small" style="width:78px">${b.mg}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${b.delta === null ? 0 : Math.min(100, Math.abs(b.delta) * 2)}%;background:${b.delta === null ? "var(--border)" : b.delta >= 0 ? "var(--good)" : "var(--bad)"}"></div></div>
            <span class="pill ${b.delta === null ? "" : b.delta >= 0 ? "good" : "bad"}">${b.delta === null ? "No data" : (b.delta >= 0 ? "+" : "") + b.delta + "%"}</span>
          </div>
        `).join("")}
      </div>
    `;
  }

  // Shared by the Protein tab and the Progress tab's protein visualization
  function computeProteinWeek() {
    const days = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      const total = state.protein.filter((p) => p.date === ds).reduce((a, p) => a + p.amount, 0);
      days.push({ ds, total, label: d.toLocaleDateString(undefined, { weekday: "narrow" }) });
    }
    const maxBar = Math.max(state.proteinGoal, ...days.map((d) => d.total), 1);

    let streak = 0;
    for (let i = 0; ; i++) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = d.toISOString().slice(0, 10);
      const total = state.protein.filter((p) => p.date === ds).reduce((a, p) => a + p.amount, 0);
      if (total >= state.proteinGoal) streak++;
      else break;
      if (i > 365) break;
    }
    return { days, maxBar, streak };
  }

  function proteinBarsHTML(week) {
    return `
      <div class="bars">
        ${week.days.map((d) => `
          <div class="bar-col">
            <div class="bar ${d.total >= state.proteinGoal ? "hit" : ""}" style="height:${Math.max(4, (d.total / week.maxBar) * 56)}px"></div>
            <div class="bar-day">${d.label}</div>
          </div>
        `).join("")}
      </div>
    `;
  }

  function viewProtein() {
    const todayEntries = state.protein.filter((p) => p.date === todayStr());
    const totalToday = todayEntries.reduce((a, p) => a + p.amount, 0);
    const week = computeProteinWeek();

    return `
      <div class="view">
        <div class="card">
          <h2>Today</h2>
          <div style="font-size:28px;font-weight:800">${totalToday}g <span class="muted" style="font-size:15px;font-weight:600">/ ${state.proteinGoal}g goal</span></div>
          ${week.streak > 0 ? `<div class="pill good" style="margin-top:8px">${week.streak}-day streak</div>` : ""}
          <div class="field" style="margin-top:14px">
            <label>Add protein (g)</label>
            <div class="row">
              <input type="number" inputmode="numeric" id="custom-protein-amount" placeholder="e.g. 35" />
              <button class="btn primary" id="add-custom-protein">Add</button>
            </div>
            ${proteinQuickChips()}
          </div>
        </div>

        <div class="card">
          <h2>Last 7 days</h2>
          ${proteinBarsHTML(week)}
        </div>

        <div class="card">
          <h2>Today's log</h2>
          ${todayEntries.length === 0 ? `<div class="empty">Nothing logged yet today.</div>` :
            todayEntries.map((p) => `
              <div class="row"><span>${p.amount}g${p.note ? ` — ${p.note}` : ""}</span>
                <button class="btn sm danger" data-del-protein="${p.id}">Delete</button></div>
            `).join("")}
        </div>
      </div>
    `;
  }

  function viewSettings() {
    return `
      <div class="view">
        <div class="card">
          <h2>Protein goal</h2>
          <div class="row">
            <input type="number" inputmode="numeric" id="protein-goal-input" value="${state.proteinGoal}" />
            <button class="btn primary" id="save-protein-goal">Save</button>
          </div>
        </div>

        <div class="card">
          <h2>Muscle groups</h2>
          <div class="small muted" style="margin-bottom:8px">Pick which muscle groups you want to track and how many times per week you're aiming to train each. Rotation and the Strength Index are both built from this list.</div>
          ${state.muscleGroups.length === 0 ? `<div class="empty">No muscle groups yet — add your first below.</div>` : `
          <div style="margin-bottom:12px">
            ${state.muscleGroups.map((mg) => `
              <div class="row" style="align-items:center">
                <span style="display:flex;align-items:center;gap:8px"><span style="width:10px;height:10px;border-radius:50%;background:${mg.color};display:inline-block;flex-shrink:0"></span>${mg.name}</span>
                <span style="display:flex;align-items:center;gap:8px">
                  <input type="number" inputmode="numeric" min="1" max="14" value="${mg.frequency}" data-muscle-freq="${mg.id}" style="width:56px" />
                  <span class="small muted">x/wk</span>
                  <button class="btn sm danger" data-del-muscle="${mg.id}">Delete</button>
                </span>
              </div>
            `).join("")}
          </div>`}
          <div class="row" style="gap:6px">
            <input type="text" id="new-muscle-name" placeholder="e.g. Forearms" style="flex:1" />
            <input type="number" inputmode="numeric" id="new-muscle-freq" placeholder="x/wk" value="2" min="1" max="14" style="width:64px" />
            <button class="btn primary sm" id="add-muscle-btn">Add</button>
          </div>
        </div>

        <div class="card">
          <h2>Exercise library</h2>
          <div class="small muted" style="margin-bottom:8px">Your own library — each exercise has muscle groups, optional variations (attachments, grips, one/two-handed) and an optional photo. Variations track their own last-time and best numbers.</div>
          ${state.exercises.length === 0 ? `<div class="empty">No exercises yet — add your first below.</div>` : `
          <div style="max-height:320px;overflow:auto;margin-bottom:12px">
            ${state.exercises.map((ex) => `
              <div class="row">
                <div style="display:flex;align-items:center;gap:10px">
                  ${photoThumb(ex.id, 38)}
                  <div><div>${ex.name}</div><div class="small muted">${ex.muscleGroups.join(", ")}${ex.variations && ex.variations.length ? ` · ${ex.variations.join(" / ")}` : ""}${(ex.metric || DEFAULT_METRIC) !== "weight_reps" ? ` · ${METRIC_TYPES[ex.metric].label}` : ""}</div></div>
                </div>
                <div class="btn-row">
                  <button class="btn sm ghost" data-edit-exercise="${ex.id}">Edit</button>
                  <button class="btn sm danger" data-del-exercise="${ex.id}">Delete</button>
                </div>
              </div>
            `).join("")}
          </div>`}
          <button class="btn ghost block" id="add-custom-exercise-btn">+ Add exercise</button>
          <div id="custom-exercise-form">${customExerciseOpen ? customExerciseForm() : ""}</div>
        </div>

        <div class="card">
          <h2>Data</h2>
          <div class="small muted" style="margin-bottom:10px">Everything — sessions, lifts, protein log, body weight and exercise photos — is stored only on this device. Export a backup regularly, or use export/import to move data to another phone — and later, to a shared setup if friends join in.</div>
          <div class="btn-row">
            <button class="btn" id="export-data">Export backup (.json)</button>
            <button class="btn" id="import-data-btn">Import backup</button>
          </div>
          <input type="file" id="import-file-input" accept="application/json" style="display:none" />
          <button class="btn danger block" style="margin-top:10px" id="clear-all-data">Erase all data</button>
        </div>

        <div class="card">
          <h2>About</h2>
          <div class="small muted">We Go Gym v1.0 · local-only storage on this device (IndexedDB). Install to your home screen for the full-screen app feel — see the README for how.</div>
        </div>
      </div>
    `;
  }

  function customExerciseForm() {
    const editing = editingExerciseId !== null;
    const existingPhoto = editing && !pendingPhotoUrl ? state.photoUrls[editingExerciseId] : null;
    const previewUrl = pendingPhotoUrl || existingPhoto;
    return `
      <div class="card" style="margin-top:10px">
        <h2>${editing ? "Edit exercise" : "New exercise"}${trainFormOpen ? ` <span class="link" data-close-add>Close</span>` : ""}</h2>
        ${trainFormOpen ? `<div class="small muted" style="margin-bottom:8px">Saved to your library and added to this workout.</div>` : ""}
        <div class="field">
          <label>Exercise name</label>
          <input type="text" id="new-exercise-name" placeholder="e.g. Tricep Pushdown" value="${formNameValue.replace(/"/g, "&quot;")}" />
        </div>
        <div class="field">
          <label>Track by</label>
          <div class="chip-row" id="new-exercise-metric">
            ${Object.keys(METRIC_TYPES).map((key) => `<span class="chip${formMetric === key ? " selected" : ""}" data-metric="${key}">${METRIC_TYPES[key].label}</span>`).join("")}
          </div>
        </div>
        <div class="field">
          <label>Muscle group(s)</label>
          ${state.muscleGroups.length === 0 ? `<div class="small muted">No muscle groups yet — add some in Settings first.</div>` : `
          <div class="chip-row" id="new-exercise-muscles">
            ${state.muscleGroups.map((mg) => `<span class="chip${selectedMuscles.includes(mg.name) ? " selected" : ""}" data-muscle="${mg.name}">${mg.name}</span>`).join("")}
          </div>`}
        </div>
        <div class="field">
          <label>Variations (optional) — attachments, grips, one/two-handed…</label>
          ${formVariations.length ? `<div class="chip-row" style="margin-bottom:6px">
            ${formVariations.map((vName, i) => `<span class="chip selected" data-remove-variation="${i}">${vName} ✕</span>`).join("")}
          </div>` : ""}
          <div class="row" style="gap:6px">
            <input type="text" id="new-variation-input" placeholder="e.g. Straight bar, Rope, One-handed" />
            <button class="btn sm" id="add-variation-btn">Add</button>
          </div>
        </div>
        <div class="field">
          <label>Photo (optional)</label>
          <div class="row" style="justify-content:flex-start;gap:10px">
            ${previewUrl ? `<img src="${previewUrl}" alt="" style="width:52px;height:52px;border-radius:10px;object-fit:cover" />` : ""}
            <label class="btn sm ghost" style="margin:0">${icon("camera")} ${previewUrl ? "Change photo" : "Add photo"}<input type="file" accept="image/*" capture="environment" id="new-exercise-photo" style="display:none" /></label>
          </div>
        </div>
        <button class="btn primary block" id="save-new-exercise">${editing ? "Save changes" : "Add exercise"}</button>
      </div>
    `;
  }

  // -----------------------------------------------------------------------
  // Root render
  // -----------------------------------------------------------------------
  const titles = { home: "We Go Gym", train: "Log Workout", progress: "Progress", protein: "Protein", weight: "Body Weight", settings: "Settings" };

  function render() {
    let body;
    if (state.route === "home") body = viewHome();
    else if (state.route === "train") body = viewTrain();
    else if (state.route === "progress") body = viewProgress();
    else if (state.route === "protein") body = viewProtein();
    else if (state.route === "weight") body = viewWeight();
    else body = viewSettings();

    appEl.innerHTML = `
      <div class="header">
        <h1>${titles[state.route]}</h1>
        <div class="sub">${state.route === "home" ? greeting() + " · " : ""}${new Date().toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" })}</div>
      </div>
      ${body}
      <nav class="nav">
        <button class="${state.route === "home" ? "active" : ""}" data-nav="home">${icon("home")}Home</button>
        <button class="${state.route === "train" ? "active" : ""}" data-nav="train">${icon("train")}Train</button>
        <button class="${state.route === "progress" ? "active" : ""}" data-nav="progress">${icon("chart")}Progress</button>
        <button class="${state.route === "protein" ? "active" : ""}" data-nav="protein">${icon("drop")}Protein</button>
        <button class="${state.route === "weight" ? "active" : ""}" data-nav="weight">${icon("scale")}Weight</button>
        <button class="${state.route === "settings" ? "active" : ""}" data-nav="settings">${icon("gear")}Settings</button>
      </nav>
    `;
  }

  // -----------------------------------------------------------------------
  // Event delegation (single listener, keeps re-renders simple)
  // -----------------------------------------------------------------------
  let selectedMuscles = [];
  let addExerciseOpen = false;
  let customExerciseOpen = false;
  let pickingVariationFor = null;   // exercise id waiting on a variation choice (Train)
  let trainFormOpen = false;        // "new exercise" form open inside the Train add panel
  let pickerSearch = "";            // search text in the exercise picker sheet
  let pickerFilter = "All";         // muscle-group filter in the exercise picker sheet
  let editingExerciseId = null;     // exercise being edited in Settings (null = adding new)
  let formNameValue = "";           // preserved across form re-renders
  let formVariations = [];          // variations list being built in the form
  let formMetric = DEFAULT_METRIC;  // metric type being built in the form
  let pendingPhotoFile = null;      // photo picked in the form, saved on submit
  let pendingPhotoUrl = null;       // object URL for previewing pendingPhotoFile

  function resetExerciseForm() {
    selectedMuscles = [];
    formVariations = [];
    formNameValue = "";
    formMetric = DEFAULT_METRIC;
    editingExerciseId = null;
    pendingPhotoFile = null;
    if (pendingPhotoUrl) { URL.revokeObjectURL(pendingPhotoUrl); pendingPhotoUrl = null; }
  }

  // Inputs live inside the re-rendered form, so capture the name before any
  // re-render that would wipe it.
  function captureFormName() {
    const el = document.getElementById("new-exercise-name");
    if (el) formNameValue = el.value;
  }

  // The exercise form can live in Settings or inside the Train add panel —
  // re-render whichever holder is active.
  function renderExerciseForm() {
    if (trainFormOpen) renderAddPanel();
    else renderSettingsExtra();
  }

  appEl.addEventListener("click", async (e) => {
    const t = e.target;

    const navBtn = t.closest("[data-nav]");
    if (navBtn) { navTo(navBtn.dataset.nav); return; }

    if (t.closest("[data-back-progress]")) { state.progressDetail = null; render(); return; }
    if (t.closest("[data-view-exercise]")) { state.progressDetail = t.closest("[data-view-exercise]").dataset.viewExercise; render(); return; }

    const rangeBtn = t.closest("[data-weight-range]");
    if (rangeBtn) { state.weightRange = rangeBtn.dataset.weightRange; render(); return; }

    const quickP = t.closest("[data-quick-protein]");
    if (quickP) {
      const g = Number(quickP.dataset.quickProtein);
      await Repo.addProtein(g);
      state.protein = await Repo.listProtein();
      render();
      toast("Logged " + g + "g protein");
      return;
    }

    const restBtn = t.closest("[data-rest]");
    if (restBtn) { startRest(Number(restBtn.dataset.rest)); return; }

    if (t.id === "add-custom-protein") {
      const input = document.getElementById("custom-protein-amount");
      const val = Number(input.value);
      if (val > 0) {
        await Repo.addProtein(val);
        state.protein = await Repo.listProtein();
        render();
        toast("Logged " + val + "g protein");
      }
      return;
    }
    const delP = t.closest("[data-del-protein]");
    if (delP) {
      await Repo.deleteProtein(delP.dataset.delProtein);
      state.protein = await Repo.listProtein();
      render();
      return;
    }

    // Body weight
    if (t.id === "save-bodyweight") {
      const val = Number(document.getElementById("bodyweight-input").value);
      if (val > 0) {
        await Repo.setBodyweight(todayStr(), val);
        state.bodyweight = await Repo.listBodyweight();
        render();
        toast("Weight logged");
      }
      return;
    }
    const delBw = t.closest("[data-del-bodyweight]");
    if (delBw) {
      await Repo.deleteBodyweight(delBw.dataset.delBodyweight);
      state.bodyweight = await Repo.listBodyweight();
      render();
      return;
    }

    // Train / session
    if (t.id === "start-session") {
      state.activeSession = { id: uid(), date: todayStr(), startedAt: Date.now(), entries: [] };
      render();
      return;
    }
    if (t.id === "discard-session") {
      if (confirm("Discard this workout? Nothing will be saved.")) {
        state.activeSession = null;
        addExerciseOpen = false;
        stopRest(true);
        render();
      }
      return;
    }
    if (t.id === "finish-session") {
      if (state.activeSession.entries.length === 0) { toast("Add at least one exercise first"); return; }
      // clean empty sets
      state.activeSession.entries.forEach((entry) => {
        entry.sets = entry.sets.filter((s) => Object.values(s).some((v) => v));
      });
      state.activeSession.endedAt = Date.now();
      stopRest(true);
      const bestBefore = bestSetsByExercise(state.sessions);
      await Repo.saveSession(state.activeSession);
      state.sessions = await Repo.listSessions();
      const bestAfter = bestSetsByExercise(state.sessions);
      let prCount = 0;
      for (const key in bestAfter) {
        if (!bestBefore[key] || bestAfter[key].orm > bestBefore[key].orm) prCount++;
      }
      state.activeSession = null;
      addExerciseOpen = false;
      render();
      toast(prCount > 0 ? `Session saved — ${prCount} new PR${prCount > 1 ? "s" : ""}!` : "Session saved", prCount > 0);
      return;
    }
    if (t.id === "add-exercise-btn") {
      addExerciseOpen = true;
      pickingVariationFor = null;
      trainFormOpen = false;
      pickerSearch = "";
      pickerFilter = "All";
      renderAddPanel();
      const search = document.getElementById("exercise-search");
      if (search) search.focus();
      return;
    }
    const filterChip = t.closest("[data-picker-filter]");
    if (filterChip) {
      const search = document.getElementById("exercise-search");
      if (search) pickerSearch = search.value;
      pickerFilter = filterChip.dataset.pickerFilter;
      renderAddPanel();
      return;
    }
    if (t.id === "train-new-exercise-btn") { trainFormOpen = true; resetExerciseForm(); renderAddPanel(); return; }
    if (t.closest("[data-close-add]")) {
      if (trainFormOpen) { trainFormOpen = false; resetExerciseForm(); }
      else { addExerciseOpen = false; pickingVariationFor = null; }
      renderAddPanel();
      return;
    }
    const pick = t.closest("[data-pick-exercise]");
    if (pick) {
      const ex = state.exercises.find((e) => e.id === pick.dataset.pickExercise);
      if (ex.variations && ex.variations.length > 0) {
        // Two-step: choose a variation (or "Standard") before adding
        pickingVariationFor = ex.id;
        renderAddPanel();
        return;
      }
      addEntryToSession(ex, "");
      return;
    }
    const pickVar = t.closest("[data-pick-variation]");
    if (pickVar) {
      const ex = state.exercises.find((e) => e.id === pickingVariationFor);
      if (ex) addEntryToSession(ex, pickVar.dataset.pickVariation);
      return;
    }
    const remEx = t.closest("[data-remove-exercise]");
    if (remEx) {
      state.activeSession.entries.splice(Number(remEx.dataset.removeExercise), 1);
      render();
      return;
    }
    const addSet = t.closest("[data-add-set]");
    if (addSet) {
      // Duplicate the previous set's values — most sets repeat, so this
      // saves typing; just edit if the numbers change.
      const entry = state.activeSession.entries[Number(addSet.dataset.addSet)];
      const metric = entry.metric || DEFAULT_METRIC;
      const last = entry.sets[entry.sets.length - 1];
      const copy = emptySet(metric);
      if (last) metricFields(metric).forEach((f) => { copy[f.key] = last[f.key] || ""; });
      entry.sets.push(copy);
      render();
      return;
    }
    const remSet = t.closest("[data-remove-set]");
    if (remSet) {
      const [ei, si] = remSet.dataset.removeSet.split(":").map(Number);
      const entry = state.activeSession.entries[ei];
      entry.sets.splice(si, 1);
      if (entry.sets.length === 0) entry.sets.push(emptySet(entry.metric || DEFAULT_METRIC));
      render();
      return;
    }

    // Settings: muscle groups
    if (t.id === "add-muscle-btn") {
      const nameInput = document.getElementById("new-muscle-name");
      const freqInput = document.getElementById("new-muscle-freq");
      const name = nameInput.value.trim();
      const frequency = Math.max(1, Number(freqInput.value) || DEFAULT_FREQUENCY);
      if (!name) { toast("Enter a muscle group name"); return; }
      if (state.muscleGroups.some((mg) => mg.name.toLowerCase() === name.toLowerCase())) { toast("Already in your list"); return; }
      await Repo.addMuscleGroup(name, frequency);
      state.muscleGroups = await Repo.listMuscleGroups();
      render();
      toast("Muscle group added");
      return;
    }
    const delMuscle = t.closest("[data-del-muscle]");
    if (delMuscle) {
      const mg = state.muscleGroups.find((m) => m.id === delMuscle.dataset.delMuscle);
      if (mg && confirm(`Delete "${mg.name}"? Exercises already tagged with it keep the tag, but it won't be offered for new ones.`)) {
        await Repo.deleteMuscleGroup(mg.id);
        state.muscleGroups = await Repo.listMuscleGroups();
        render();
      }
      return;
    }

    // Settings: exercises
    if (t.id === "add-custom-exercise-btn") {
      customExerciseOpen = !customExerciseOpen;
      resetExerciseForm();
      renderSettingsExtra();
      return;
    }
    const editEx = t.closest("[data-edit-exercise]");
    if (editEx) {
      const ex = state.exercises.find((x) => x.id === editEx.dataset.editExercise);
      if (ex) {
        resetExerciseForm();
        editingExerciseId = ex.id;
        formNameValue = ex.name;
        selectedMuscles = ex.muscleGroups.slice();
        formVariations = (ex.variations || []).slice();
        formMetric = ex.metric || DEFAULT_METRIC;
        customExerciseOpen = true;
        renderSettingsExtra();
        document.getElementById("custom-exercise-form").scrollIntoView({ behavior: "smooth", block: "start" });
      }
      return;
    }
    if (t.id === "add-variation-btn") {
      const input = document.getElementById("new-variation-input");
      const vName = input.value.trim();
      if (!vName) return;
      if (formVariations.some((x) => x.toLowerCase() === vName.toLowerCase())) { toast("Variation already added"); return; }
      captureFormName();
      formVariations.push(vName);
      renderExerciseForm();
      document.getElementById("new-variation-input").focus();
      return;
    }
    const remVar = t.closest("[data-remove-variation]");
    if (remVar) {
      captureFormName();
      formVariations.splice(Number(remVar.dataset.removeVariation), 1);
      renderExerciseForm();
      return;
    }
    const muscleChip = t.closest("[data-muscle]");
    if (muscleChip && document.getElementById("new-exercise-muscles")) {
      const mg = muscleChip.dataset.muscle;
      if (selectedMuscles.includes(mg)) selectedMuscles = selectedMuscles.filter((m) => m !== mg);
      else selectedMuscles.push(mg);
      muscleChip.classList.toggle("selected");
      return;
    }
    const metricChip = t.closest("[data-metric]");
    if (metricChip && document.getElementById("new-exercise-metric")) {
      formMetric = metricChip.dataset.metric;
      metricChip.parentElement.querySelectorAll(".chip").forEach((c) => c.classList.toggle("selected", c.dataset.metric === formMetric));
      return;
    }
    if (t.id === "save-new-exercise") {
      const name = document.getElementById("new-exercise-name").value.trim();
      if (!name) { toast("Enter an exercise name"); return; }
      if (selectedMuscles.length === 0) { toast("Pick at least one muscle group"); return; }
      let exerciseId;
      if (editingExerciseId) {
        const existing = state.exercises.find((x) => x.id === editingExerciseId);
        await Repo.updateExercise(Object.assign({}, existing, {
          name, muscleGroups: selectedMuscles.slice(), variations: formVariations.slice(), metric: formMetric
        }));
        exerciseId = editingExerciseId;
      } else {
        exerciseId = await Repo.addExercise(name, selectedMuscles.slice(), formVariations.slice(), formMetric);
      }
      if (pendingPhotoFile) {
        try {
          const blob = await compressImage(pendingPhotoFile);
          await Repo.setPhoto(exerciseId, blob);
        } catch (err) { toast("Couldn't process that photo"); }
      }
      state.exercises = await Repo.listExercises();
      await refreshPhotoUrls();
      const wasEditing = editingExerciseId !== null;
      const fromTrain = trainFormOpen;
      trainFormOpen = false;
      customExerciseOpen = false;
      resetExerciseForm();
      if (fromTrain && state.activeSession) {
        const newEx = state.exercises.find((x) => x.id === exerciseId);
        if (newEx && newEx.variations && newEx.variations.length > 0) {
          // Let them pick which variation they're doing right now
          pickingVariationFor = newEx.id;
          render();
        } else if (newEx) {
          addEntryToSession(newEx, "");
        }
        toast("Added to library + workout");
        return;
      }
      render();
      toast(wasEditing ? "Exercise updated" : "Exercise added");
      return;
    }
    const delEx = t.closest("[data-del-exercise]");
    if (delEx) {
      if (confirm("Delete this exercise? Past sessions keep their logged history.")) {
        await Repo.deleteExercise(delEx.dataset.delExercise);
        await Repo.deletePhoto(delEx.dataset.delExercise);
        state.exercises = await Repo.listExercises();
        await refreshPhotoUrls();
        render();
      }
      return;
    }
    const delPhoto = t.closest("[data-del-photo]");
    if (delPhoto) {
      await Repo.deletePhoto(delPhoto.dataset.delPhoto);
      await refreshPhotoUrls();
      render();
      return;
    }

    if (t.id === "save-protein-goal") {
      const val = Number(document.getElementById("protein-goal-input").value);
      if (val > 0) {
        await Repo.setSetting("proteinGoal", val);
        state.proteinGoal = val;
        toast("Goal updated");
        render();
      }
      return;
    }

    if (t.id === "export-data") {
      const data = await Repo.exportAll();
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `we-go-gym-backup-${todayStr()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      return;
    }
    if (t.id === "import-data-btn") { document.getElementById("import-file-input").click(); return; }
    if (t.id === "clear-all-data") {
      if (confirm("This erases ALL local data (sessions, protein log, custom exercises). This cannot be undone. Continue?")) {
        await Repo.clearAll();
        await loadAll();
        render();
        toast("All data cleared");
      }
      return;
    }
  });

  // input listeners (change, not click) — set weight/reps and file import
  appEl.addEventListener("change", async (e) => {
    const t = e.target;
    const freqInput = t.closest("[data-muscle-freq]");
    if (freqInput) {
      const mg = state.muscleGroups.find((m) => m.id === freqInput.dataset.muscleFreq);
      const frequency = Math.max(1, Number(freqInput.value) || DEFAULT_FREQUENCY);
      if (mg) {
        await Repo.updateMuscleGroup(Object.assign({}, mg, { frequency }));
        state.muscleGroups = await Repo.listMuscleGroups();
      }
      return;
    }
    if (t.id === "import-file-input" && t.files[0]) {
      const text = await t.files[0].text();
      try {
        const data = JSON.parse(text);
        await Repo.importAll(data);
        await loadAll();
        render();
        toast("Backup imported");
      } catch (err) {
        toast("Import failed — invalid file");
      }
      return;
    }
    if (t.id === "new-exercise-photo" && t.files[0]) {
      captureFormName();
      pendingPhotoFile = t.files[0];
      if (pendingPhotoUrl) URL.revokeObjectURL(pendingPhotoUrl);
      pendingPhotoUrl = URL.createObjectURL(pendingPhotoFile);
      renderExerciseForm();
      return;
    }
    const photoInput = t.closest("[data-photo-exercise]");
    if (photoInput && t.files[0]) {
      toast("Saving photo…");
      try {
        const blob = await compressImage(t.files[0]);
        await Repo.setPhoto(photoInput.dataset.photoExercise, blob);
        await refreshPhotoUrls();
        render();
        toast("Photo saved");
      } catch (err) {
        toast("Couldn't process that photo");
      }
      return;
    }
    const setField = t.closest("[data-set-field]");
    if (setField) {
      const [ei, si, key] = setField.dataset.setField.split(":");
      state.activeSession.entries[Number(ei)].sets[Number(si)][key] = Number(t.value) || "";
      return;
    }
  });

  // live filter for exercise search (input event)
  appEl.addEventListener("input", (e) => {
    if (e.target.id === "exercise-search") {
      pickerSearch = e.target.value;
      const listEl = document.getElementById("exercise-list");
      if (listEl) listEl.innerHTML = exerciseListHTML();
    }
  });

  function addEntryToSession(ex, variation) {
    const metric = ex.metric || DEFAULT_METRIC;
    state.activeSession.entries.push({
      exerciseId: ex.id, exerciseName: ex.name, muscleGroups: ex.muscleGroups,
      variation: variation || "", metric, sets: [emptySet(metric)]
    });
    addExerciseOpen = false;
    pickingVariationFor = null;
    render();
  }

  function renderAddPanel() {
    const panel = document.getElementById("add-exercise-panel");
    if (panel) panel.innerHTML = addExerciseOpen ? addExercisePanel() : "";
  }
  function renderSettingsExtra() {
    const holder = document.getElementById("custom-exercise-form");
    if (holder) holder.innerHTML = customExerciseOpen ? customExerciseForm() : "";
  }

  // -----------------------------------------------------------------------
  // Boot
  // -----------------------------------------------------------------------
  async function boot() {
    appEl.innerHTML = `<div class="empty" style="padding-top:60px">Loading…</div>`;
    await Repo.init();
    await loadAll();
    render();

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }
  }

  boot();
})();
