/* =========================================================================
   Custom Fit - local-first gym tracker
   Plain JS, no build step, no external dependencies.

   ARCHITECTURE NOTE (for future multi-user / friends scaling):
   All persistence goes through the `Repo` object below. Every other part of
   the app calls Repo.* methods and never touches IndexedDB directly. If you
   later want to add a shared backend (e.g. Supabase/Firebase/a small REST
   API) so friends can use this too, you only need to rewrite the inside of
   Repo's methods to call that backend instead of IndexedDB - the rest of
   the app (views, rendering, rotation/PR logic) stays untouched.
   ========================================================================= */

(function () {
  "use strict";

  // -----------------------------------------------------------------------
  // Constants
  // -----------------------------------------------------------------------
  // Muscle groups are fully user-managed (see the Settings tab) - each one
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
  const FREQUENCY_MAX = 14;    // times per week (matches the input's max attribute)

  // Sanity ceilings for user-entered numbers. Generous on purpose - they only
  // exist to stop a stray "1e9" from wrecking every chart and total.
  const SET_VALUE_MAX = 10000;   // kg, reps, minutes or km per set
  const BODYWEIGHT_MAX = 1000;   // kg, for weigh-ins and the goal
  const NAME_MAX = 60;           // exercise names (input maxlength; imports are cut to match)
  const TAG_MAX = 30;            // muscle group and variation names

  // Muscle groups that aren't about lifting heavier over time - excluded from the Strength Index.
  const NON_STRENGTH_GROUPS = ["Cardio"];

  // Retired tags, folded into "Legs" - kept only so already-seeded exercise
  // records can be migrated on load (see migrateLegacyMuscleGroups below).
  const REMOVED_MUSCLE_GROUPS = ["Hamstrings", "Glutes", "Calves"];

  // The exercise library is fully user-built - you add each exercise
  // yourself (with muscle groups and optional variations).
  // The old pre-seeded defaults were retired; clearBuiltinExercises below
  // removes them once from devices that had them.

  // What a set logs depends on the exercise's metric. Only "weight_reps"
  // feeds Best/PRs/the Strength Index (est. 1RM needs both a weight and a
  // rep count) - the others just record their raw numbers per set.
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
  function metricLabel(metric) {
    return (METRIC_TYPES[metric] || METRIC_TYPES[DEFAULT_METRIC]).label;
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
  const DB_VERSION = 4; // v3 dropped protein tracking; v4 dropped exercise photos
  const ACTIVE_SESSION_KEY = "activeSession"; // settings-store key for the in-progress workout draft

  // Local calendar date as YYYY-MM-DD. toISOString() would give the *UTC*
  // date, which is a different day for several hours either side of
  // midnight anywhere away from Greenwich - a 7am session in NZ would be
  // filed under yesterday. Every date key in the app goes through here.
  function dateKey(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  }
  const todayStr = () => dateKey(new Date());
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  // Escape user-entered text before it goes into innerHTML - names with
  // quotes, ampersands or angle brackets would otherwise break the markup
  // (or, inside data-* attributes, silently truncate the value).
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // =======================================================================
  // DATA LAYER  (the only code that talks to IndexedDB)
  //
  // One database, five tables. Every record is a plain object. The KEY column
  // is the field IndexedDB uses to find a record; saving a record with the
  // same key replaces it.
  //
  //   TABLE         KEY         A RECORD
  //   exercises     id          { id, name, muscleGroups: [..], variations: [..], metric, isCustom }
  //   sessions      id          { id, date, startedAt, endedAt, entries: [ ENTRY, .. ] }
  //                               ENTRY = { exerciseId, exerciseName, muscleGroups, variation, metric, sets: [ SET, .. ] }
  //                               SET   = { weight, reps } or { reps } or { minutes } or { distance }
  //   bodyweight    date        { date, weight, loggedAt }
  //   muscleGroups  id          { id, name, frequency, color }
  //   settings      key         { key, value }   see the list of keys below
  //
  // Things worth knowing about the model:
  // - Muscle groups are referred to BY NAME everywhere else (exercises.muscleGroups,
  //   ENTRY.muscleGroups), never by id. That is why importing merges groups by
  //   name, and why deleting a group leaves its tag on exercises that had it.
  // - An ENTRY is a snapshot taken when the exercise was added to the workout.
  //   Renaming or deleting an exercise later never changes past sessions.
  // - Keys: bodyweight is keyed by date on purpose (one weigh-in per day; saving
  //   again replaces it). Sessions get a uid() because there can be several a day.
  // - Dates are local "YYYY-MM-DD" strings. Times (startedAt, endedAt, loggedAt)
  //   are milliseconds from Date.now(). Ids come from uid().
  // - exercises.isCustom is legacy: older versions shipped built-in exercises and
  //   this flag told them apart. It is still written but only read on upgrade.
  // - sessions has a "date" index that nothing reads; it is kept so old and new
  //   installs have the same schema.
  //
  // Settings keys:
  //   weightGoal          number or null   user preference; included in backups
  //   activeSession       SESSION or null  the in-progress workout draft; device-only
  //   builtinsCleared     true             first-run flags, see section 5
  //   muscleGroupsSeeded  true
  //
  // Reading: every list*() call passes records through a tidy*() function.
  // A record that comes back is guaranteed to have its id / name / date, lists
  // that are arrays, and numbers that are positive within the caps (or blank).
  // Unusable records are dropped. Tidy never writes anything back.
  // Writing: the app saves whole records with put(); nothing is patched in place.
  // =======================================================================
  const Repo = (function () {

    // ---- 1. Schema -------------------------------------------------------
    const TABLES = {
      exercises:    { keyPath: "id" },
      sessions:     { keyPath: "id", indexes: ["date"] },
      bodyweight:   { keyPath: "date" },
      muscleGroups: { keyPath: "id" },
      settings:     { keyPath: "key" }
    };
    const TABLE_NAMES = Object.keys(TABLES);
    // Tables from old versions that no longer exist. Dropped on upgrade,
    // together with any settings that only they used.
    const RETIRED = [
      { table: "protein", settings: ["proteinGoal"] }, // v3
      { table: "photos",  settings: [] }                // v4: exercise photos removed
    ];

    // ---- 2. Opening the database ----------------------------------------
    let dbPromise = null;

    function open() {
      if (dbPromise) return dbPromise;
      dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, DB_VERSION);

        // Runs once, the first time this DB_VERSION is opened on a device:
        // creates any table that doesn't exist yet and removes retired ones.
        req.onupgradeneeded = () => {
          const db = req.result;
          for (const name of TABLE_NAMES) {
            if (db.objectStoreNames.contains(name)) continue;
            const table = db.createObjectStore(name, { keyPath: TABLES[name].keyPath });
            for (const index of TABLES[name].indexes || []) table.createIndex(index, index);
          }
          for (const old of RETIRED) {
            if (!db.objectStoreNames.contains(old.table)) continue;
            db.deleteObjectStore(old.table);
            for (const key of old.settings) req.transaction.objectStore("settings").delete(key);
          }
        };

        req.onsuccess = () => {
          const db = req.result;
          // Another tab (or a newer release) wants to upgrade: let go of our
          // connection so it isn't blocked; the next call simply reopens.
          db.onversionchange = () => { db.close(); dbPromise = null; };
          resolve(db);
        };
        req.onerror = () => { dbPromise = null; reject(req.error); };
        req.onblocked = () => { dbPromise = null; reject(new Error("The app is open in another tab. Close it and reload.")); };
      });
      return dbPromise;
    }

    // ---- 3. Basic operations --------------------------------------------
    // Each one opens a short transaction on one table and returns a Promise.
    function request(table, mode, action) {
      return open().then((db) => new Promise((resolve, reject) => {
        const req = action(db.transaction(table, mode).objectStore(table));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
      }));
    }
    const getAll = (table)      => request(table, "readonly",  (t) => t.getAll());
    const get    = (table, key) => request(table, "readonly",  (t) => t.get(key));
    const put    = (table, rec) => request(table, "readwrite", (t) => t.put(rec));
    const del    = (table, key) => request(table, "readwrite", (t) => t.delete(key));

    // Several tables in ONE transaction: all of it lands or none of it.
    function inOneTransaction(tables, work) {
      return open().then((db) => new Promise((resolve, reject) => {
        const tx = db.transaction(tables, "readwrite");
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
        tx.onabort = () => reject(tx.error || new Error("transaction aborted"));
        work(tx);
      }));
    }
    function writeMany(tablesToRecords) {
      return inOneTransaction(Object.keys(tablesToRecords), (tx) => {
        for (const table in tablesToRecords) {
          for (const rec of tablesToRecords[table]) tx.objectStore(table).put(rec);
        }
      });
    }

    // Settings are { key, value } records; these read and write just the value.
    const getSetting = (key, fallback) => get("settings", key).then((r) => (r ? r.value : fallback));
    const setSetting = (key, value) => put("settings", { key, value });

    // list(table, tidy, order): read a table, tidy every record, sort.
    function list(table, tidy, order) {
      return getAll(table).then((rows) => rows.map(tidy).filter(Boolean).sort(order));
    }
    const byName      = (a, b) => a.name.localeCompare(b.name);
    const byDate      = (a, b) => a.date.localeCompare(b.date);
    const newestFirst = (a, b) => b.date.localeCompare(a.date) || (b.startedAt - a.startedAt);

    // ---- 4. Tidying records on the way out ------------------------------
    // Rules: a record with no usable id / name / date is dropped (returns
    // null). Missing lists become []. Numbers outside their sanity bounds
    // become blank. Names are cut to the same limits as the input fields.
    const isText  = (v) => typeof v === "string" && v.trim() !== "";
    const isDay   = (v) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
    const cleanTag = (v) => v.trim().slice(0, TAG_MAX);
    const tagList  = (v) => (Array.isArray(v) ? v.filter(isText).map(cleanTag) : []);
    // A positive number within `max`, or null. Accepts "80" as well as 80.
    function positive(v, max) {
      const n = typeof v === "number" ? v : (isText(v) ? Number(v) : NaN);
      return Number.isFinite(n) && n > 0 && n <= max ? n : null;
    }

    function tidyExercise(ex) {
      if (!ex || !isText(ex.id) || !isText(ex.name)) return null;
      return Object.assign({}, ex, {
        name: ex.name.trim().slice(0, NAME_MAX),
        muscleGroups: tagList(ex.muscleGroups),
        variations: tagList(ex.variations),
        metric: METRIC_TYPES[ex.metric] ? ex.metric : DEFAULT_METRIC
      });
    }

    function tidySet(set, metric) {
      const out = emptySet(metric);
      if (!set || typeof set !== "object") return out;
      for (const f of metricFields(metric)) {
        const n = positive(set[f.key], SET_VALUE_MAX);
        out[f.key] = n === null ? "" : n;
      }
      return out;
    }

    function tidyEntry(entry) {
      if (!entry || !isText(entry.exerciseId)) return null;
      const metric = METRIC_TYPES[entry.metric] ? entry.metric : DEFAULT_METRIC;
      const sets = (Array.isArray(entry.sets) ? entry.sets : [])
        .map((s) => tidySet(s, metric))
        .filter((s) => Object.values(s).some((v) => v));   // drop fully blank sets
      return Object.assign({}, entry, {
        exerciseName: isText(entry.exerciseName) ? entry.exerciseName.trim().slice(0, NAME_MAX) : "Unknown exercise",
        muscleGroups: tagList(entry.muscleGroups),
        variation: isText(entry.variation) ? cleanTag(entry.variation) : "",
        metric, sets
      });
    }

    function tidySession(s) {
      if (!s || !isText(s.id) || !isDay(s.date)) return null;
      const dayStart = new Date(s.date + "T00:00:00").getTime();
      return Object.assign({}, s, {
        entries: (Array.isArray(s.entries) ? s.entries : []).map(tidyEntry).filter(Boolean),
        startedAt: Number.isFinite(Number(s.startedAt)) ? Number(s.startedAt) : dayStart,
        endedAt: Number.isFinite(Number(s.endedAt)) ? Number(s.endedAt) : undefined
      });
    }

    function tidyMuscleGroup(mg, index) {
      if (!mg || !isText(mg.id) || !isText(mg.name)) return null;
      const freq = Math.round(Number(mg.frequency));
      return Object.assign({}, mg, {
        name: cleanTag(mg.name),
        frequency: Number.isFinite(freq) ? Math.min(FREQUENCY_MAX, Math.max(1, freq)) : DEFAULT_FREQUENCY,
        color: /^#[0-9a-f]{6}$/i.test(String(mg.color || "")) ? mg.color : MUSCLE_COLOR_PALETTE[index % MUSCLE_COLOR_PALETTE.length]
      });
    }

    function tidyBodyweight(bw) {
      if (!bw || !isDay(bw.date)) return null;
      const weight = positive(bw.weight, BODYWEIGHT_MAX);
      if (weight === null) return null;
      return Object.assign({}, bw, { weight, loggedAt: Number(bw.loggedAt) || 0 });
    }

    // ---- 5. First-run tasks ---------------------------------------------
    // Run at every boot. The two flagged tasks happen once per device; the
    // retag task has no flag because it is cheap and does nothing when there
    // is nothing to fix. An erased database goes through the same sequence,
    // so "after Erase" and "fresh install" are the same state.
    async function runOnce(flag, task) {
      if (await getSetting(flag, false)) return;
      await task();
      await setSetting(flag, true);
    }

    async function firstRun() {
      await runOnce("builtinsCleared", removeBuiltinExercises);
      await retagRemovedMuscleGroups();
      await runOnce("muscleGroupsSeeded", seedMuscleGroups);
    }

    // Older versions shipped a built-in exercise library; it was retired so
    // people build their own. Custom exercises stay; past sessions are
    // unaffected because they store their own name snapshots.
    async function removeBuiltinExercises() {
      for (const ex of await getAll("exercises")) {
        if (ex.isCustom) continue;
        await del("exercises", ex.id);
      }
    }

    // Hamstrings / Glutes / Calves were folded into "Legs". Exercises still
    // tagged with them get the tag replaced. Sessions keep their snapshots.
    async function retagRemovedMuscleGroups() {
      for (const ex of await getAll("exercises")) {
        const tags = Array.isArray(ex.muscleGroups) ? ex.muscleGroups : [];
        if (!tags.some((t) => REMOVED_MUSCLE_GROUPS.includes(t))) continue;
        const kept = tags.filter((t) => !REMOVED_MUSCLE_GROUPS.includes(t));
        if (!kept.includes("Legs")) kept.push("Legs");
        await put("exercises", Object.assign({}, ex, { muscleGroups: kept }));
      }
    }

    // A new install starts with a default muscle group list to edit.
    async function seedMuscleGroups() {
      if ((await getAll("muscleGroups")).length > 0) return;
      for (const mg of DEFAULT_MUSCLE_GROUPS) {
        await put("muscleGroups", { id: uid(), name: mg.name, frequency: DEFAULT_FREQUENCY, color: mg.color });
      }
    }

    // ---- 6. What the rest of the app calls ------------------------------
    return {
      init: async () => { await open(); await firstRun(); },
      tidySession, // used to check the saved in-progress workout on boot

      // Muscle groups
      listMuscleGroups: () => list("muscleGroups", tidyMuscleGroup, byName),
      addMuscleGroup: async (name, frequency) => {
        // First palette colour not already in use, so re-adding a deleted group
        // doesn't give two groups the same swatch. Past 14 groups, cycle.
        const existing = await getAll("muscleGroups");
        const used = new Set(existing.map((m) => m.color));
        const color = MUSCLE_COLOR_PALETTE.find((c) => !used.has(c)) || MUSCLE_COLOR_PALETTE[existing.length % MUSCLE_COLOR_PALETTE.length];
        return put("muscleGroups", { id: uid(), name, frequency, color });
      },
      updateMuscleGroup: (mg) => put("muscleGroups", mg),
      deleteMuscleGroup: (id) => del("muscleGroups", id),

      // Exercises
      listExercises: () => list("exercises", tidyExercise, byName),
      addExercise: (name, muscleGroups, variations, metric) =>
        put("exercises", { id: uid(), name, muscleGroups, variations: variations || [], metric: metric || DEFAULT_METRIC, isCustom: true }),
      updateExercise: (ex) => put("exercises", ex),
      deleteExercise: (id) => del("exercises", id),

      // Sessions (finished workouts)
      listSessions: () => list("sessions", tidySession, newestFirst),
      saveSession: (session) => put("sessions", session),
      deleteSession: (id) => del("sessions", id),

      // Body weight: one record per day, saving again the same day replaces it
      listBodyweight: () => list("bodyweight", tidyBodyweight, byDate),
      setBodyweight: (date, weight) => put("bodyweight", { date, weight, loggedAt: Date.now() }),
      deleteBodyweight: (date) => del("bodyweight", date),

      // Settings: small named values (see the key list in the header)
      getSetting, setSetting,

      // ---- Backup -------------------------------------------------------
      // The export is one JSON object with a section per table.
      async exportAll() {
        const [exercises, sessions, bodyweight, muscleGroups, settings] = await Promise.all(
          ["exercises", "sessions", "bodyweight", "muscleGroups", "settings"].map(getAll)
        );
        return {
          exportedAt: new Date().toISOString(),
          exercises, sessions, bodyweight, muscleGroups,
          settings: settings.filter((s) => s.key !== ACTIVE_SESSION_KEY) // the in-progress draft is device state
        };
      },

      // Import MERGES a backup into what's already here. Records with the
      // same id replace the existing one; muscle groups match by name.
      // Everything is checked and decoded first, then written in a single
      // transaction, so a bad file either imports completely or not at all.
      async importAll(data) {
        // Step 1: is this a backup at all? (older files may also carry
        // "protein" or "photos" sections, which are simply ignored)
        if (!data || typeof data !== "object" || Array.isArray(data) || !TABLE_NAMES.some((k) => Array.isArray(data[k]))) {
          throw new Error("not a Custom Fit backup");
        }
        const section = (k) => (Array.isArray(data[k]) ? data[k] : []);
        // Only user preferences come in from a backup; the first-run flags are
        // this device's own business and are already set by the time you can import.
        const SETTING_RULES = {
          weightGoal: (v) => v === null || positive(v, BODYWEIGHT_MAX) !== null
        };

        // Step 2: tidy each section with the same rules used when reading
        const exercises  = section("exercises").map(tidyExercise).filter(Boolean).map((e) => Object.assign(e, { isCustom: true }));
        const sessions   = section("sessions").map(tidySession).filter(Boolean);
        const bodyweight = section("bodyweight").map(tidyBodyweight).filter(Boolean);
        const settings   = section("settings")
          .filter((s) => s && isText(s.key) && Object.prototype.hasOwnProperty.call(SETTING_RULES, s.key) && SETTING_RULES[s.key](s.value))
          .map((s) => ({ key: s.key, value: typeof s.value === "string" ? Number(s.value) : s.value })); // "78" becomes 78

        // Step 3: muscle groups merge by name. A match keeps the existing id
        // (exercises refer to groups by name) but takes the backup's
        // frequency and colour, so re-seeded defaults never win over yours.
        const byLowerName = {};
        for (const m of (await getAll("muscleGroups")).map(tidyMuscleGroup).filter(Boolean)) byLowerName[m.name.toLowerCase()] = m;
        const muscleGroups = [];
        let updatedGroups = 0;
        for (const m of section("muscleGroups").map(tidyMuscleGroup).filter(Boolean)) {
          const key = m.name.toLowerCase();
          const current = byLowerName[key];
          if (!current) {
            muscleGroups.push(m);
            byLowerName[key] = m;
          } else if (current.frequency !== m.frequency || current.color !== m.color) {
            const merged = Object.assign({}, current, { frequency: m.frequency, color: m.color });
            muscleGroups.push(merged);
            byLowerName[key] = merged;
            updatedGroups++;
          }
        }

        // Step 4: one transaction for everything
        await writeMany({ exercises, sessions, bodyweight, muscleGroups, settings });
        return {
          exercises: exercises.length, sessions: sessions.length, bodyweight: bodyweight.length,
          muscleGroups: muscleGroups.length - updatedGroups, updatedGroups,
          settings: settings.length
        };
      },

      // Erase everything, then do exactly what a fresh install does.
      async clearAll() {
        await inOneTransaction(TABLE_NAMES, (tx) => TABLE_NAMES.forEach((name) => tx.objectStore(name).clear()));
        await firstRun();
      }
    };
  })();

  // -----------------------------------------------------------------------
  // Domain helpers
  // -----------------------------------------------------------------------
  // Clamped at 0: a session dated in the future (imported from a device with
  // a wrong clock, or another timezone) reads as "Today" rather than
  // "-3 days ago" with a negative bar width.
  function daysAgo(dateStr) {
    const d = new Date(dateStr + "T00:00:00");
    const now = new Date(todayStr() + "T00:00:00");
    return Math.max(0, Math.round((now - d) / 86400000));
  }

  // A set only counts as a lift when both numbers are real positives -
  // "!set.weight" alone let a typo like -50 through as a personal record.
  function isLiftSet(set) {
    return set.weight > 0 && set.reps > 0;
  }

  // Sessions are kept newest-first for display. Anything that answers "when
  // was this first achieved" or draws a trend walks them oldest-first, with
  // startedAt breaking ties so two sessions on one day keep their real order.
  function chronological(sessions) {
    return sessions.slice().sort((a, b) => a.date.localeCompare(b.date) || (a.startedAt - b.startedAt));
  }

  function fmtDaysAgo(n) {
    if (n === 0) return "Today";
    if (n === 1) return "Yesterday";
    return n + " days ago";
  }

  // Most recent session entry for an exercise - powers "last time" hints
  // while logging (sessions list is sorted newest-first). Pass a variation
  // string ("" = no variation) to only match that variation, so e.g. rope
  // and straight-bar pushdowns keep separate histories.
  function lastEntryForExercise(sessions, exerciseId, variation) {
    for (const s of sessions) {
      for (const entry of s.entries) {
        if (entry.exerciseId !== exerciseId) continue;
        if (variation !== undefined && (entry.variation || "") !== variation) continue;
        if (entry.sets.some((x) => Object.values(x).some((v) => v))) return { date: s.date, sets: entry.sets, metric: entry.metric || DEFAULT_METRIC };
      }
    }
    return null;
  }

  // PRs are tracked per exercise *and* variation - a rope pushdown and a
  // straight-bar pushdown are different lifts as far as "your best" goes,
  // and a lighter variation would otherwise never register a PR. The key
  // joins the two with a character that can't appear in an id.
  function variationKey(exerciseId, variation) {
    return exerciseId + "|" + (variation || "");
  }

  // Best set (by est 1RM) for every exercise+variation seen in history.
  // Drives the PR count on Finish and the per-variation list on the detail screen.
  function bestSetsByVariation(sessions) {
    const best = {};
    for (const s of chronological(sessions)) {
      for (const entry of s.entries) {
        const key = variationKey(entry.exerciseId, entry.variation);
        for (const set of entry.sets) {
          if (!isLiftSet(set)) continue;
          const orm = estOneRM(set.weight, set.reps);
          if (!best[key] || orm > best[key].orm) {
            best[key] = { orm, weight: set.weight, reps: set.reps, date: s.date, exerciseId: entry.exerciseId, variation: entry.variation || "" };
          }
        }
      }
    }
    return best;
  }

  // Best set for one exercise + variation combination (same filtering rule)
  function bestSetForVariation(sessions, exerciseId, variation) {
    let best = null;
    for (const s of chronological(sessions)) {
      for (const entry of s.entries) {
        if (entry.exerciseId !== exerciseId) continue;
        if ((entry.variation || "") !== variation) continue;
        for (const set of entry.sets) {
          if (!isLiftSet(set)) continue;
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
  // interval (7 / frequency days) - daysSince is compared against that
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
  // not fixed day counts - e.g. at 2x/week (3.5-day interval), day 3 is
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
  // training urgency relative to each muscle's own target frequency - not
  // the muscle's identity - so green/orange/red always means
  // recently-done/upcoming/overdue.
  function rotationItemHTML(r) {
    const pct = r.overdueRatio === Infinity ? 100 : Math.min(100, Math.round((r.overdueRatio / 1.5) * 100));
    const status = rotationColor(r.overdueRatio);
    return `
      <div class="rotation-item" style="margin-bottom:10px">
        <span class="small" style="width:78px">${esc(r.muscle)}<div class="small muted" style="font-weight:400">${r.frequency}x/wk</div></span>
        <div class="bar-track"><div class="bar-fill" style="width:${pct}%;background:${ROTATION_STATUS_COLORS[status]}"></div></div>
        <span class="pill ${status}">${r.daysSince === Infinity ? "Never" : fmtDaysAgo(r.daysSince)}</span>
      </div>
    `;
  }

  // A best set as a green pill with the estimated 1RM on a small line under
  // it. Two short lines fit beside a long exercise name; one long pill
  // could not shrink and ran off the card.
  function bestPillHTML(b) {
    return `<span style="text-align:right;flex-shrink:0"><span class="pill good">${b.weight}kg × ${b.reps}</span><div class="small muted" style="margin-top:3px">~${Math.round(b.orm)}kg 1RM</div></span>`;
  }

  // Best set (by est 1RM) per exercise across all sessions. Only sets with
  // both a weight and a rep count qualify - time/distance/reps-only sets
  // would otherwise register as a 0kg "best" and show up under Lift
  // progress (and count as a PR the first time they're logged).
  function bestSetsByExercise(sessions) {
    const best = {};
    for (const s of chronological(sessions)) {
      for (const entry of s.entries) {
        for (const set of entry.sets) {
          if (!isLiftSet(set)) continue;
          const orm = estOneRM(set.weight, set.reps);
          if (!best[entry.exerciseId] || orm > best[entry.exerciseId].orm) {
            best[entry.exerciseId] = { orm, weight: set.weight, reps: set.reps, date: s.date };
          }
        }
      }
    }
    return best;
  }

  // Chronological history (weight/reps/1RM/volume) for one exercise: one row
  // per calendar *day*, taking the best set across every entry and session
  // of that exercise on it (an exercise can appear twice - two variations,
  // or a morning and evening session) and summing the volume. Rows per entry
  // drew a false dip whenever the lighter one happened to be logged second,
  // and two rows on one date collapsed to a single point in the Strength Index.
  // Pass a variation ("" = Standard) to restrict to that variation; omit it
  // for the exercise as a whole.
  function exerciseHistory(sessions, exerciseId, variation) {
    const byDay = {};
    const order = [];
    for (const s of chronological(sessions)) {
      for (const entry of s.entries) {
        if (entry.exerciseId !== exerciseId) continue;
        if (variation !== undefined && (entry.variation || "") !== variation) continue;
        for (const set of entry.sets) {
          if (!isLiftSet(set)) continue;
          let row = byDay[s.date];
          if (!row) { row = byDay[s.date] = { date: s.date, weight: 0, reps: 0, orm: 0, volume: 0 }; order.push(row); }
          row.volume += set.weight * set.reps;
          const orm = estOneRM(set.weight, set.reps);
          if (orm > row.orm) { row.orm = orm; row.weight = set.weight; row.reps = set.reps; }
        }
      }
    }
    return order;
  }

  // Flat, chronological log of every set for a non-weight_reps exercise
  // (time / distance / reps-only) - no "best" concept, just the raw numbers.
  function genericSetHistory(sessions, exerciseId) {
    const history = [];
    for (const s of chronological(sessions)) {
      for (const entry of s.entries) {
        if (entry.exerciseId !== exerciseId) continue;
        const metric = entry.metric || DEFAULT_METRIC;
        // Weight×reps sets belong to exerciseHistory; an exercise whose
        // metric was changed after logging keeps both kinds of history.
        if (metric === "weight_reps") continue;
        for (const set of entry.sets) {
          if (!Object.values(set).some((v) => v)) continue;
          history.push({ date: s.date, set, metric });
        }
      }
    }
    return history;
  }

  // Sessions store a name snapshot per entry so history survives deletion,
  // but while the exercise still exists in the library its *current* name
  // should win - otherwise a rename shows up in some lists and not others.
  function exerciseDisplayName(exerciseId, snapshotName) {
    const ex = state.exercises.find((e) => e.id === exerciseId);
    return ex ? ex.name : snapshotName;
  }

  // Personal Records overview: one row per exercise+variation, most recent
  // PR first. Sessions are walked oldest-first with a strict ">" so the date
  // recorded is the day the record was *first* set, not a later tie.
  function recentPRs(sessions) {
    const bestSoFar = {};
    for (const s of chronological(sessions)) {
      for (const entry of s.entries) {
        const key = variationKey(entry.exerciseId, entry.variation);
        for (const set of entry.sets) {
          if (!isLiftSet(set)) continue;
          const orm = estOneRM(set.weight, set.reps);
          if (!bestSoFar[key] || orm > bestSoFar[key].orm) {
            bestSoFar[key] = {
              orm, weight: set.weight, reps: set.reps, date: s.date,
              exerciseId: entry.exerciseId, variation: entry.variation || "",
              exerciseName: exerciseDisplayName(entry.exerciseId, entry.exerciseName)
            };
          }
        }
      }
    }
    return Object.values(bestSoFar).sort((a, b) => b.date.localeCompare(a.date));
  }

  // -----------------------------------------------------------------------
  // Strength Index - a single relative-progress number, since exercises use
  // wildly different absolute weights (a 40kg curl and a 140kg squat) and
  // can't be summed directly. Each exercise *variation* (rope vs. bar
  // pushdowns are different lifts) gets its own best-estimated-1RM history,
  // one point per day, normalized to "% of its baseline" - the strongest of
  // its first two logged days, so a tentative first session doesn't set an
  // artificially low bar. Those normalized series are averaged together:
  // across every lift for the overall index, or across the lifts tagged to
  // one muscle group for that group's index. A rising number means you're
  // moving more weight than when you started tracking, regardless of which
  // specific lifts drove it.
  // -----------------------------------------------------------------------
  const BASELINE_DAYS = 2; // how many of a lift's first days set its baseline

  function normalizedSeries(history) {
    // A lift logged on a single day has no trend yet - it would only sit at
    // its baseline forever and drag the average toward "no change".
    if (history.length < 2) return [];
    const base = Math.max(...history.slice(0, BASELINE_DAYS).map((h) => h.orm));
    if (!base) return [];
    return history.map((h) => ({ date: h.date, value: (h.orm / base) * 100 }));
  }

  // One normalized series per variation of the exercise that has lift history.
  function exerciseVariationSeries(sessions, exerciseId) {
    const variations = new Set();
    for (const s of sessions) {
      for (const entry of s.entries) {
        if (entry.exerciseId === exerciseId && entry.sets.some(isLiftSet)) variations.add(entry.variation || "");
      }
    }
    return Array.from(variations)
      .map((v) => normalizedSeries(exerciseHistory(sessions, exerciseId, v)))
      .filter((series) => series.length > 0);
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

  // An exercise feeds the index when it's tracked by weight × reps (so an
  // estimated 1RM exists) and isn't tagged *only* with non-strength groups.
  // A sled push tagged Cardio + Legs is still a lift; a run isn't.
  function isStrengthExercise(ex) {
    if ((ex.metric || DEFAULT_METRIC) !== "weight_reps") return false;
    const tags = ex.muscleGroups || [];
    return !(tags.length > 0 && tags.every((mg) => NON_STRENGTH_GROUPS.includes(mg)));
  }

  function computeStrengthIndex(sessions, exercises) {
    const strengthExercises = exercises.filter(isStrengthExercise);

    // Series are computed once per exercise and reused for each muscle group
    const seriesByExercise = {};
    for (const ex of strengthExercises) seriesByExercise[ex.id] = exerciseVariationSeries(sessions, ex.id);

    const overallSeries = mergeSeriesAverage(strengthExercises.flatMap((ex) => seriesByExercise[ex.id]));

    const byMuscle = {};
    for (const mgObj of state.muscleGroups) {
      const mg = mgObj.name;
      if (NON_STRENGTH_GROUPS.includes(mg)) continue;
      const series = strengthExercises
        .filter((ex) => ex.muscleGroups.includes(mg))
        .flatMap((ex) => seriesByExercise[ex.id]);
      byMuscle[mg] = series.length > 0 ? mergeSeriesAverage(series) : null;
    }
    return { overallSeries, byMuscle };
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
  // Rest timer - lives outside the render cycle in its own fixed pill so
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
      toast("Rest over, next set!");
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
      gear: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1Z"/></svg>',
      back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15 18l-6-6 6-6"/></svg>',
      scale: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M12 8.5v3.2l2.6 1.8"/></svg>'
    };
    return icons[name] || "";
  }

  // Selectable time windows for the Weight tab chart. Shortest is 1 week -
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

  const routes = ["home", "train", "progress", "weight", "settings"];
  let state = {
    route: "home",
    exercises: [],
    sessions: [],
    bodyweight: [],
    weightGoal: null,    // target body weight (kg) - drawn as a horizontal line on the chart
    muscleGroups: [],
    weightRange: "2w",   // defaults to 2 weeks, per WEIGHT_RANGES above
    activeSession: null,  // in-memory in-progress workout
    progressDetail: null, // exerciseId being viewed in detail
    storage: null         // { usage, quota, persisted } from navigator.storage, or null if unsupported
  };

  // Storage health: how much of the browser's quota this app is using, and
  // whether the browser has agreed to protect it from eviction. Both APIs are
  // optional (old browsers, some WebViews), so every call is guarded and the
  // readout simply hides itself when nothing is available.
  async function refreshStorageInfo() {
    if (!navigator.storage) { state.storage = null; return; }
    try {
      const [est, persisted] = await Promise.all([
        navigator.storage.estimate ? navigator.storage.estimate() : Promise.resolve({}),
        navigator.storage.persisted ? navigator.storage.persisted() : Promise.resolve(null)
      ]);
      state.storage = { usage: est.usage || 0, quota: est.quota || 0, persisted };
    } catch (e) {
      state.storage = null;
    }
  }

  // Human-readable byte count for the Settings readout, e.g. 1234567 -> "1.2 MB".
  function formatBytes(n) {
    if (!n || n < 1024) return `${Math.round(n || 0)} B`;
    const units = ["KB", "MB", "GB", "TB"];
    let i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < units.length - 1);
    return `${n < 10 ? n.toFixed(1) : Math.round(n)} ${units[i]}`;
  }

  async function loadAll() {
    const [exercises, sessions, bodyweight, weightGoal, muscleGroups] = await Promise.all([
      Repo.listExercises(), Repo.listSessions(), Repo.listBodyweight(), Repo.getSetting("weightGoal", null), Repo.listMuscleGroups()
    ]);
    state.exercises = exercises;
    state.sessions = sessions;
    state.bodyweight = bodyweight;
    // A goal of null or text (possible via an old backup) must not reach the
    // chart; fall back rather than trust the store.
    state.weightGoal = Number(weightGoal) > 0 && Number(weightGoal) <= BODYWEIGHT_MAX ? Number(weightGoal) : null;
    state.muscleGroups = muscleGroups;
  }

  // The in-progress workout lives in memory, but phones reload PWAs freely
  // (switching apps, a call, low memory) - mirror every change to the
  // settings store so a reload mid-session picks up where you left off.
  function persistActiveSession() {
    Repo.setSetting(ACTIVE_SESSION_KEY, state.activeSession).catch(() => {});
  }

  // Set inputs update state on every keystroke (input) as well as on blur
  // (change) so the draft above is never more than one character behind.
  // Returns a message when the typed value was non-empty but unusable
  // (negative, zero, absurd) so the change handler can clear it and say why;
  // an empty string means the value was fine.
  function applySetField(input) {
    if (!state.activeSession) return "";
    const [ei, si, key] = input.dataset.setField.split(":");
    const entry = state.activeSession.entries[Number(ei)];
    const set = entry && entry.sets[Number(si)];
    if (!set) return "";
    const raw = input.value.trim();
    const n = Number(raw);
    const valid = raw !== "" && Number.isFinite(n) && n > 0 && n <= SET_VALUE_MAX;
    set[key] = valid ? n : "";
    const problem = valid || raw === "" ? "" : (Number.isFinite(n) && n > SET_VALUE_MAX ? `Sets can't be more than ${SET_VALUE_MAX}` : "Sets need a positive number");
    persistActiveSession();
    // Refresh just this set's "beats your best" line - a full render here
    // would steal focus from the input mid-typing.
    const holder = document.querySelector(`[data-set-hint="${ei}:${si}"]`);
    if (holder) {
      const best = (entry.metric || DEFAULT_METRIC) === "weight_reps"
        ? bestSetForVariation(state.sessions, entry.exerciseId, entry.variation || "") : null;
      holder.innerHTML = setHintHTML(set, best);
    }
    return problem; // "" when fine
  }

  // Read a numeric input for the weight / goal buttons. Previously
  // an unusable value made the button do nothing at all, with no message.
  function readPositive(input, max, label) {
    if (input.validity && input.validity.badInput) { toast(`${label}: enter a number`); return null; }
    const raw = input.value.trim();
    if (raw === "") { toast(`${label}: enter a number`); return null; }
    const n = Number(raw);
    if (!Number.isFinite(n) || n <= 0) { toast(`${label} must be above 0`); return null; }
    if (n > max) { toast(`${label} can't be more than ${max}`); return null; }
    return n;
  }

  function clampFrequency(raw) {
    const n = Math.round(Number(raw));
    if (!Number.isFinite(n) || String(raw).trim() === "") return DEFAULT_FREQUENCY;
    return Math.min(FREQUENCY_MAX, Math.max(1, n));
  }

  function navTo(route) {
    captureFormName(); // whichever exercise form is open, don't lose what was typed
    if (state.route === "train" && route !== "train") {
      // The picker sheet and its "new exercise" form are Train-only state;
      // leaving them set made the Settings form think it was in Train mode.
      addExerciseOpen = false;
      pickingVariationFor = null;
      if (trainFormOpen) { trainFormOpen = false; resetExerciseForm(); }
    }
    state.route = route;
    state.progressDetail = null;
    render();
    // Storage numbers drift as you log sets; re-measure on
    // each visit to Settings and repaint once the (async) answer is back.
    if (route === "settings") refreshStorageInfo().then(() => { if (state.route === "settings") render(); });
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
      const ds = dateKey(d);
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

  function viewHome() {
    const rotation = computeRotation(state.sessions);
    const recent = state.sessions.slice(0, 3);

    return `
      <div class="view">
        <div class="card">
          <h2>This week</h2>
          ${weekDotsHTML()}
          ${state.activeSession
            ? `<button class="btn primary block" data-nav="train" style="margin-top:10px">Resume Workout <span class="muted" style="font-weight:600;font-size:12px;color:#3a2410">· ${state.activeSession.entries.length} exercise${state.activeSession.entries.length === 1 ? "" : "s"} · ${sessionElapsedText()}</span></button>`
            : `<button class="btn success block" data-nav="train" style="margin-top:10px">Start Workout</button>`}
        </div>

        <div class="card">
          ${bodyWeightMini()}
        </div>

        <div class="card">
          <h2>Muscle rotation <span class="link" data-nav="progress">Muscle detail →</span></h2>
          ${rotationListHTML(rotation)}
        </div>

        <div class="card">
          <h2>Recent sessions</h2>
          ${recent.length === 0 ? `<div class="empty">No sessions logged yet.</div>` :
            recent.map((s) => {
              const mgs = Array.from(new Set(s.entries.flatMap((e) => e.muscleGroups || [])));
              return `<div class="row"><div><div style="font-weight:700">${fmtDate(s.date)}</div>
                <div class="small muted">${esc(mgs.join(", ")) || "No muscle groups"}</div></div>
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

  // "Matches/beats your best" line under a set. Rendered inside a holder
  // per set so applySetField can refresh it on every keystroke without a
  // full re-render (which would steal focus from the input).
  function setHintHTML(set, best) {
    if (!best || !isLiftSet(set)) return "";
    return estOneRM(set.weight, set.reps) >= best.orm
      ? `<div class="small" style="color:var(--accent);margin:-2px 0 6px">Matches/beats your best</div>`
      : "";
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
          <strong style="display:flex;align-items:center;gap:8px">${esc(exerciseDisplayName(entry.exerciseId, entry.exerciseName))}${v ? `<span class="variation-tag">${esc(v)}</span>` : ""}</strong>
          <button class="btn sm danger" data-remove-exercise="${ei}">Remove</button>
        </div>
        <div class="small muted" style="margin-bottom:8px">${esc((entry.muscleGroups || []).join(", "))}</div>
        ${prev || best ? `
        <div class="ex-stats">
          ${prev ? `<div class="ex-stat"><span class="ex-stat-label">Last · ${fmtDaysAgo(daysAgo(prev.date))}</span><span class="ex-stat-value">${prev.sets.map((x) => formatSetValue(x, prev.metric)).join(", ")}</span></div>` : ""}
          ${best ? `<div class="ex-stat best"><span class="ex-stat-label">Best</span><span class="ex-stat-value">${best.weight}kg × ${best.reps} <span class="muted">(~${Math.round(best.orm)}kg 1RM)</span></span></div>` : ""}
        </div>` : ""}
        ${entry.sets.map((set, si) => {
          // Ghost values only make sense when the last time was logged in the same metric
          const ghost = prev && prev.metric === metric && prev.sets[si] ? prev.sets[si] : null;
          return `
          <div class="set-row${fields.length === 1 ? " single" : ""}">
            <span class="idx">${si + 1}</span>
            ${fields.map((f) => `<span class="set-field"><input type="number" min="0" max="${SET_VALUE_MAX}" inputmode="${f.inputMode}" placeholder="${ghost && ghost[f.key] ? ghost[f.key] : ""}" value="${set[f.key] || ""}" data-set-field="${ei}:${si}:${f.key}" aria-label="${f.unit}" /><span class="unit">${f.unit}</span></span>`).join("")}
            <button class="del" data-remove-set="${ei}:${si}" aria-label="remove set">×</button>
          </div>
          <div data-set-hint="${ei}:${si}">${setHintHTML(set, best)}</div>
        `; }).join("")}
        <button class="btn sm ghost" data-add-set="${ei}">+ Add set</button>
      </div>
    `;
  }

  // ---------------------------------------------------------------------
  // Exercise picker - a bottom-sheet popup with search + muscle filter.
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
      <div class="sheet-title"><h2 style="margin:0">${esc(ex.name)}</h2><span class="link" data-close-add>Close</span></div>
      <div class="small muted" style="margin-bottom:12px">Which variation? Each keeps its own last-time and best numbers.</div>
      ${ex.variations.map((vName) => `<div class="pick-row" data-pick-variation="${esc(vName)}"><span>${esc(vName)}</span><span class="chev">›</span></div>`).join("")}
      <div class="pick-row" data-pick-variation=""><span>Standard <span class="small muted">(no variation)</span></span><span class="chev">›</span></div>
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
      ${mg ? `<div class="small muted" style="margin:10px 2px 6px">${esc(mg)}</div>` : ""}
      ${grouped[mg].map((ex) => `
        <div class="pick-row" data-pick-exercise="${ex.id}">
          <span>${esc(ex.name)}${ex.variations && ex.variations.length ? `<div class="small muted">${esc(ex.variations.join(" · "))}</div>` : ""}${(ex.metric || DEFAULT_METRIC) !== "weight_reps" ? `<div class="small muted">${metricLabel(ex.metric)}</div>` : ""}</span>
          <span style="display:flex;align-items:center;gap:8px"><span class="small muted">${esc(ex.muscleGroups.join(", "))}</span><span class="chev">›</span></span>
        </div>
      `).join("")}
    `).join("");
  }

  function pickerContent() {
    if (state.exercises.length === 0) {
      return `
        <div class="sheet-title"><h2 style="margin:0">Add exercise</h2><span class="link" data-close-add>Close</span></div>
        <div class="empty">Your exercise library is empty. Create your first exercise right here.</div>
        <button class="btn primary block" id="train-new-exercise-btn">+ New exercise</button>
      `;
    }
    const groups = state.muscleGroups.map((mg) => mg.name).filter((mg) => state.exercises.some((ex) => ex.muscleGroups.includes(mg)));
    return `
      <div class="sheet-title"><h2 style="margin:0">Add exercise</h2><span class="link" data-close-add>Close</span></div>
      <div class="field" style="margin-top:10px">
        <input type="text" id="exercise-search" placeholder="Search exercises…" value="${esc(pickerSearch)}" />
      </div>
      <div class="chip-row" style="margin-bottom:10px">
        <span class="chip${pickerFilter === "All" ? " selected" : ""}" data-picker-filter="All">All</span>
        ${groups.map((g) => `<span class="chip${pickerFilter === g ? " selected" : ""}" data-picker-filter="${esc(g)}">${esc(g)}</span>`).join("")}
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
    const weekAgoStr = dateKey(weekAgo);
    const today = todayStr();
    const thisWeekSessions = state.sessions.filter((s) => s.date >= weekAgoStr && s.date <= today);
    const setsThisWeek = thisWeekSessions.reduce((a, s) => a + s.entries.reduce((b, e) => b + e.sets.length, 0), 0);
    const currentGroups = new Set(state.muscleGroups.map((mg) => mg.name));
    const musclesThisWeek = new Set(thisWeekSessions.flatMap((s) => s.entries.flatMap((e) => (e.muscleGroups || []).filter((mg) => currentGroups.has(mg))))).size;

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
          <h2>Muscle rotation</h2>
          ${viewRotationFullInner()}
        </div>

        <div class="card">
          <h2>Personal records</h2>
          ${prs.length === 0 ? `<div class="empty">No PRs yet. Log a session to start tracking.</div>` :
            prs.map((pr) => `
              <div class="row list-tap" data-view-exercise="${pr.exerciseId}">
                <span>${esc(pr.exerciseName)}${pr.variation ? ` <span class="variation-tag">${esc(pr.variation)}</span>` : ""}<div class="small muted">${fmtDate(pr.date)}</div></span>
                ${bestPillHTML(pr)}
              </div>
            `).join("")}
        </div>

        <div class="card">
          <h2>Lift progress</h2>
          ${used.length === 0 ? `<div class="empty">Log a session to start tracking lifts.</div>` :
            used.sort((a, b) => a.name.localeCompare(b.name)).map((ex) => `
              <div class="row list-tap" data-view-exercise="${ex.id}">
                <span>${esc(ex.name)}</span>
                ${bestPillHTML(best[ex.id])}
              </div>
            `).join("")}
        </div>
      </div>
    `;
  }

  function rotationListHTML(rotation) {
    if (rotation.length === 0) return `<div class="empty">No muscle groups yet. Add some in Settings.</div>`;
    return rotation.map(rotationItemHTML).join("");
  }

  function viewRotationFullInner() {
    return rotationListHTML(computeRotation(state.sessions));
  }

  // For an exercise that's been deleted from the library, rebuild enough of
  // it from the most recent session snapshot that its history still opens.
  function exerciseStubFromSessions(exId) {
    for (const s of state.sessions) {
      const entry = s.entries.find((e) => e.exerciseId === exId);
      if (entry) return { id: exId, name: entry.exerciseName, muscleGroups: entry.muscleGroups || [], metric: entry.metric || DEFAULT_METRIC, deleted: true };
    }
    return null;
  }

  function viewProgressDetail(exId) {
    const ex = state.exercises.find((e) => e.id === exId) || exerciseStubFromSessions(exId);
    if (!ex) { state.progressDetail = null; return viewProgress(); }
    const metric = ex.metric || DEFAULT_METRIC;
    const deletedNote = ex.deleted ? `<div class="small muted" style="margin-bottom:8px">No longer in your library. Showing logged history only.</div>` : "";

    // An exercise can carry both kinds of history if its metric was changed
    // after some sessions were logged - show whichever exist, rather than
    // picking one by the library's current metric and mis-formatting the rest.
    const history = exerciseHistory(state.sessions, exId);        // weight×reps, one row per session
    const generic = genericSetHistory(state.sessions, exId);      // time / distance / reps-only sets

    let strengthHTML = "";
    if (history.length > 0) {
      const best = history.reduce((m, h) => (!m || h.orm > m.orm ? h : m), null);
      const first = history[0];
      const delta = first && best && first.orm > 0 ? Math.round(((best.orm - first.orm) / first.orm) * 100) : null;
      // Only worth a section once more than one variation has history (or the
      // sole variation isn't "Standard") - otherwise it just repeats "Best".
      const perVariation = Object.values(bestSetsByVariation(state.sessions))
        .filter((b) => b.exerciseId === exId)
        .sort((a, b) => b.orm - a.orm);
      const showVariations = perVariation.length > 1 || (perVariation.length === 1 && perVariation[0].variation);
      strengthHTML = `
          <div class="btn-row" style="margin-bottom:12px">
            <span class="pill good">Best ${best.weight}kg × ${best.reps}</span>
            <span class="small muted" style="align-self:center">~${Math.round(best.orm)}kg 1RM · ${fmtDate(best.date)}</span>
            ${delta !== null ? `<span class="pill ${delta >= 0 ? "good" : "bad"}">${delta >= 0 ? "+" : ""}${delta}% since first log</span>` : ""}
          </div>
          ${showVariations ? `
          <div class="small muted" style="margin:4px 0 2px">Best per variation</div>
          <div style="margin-bottom:12px">${perVariation.map((b) => `
            <div class="row"><span class="small">${b.variation ? esc(b.variation) : "Standard"}</span><span class="small">${b.weight}kg × ${b.reps} <span class="muted">(~${Math.round(b.orm)}kg 1RM)</span> · ${fmtDate(b.date)}</span></div>
          `).join("")}</div>` : ""}
          ${history.length > 1 ? `<div class="small muted" style="margin-bottom:2px">Estimated 1RM trend</div>${sparkline(history.map((h) => h.orm))}` : ""}
          ${history.length > 1 ? `<div class="small muted" style="margin:10px 0 2px">Session volume (weight × reps)</div>${sparkline(history.map((h) => h.volume))}` : ""}
          <div style="margin-top:10px">${history.slice().reverse().map((h) => `
            <div class="row"><span class="small">${fmtDate(h.date)}</span><span class="small">${h.weight}kg × ${h.reps} <span class="muted">(~${Math.round(h.orm)}kg 1RM)</span></span></div>
          `).join("")}</div>`;
    }

    let genericHTML = "";
    if (generic.length > 0) {
      // A trend line only when every logged set shares one metric
      const metrics = new Set(generic.map((h) => h.metric));
      const field = metrics.size === 1 ? metricFields(generic[0].metric)[0] : null;
      genericHTML = `
          ${history.length > 0 ? `<div class="small muted" style="margin:14px 0 4px">Other logged sets</div>` : ""}
          ${field && generic.length > 1 ? `<div class="small muted" style="margin-bottom:2px">${field.unit} trend</div>${sparkline(generic.map((h) => Number(h.set[field.key]) || 0))}` : ""}
          <div style="margin-top:10px">${generic.slice().reverse().map((h) => `
            <div class="row"><span class="small">${fmtDate(h.date)}</span><span class="small">${formatSetValue(h.set, h.metric)}</span></div>
          `).join("")}</div>`;
    }

    return `
      <div class="view">
        <button class="btn sm ghost" data-back-progress style="align-self:flex-start">${icon("back")} Back</button>
        <div class="card">
          <div class="row" style="align-items:center;margin-bottom:4px"><h2 style="margin:0">${esc(ex.name)}</h2></div>
          <div class="small muted" style="margin-bottom:10px">${esc(ex.muscleGroups.join(", "))}${metric !== "weight_reps" ? ` · ${metricLabel(metric)}` : ""}</div>
          ${deletedNote}
          ${strengthHTML}
          ${genericHTML}
          ${history.length === 0 && generic.length === 0 ? `<div class="empty">No sets logged for this exercise yet.</div>` : ""}
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

  // Bigger line chart with axis labels - used for body weight and Strength Index trends
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

  // Compact version for Home - quick log only, no chart (the chart lives on the Weight tab)
  function bodyWeightMini() {
    const history = state.bodyweight;
    const todayEntry = history.find((e) => e.date === todayStr());
    const latest = history[history.length - 1];
    return `
      <h2>Body weight <span class="link" data-nav="weight">Trend →</span></h2>
      <div class="row" style="align-items:center">
        <div style="font-size:22px;font-weight:800">${latest ? latest.weight + "kg" : "No entry"}</div>
        <div style="display:flex;gap:6px;align-items:center">
          <input type="number" inputmode="decimal" step="0.1" id="bodyweight-input" placeholder="kg" value="${todayEntry ? todayEntry.weight : ""}" style="width:80px" />
          <button class="btn primary sm" id="save-bodyweight">${todayEntry ? "Update" : "Log"}</button>
        </div>
      </div>
    `;
  }

  function fmtShortDate(dateStr, withYear) {
    const d = new Date(dateStr + "T00:00:00");
    return d.toLocaleDateString(undefined, withYear ? { day: "numeric", month: "short", year: "2-digit" } : { day: "numeric", month: "short" });
  }

  // Entries within the selected WEIGHT_RANGES window (history must be date-ascending)
  function filterBodyweightRange(history, rangeKey) {
    const opt = WEIGHT_RANGES.find((r) => r.key === rangeKey) || WEIGHT_RANGES[1];
    if (opt.days === Infinity) return history.slice();
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - (opt.days - 1));
    const cutoffStr = dateKey(cutoff);
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
  function weightAreaChart(points, goal) {
    const w = 320, h = 170, padX = 6, padTop = 16, padBottom = 22;
    const values = points.map((p) => p.weight);
    const scaleValues = goal ? values.concat([goal]) : values;
    const rawMin = Math.min(...scaleValues), rawMax = Math.max(...scaleValues);
    const span = rawMax - rawMin || 1;
    const pad = span * 0.2 || 1;
    const min = rawMin - pad, max = rawMax + pad;
    const range = max - min || 1;

    // x is proportional to elapsed time, not to index - a year-old weigh-in
    // and one from last week must not sit next to each other.
    const dayMs = (dateStr) => new Date(dateStr + "T00:00:00").getTime();
    const t0 = dayMs(points[0].date), tSpan = Math.max(1, dayMs(points[points.length - 1].date) - t0);
    const xAt = (i) => padX + (points.length === 1 ? (w - padX * 2) / 2 : ((dayMs(points[i].date) - t0) / tSpan) * (w - padX * 2));
    const yAt = (v) => padTop + (1 - (v - min) / range) * (h - padTop - padBottom);

    const linePts = points.map((p, i) => `${xAt(i)},${yAt(p.weight)}`).join(" ");
    const areaPts = `${xAt(0)},${h - padBottom} ${linePts} ${xAt(points.length - 1)},${h - padBottom}`;

    const gridVals = [max - pad * 0.3, (max + min) / 2, min + pad * 0.3];
    const gridLines = gridVals.map((v) => {
      const y = yAt(v);
      return `<line x1="${padX}" y1="${y}" x2="${w - padX}" y2="${y}" stroke="var(--border)" stroke-width="1"/>
        <text x="${padX}" y="${y - 4}" font-size="9" fill="var(--text-dim)">${v.toFixed(1)}</text>`;
    }).join("");

    // Date labels: first, last, and whichever point sits nearest the middle
    // of the axis - as long as it's clear of both ends.
    let midIdx = -1, midDist = Infinity;
    for (let i = 1; i < points.length - 1; i++) {
      const d = Math.abs(xAt(i) - w / 2);
      if (d < midDist) { midDist = d; midIdx = i; }
    }
    const midOk = midIdx > 0 && xAt(midIdx) - padX > 60 && (w - padX) - xAt(midIdx) > 60;
    const labelIdxs = points.length > 2 ? (midOk ? [0, midIdx, points.length - 1] : [0, points.length - 1]) : points.map((_, i) => i);
    const xLabels = labelIdxs.map((i) => {
      const anchor = i === 0 ? "start" : i === points.length - 1 ? "end" : "middle";
      return `<text x="${xAt(i)}" y="${h - 6}" font-size="9.5" fill="var(--text-dim)" text-anchor="${anchor}">${fmtShortDate(points[i].date, tSpan > 300 * 86400000)}</text>`;
    }).join("");

    const last = points[points.length - 1];

    const goalLine = goal ? `
      <line x1="${padX}" y1="${yAt(goal)}" x2="${w - padX}" y2="${yAt(goal)}" stroke="var(--good)" stroke-width="1.5" stroke-dasharray="4 3"/>
      <text x="${w - padX}" y="${yAt(goal) - 4}" font-size="9" fill="var(--good)" text-anchor="end">Goal · ${goal}kg</text>
    ` : "";

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
        ${goalLine}
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
          <div class="row" style="align-items:center;margin-bottom:2px">
            <div style="font-size:30px;font-weight:800">${latest ? latest.weight + "kg" : "No entry"}</div>
            <div style="display:flex;gap:6px;align-items:center">
              <input type="number" inputmode="decimal" step="0.1" id="bodyweight-input" placeholder="kg" value="${todayEntry ? todayEntry.weight : ""}" style="width:88px" />
              <button class="btn primary sm" id="save-bodyweight">${todayEntry ? "Update" : "Log"}</button>
            </div>
          </div>
          ${delta !== null ? `<div style="margin:4px 0 2px"><span class="pill">${delta > 0 ? "+" : ""}${delta}kg${pct !== null ? ` (${pct > 0 ? "+" : ""}${pct}%)` : ""} over selected range</span></div>` : ""}
          <div class="row" style="margin:10px 0;align-items:center">
            <span class="small muted">${state.weightGoal ? `Goal: ${state.weightGoal}kg${latest ? ` · ${Math.abs(Math.round((latest.weight - state.weightGoal) * 10) / 10)}kg to go` : ""}` : "No goal weight set"}</span>
            <div style="display:flex;gap:6px;align-items:center">
              <input type="number" inputmode="decimal" step="0.1" id="weight-goal-input" placeholder="goal kg" value="${state.weightGoal || ""}" style="width:88px" />
              <button class="btn sm" id="save-weight-goal">Save</button>
            </div>
          </div>
          ${rangeSelectorHTML(state.weightRange)}
          ${filtered.length > 1 ? weightAreaChart(filtered, state.weightGoal) :
            filtered.length === 1 ? `<div class="empty">Only one weigh-in in this range. Widen the range or log again tomorrow.</div>` :
            `<div class="empty">No weigh-ins in this range yet.</div>`}
        </div>

        <div class="card">
          <h2>History</h2>
          ${fullHistory.length === 0 ? `<div class="empty">No weigh-ins yet. Log today's above to get started.</div>` :
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
    const latest = overallSeries.length > 1 ? Math.round(overallSeries[overallSeries.length - 1].value) : null;
    const delta = latest !== null ? latest - 100 : null;

    const breakdown = state.muscleGroups.map((mg) => mg.name).filter((mg) => !NON_STRENGTH_GROUPS.includes(mg)).map((mg) => {
      const series = byMuscle[mg];
      const d = series && series.length > 1 ? Math.round(series[series.length - 1].value - 100) : null;
      return { mg, delta: d };
    }).sort((a, b) => {
      if (a.delta === null) return 1;
      if (b.delta === null) return -1;
      return b.delta - a.delta;
    });

    return `
      <h2>Strength Index</h2>
      <div class="small muted" style="margin-bottom:10px">A rough "are you moving more weight than when you started" score. It averages each lift's growth vs. its own baseline (the best of its first two days, per variation), so exercises at very different weights can be compared fairly.</div>
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
            <span class="small" style="width:78px">${esc(b.mg)}</span>
            <div class="bar-track"><div class="bar-fill" style="width:${b.delta === null ? 0 : Math.min(100, Math.abs(b.delta) * 2)}%;background:${b.delta === null ? "var(--border)" : b.delta >= 0 ? "var(--good)" : "var(--bad)"}"></div></div>
            <span class="pill ${b.delta === null ? "" : b.delta >= 0 ? "good" : "bad"}">${b.delta === null ? "No data" : (b.delta >= 0 ? "+" : "") + b.delta + "%"}</span>
          </div>
        `).join("")}
      </div>
    `;
  }

  function storageReadoutHTML() {
    const st = state.storage;
    if (!st || !st.quota) return "";
    const pct = Math.min(100, (st.usage / st.quota) * 100);
    const pill = st.persisted === true
      ? `<span class="pill good">Protected</span>`
      : st.persisted === false
        ? `<span class="pill warn">Not protected</span>`
        : "";
    const note = st.persisted === false
      ? `<div class="small muted" style="margin-top:6px">The browser may clear this data if the phone runs low on space. Installing to your home screen usually grants protection.</div>`
      : "";
    return `
      <div style="margin-bottom:12px">
        <div class="row" style="align-items:center;margin-bottom:6px">
          <span class="small">Storage used</span>
          <span style="display:flex;align-items:center;gap:8px">
            <span class="small muted">${formatBytes(st.usage)} of ${formatBytes(st.quota)}</span>
            ${pill}
          </span>
        </div>
        <div class="rotation-item" style="padding:0">
          <div class="bar-track"><div class="bar-fill" style="width:${pct.toFixed(2)}%;background:var(--accent)"></div></div>
        </div>
        ${note}
      </div>`;
  }

  function viewSettings() {
    return `
      <div class="view">
        <div class="card">
          <h2>Muscle groups</h2>
          <div class="small muted" style="margin-bottom:8px">Pick which muscle groups you want to track and how many times per week you're aiming to train each. Rotation and the Strength Index are both built from this list.</div>
          ${state.muscleGroups.length === 0 ? `<div class="empty">No muscle groups yet. Add your first below.</div>` : `
          <div style="margin-bottom:12px">
            ${state.muscleGroups.map((mg) => `
              <div class="row" style="align-items:center">
                <span style="display:flex;align-items:center;gap:8px"><span style="width:10px;height:10px;border-radius:50%;background:${mg.color};display:inline-block;flex-shrink:0"></span>${esc(mg.name)}</span>
                <span style="display:flex;align-items:center;gap:8px">
                  <input type="number" inputmode="numeric" min="1" max="14" value="${mg.frequency}" data-muscle-freq="${mg.id}" style="width:56px" />
                  <span class="small muted">x/wk</span>
                  <button class="btn sm danger" data-del-muscle="${mg.id}">Delete</button>
                </span>
              </div>
            `).join("")}
          </div>`}
          <div class="row" style="gap:6px">
            <input type="text" id="new-muscle-name" placeholder="e.g. Forearms" maxlength="30" style="flex:1" />
            <input type="number" inputmode="numeric" id="new-muscle-freq" placeholder="x/wk" value="2" min="1" max="14" style="width:64px" />
            <button class="btn primary sm" id="add-muscle-btn">Add</button>
          </div>
        </div>

        <div class="card">
          <h2>Exercise library</h2>
          <div class="small muted" style="margin-bottom:8px">Your own library. Each exercise has muscle groups, optional variations (attachments, grips, one/two-handed). Variations track their own last-time and best numbers.</div>
          ${state.exercises.length === 0 ? `<div class="empty">No exercises yet. Add your first below.</div>` : `
          <div style="max-height:320px;overflow:auto;margin-bottom:12px">
            ${state.exercises.map((ex) => `
              <div class="row">
                <div><div>${esc(ex.name)}</div><div class="small muted">${esc(ex.muscleGroups.join(", "))}${ex.variations && ex.variations.length ? ` · ${esc(ex.variations.join(" / "))}` : ""}${(ex.metric || DEFAULT_METRIC) !== "weight_reps" ? ` · ${metricLabel(ex.metric)}` : ""}</div></div>
                <div class="btn-row" style="flex-wrap:nowrap;flex-shrink:0">
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
          <div class="small muted" style="margin-bottom:10px">Everything (sessions, lifts, body weight and muscle groups) is stored only on this device. Export a backup regularly, or use export/import to move data to another phone - and later, to a shared setup if friends join in.</div>
          ${storageReadoutHTML()}
          <div class="btn-row">
            <button class="btn" id="export-data">Export backup (.json)</button>
            <button class="btn" id="import-data-btn">Import backup</button>
          </div>
          <input type="file" id="import-file-input" accept="application/json" style="display:none" />
          <button class="btn danger block" style="margin-top:10px" id="clear-all-data">Erase all data</button>
        </div>

        <div class="card">
          <h2>About</h2>
          <div class="small muted">Custom Fit v2.0 · local-only storage on this device (IndexedDB). Install to your home screen for the full-screen app feel. See the README for how.</div>
        </div>
      </div>
    `;
  }

  function customExerciseForm() {
    const editing = editingExerciseId !== null;
    return `
      <div class="card" style="margin-top:10px">
        <h2>${editing ? "Edit exercise" : "New exercise"}${trainFormOpen ? ` <span class="link" data-close-add>Close</span>` : ""}</h2>
        ${trainFormOpen ? `<div class="small muted" style="margin-bottom:8px">Saved to your library and added to this workout.</div>` : ""}
        <div class="field">
          <label>Exercise name</label>
          <input type="text" id="new-exercise-name" placeholder="e.g. Tricep Pushdown" maxlength="60" value="${esc(formNameValue)}" />
        </div>
        <div class="field">
          <label>Track by</label>
          <div class="chip-row" id="new-exercise-metric">
            ${Object.keys(METRIC_TYPES).map((key) => `<span class="chip${formMetric === key ? " selected" : ""}" data-metric="${key}">${METRIC_TYPES[key].label}</span>`).join("")}
          </div>
        </div>
        <div class="field">
          <label>Muscle group(s)</label>
          ${state.muscleGroups.length === 0 ? `<div class="small muted">No muscle groups yet. Add some in Settings first.</div>` : `
          <div class="chip-row" id="new-exercise-muscles">
            ${Array.from(new Set(state.muscleGroups.map((mg) => mg.name).concat(selectedMuscles))).map((name) => `<span class="chip${selectedMuscles.includes(name) ? " selected" : ""}" data-muscle="${esc(name)}">${esc(name)}</span>`).join("")}
          </div>`}
        </div>
        <div class="field">
          <label>Variations (optional): attachments, grips, one/two-handed</label>
          ${formVariations.length ? `<div class="chip-row" style="margin-bottom:6px">
            ${formVariations.map((vName, i) => `<span class="chip selected" data-remove-variation="${i}">${esc(vName)} ✕</span>`).join("")}
          </div>` : ""}
          <div class="row" style="gap:6px">
            <input type="text" id="new-variation-input" placeholder="e.g. Straight bar, Rope, One-handed" maxlength="30" />
            <button class="btn sm" id="add-variation-btn">Add</button>
          </div>
        </div>
        <button class="btn primary block" id="save-new-exercise">${editing ? "Save changes" : "Add exercise"}</button>
      </div>
    `;
  }

  // -----------------------------------------------------------------------
  // Root render
  // -----------------------------------------------------------------------
  const titles = { home: "Custom Fit", train: "Log Workout", progress: "Progress", weight: "Body Weight", settings: "Settings" };

  function render() {
    let body;
    if (state.route === "home") body = viewHome();
    else if (state.route === "train") body = viewTrain();
    else if (state.route === "progress") body = viewProgress();
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

  function resetExerciseForm() {
    selectedMuscles = [];
    formVariations = [];
    formNameValue = "";
    formMetric = DEFAULT_METRIC;
    editingExerciseId = null;
  }

  // Inputs live inside the re-rendered form, so capture the name before any
  // re-render that would wipe it.
  function captureFormName() {
    const el = document.getElementById("new-exercise-name");
    if (el) formNameValue = el.value;
  }

  // The exercise form can live in Settings or inside the Train add panel -
  // re-render whichever holder is active.
  function renderExerciseForm() {
    if (trainFormOpen) renderAddPanel();
    else renderSettingsExtra();
  }

  // One click at a time: most handlers below await IndexedDB, and a quick
  // double-tap on Add/Save used to run the handler twice and create
  // duplicate exercises or muscle groups.
  // The guard releases itself after 5s regardless, so a handler stuck on a
  // promise that never settles can't lock every button until reload.
  let clickBusySince = 0;
  appEl.addEventListener("click", async (e) => {
    if (clickBusySince && Date.now() - clickBusySince < 5000) return;
    clickBusySince = Date.now();
    try {
      await handleClick(e);
    } catch (err) {
      // A failed IndexedDB call (e.g. the connection was closed by a version
      // change in another tab) used to fail with nothing on screen.
      console.error(err);
      toast("Something went wrong. Try again, or reload the app");
    } finally {
      clickBusySince = 0;
    }
  });

  async function handleClick(e) {
    const t = e.target;
    captureFormName(); // any click may re-render; never lose what's typed in the exercise form

    const navBtn = t.closest("[data-nav]");
    if (navBtn) { navTo(navBtn.dataset.nav); return; }

    if (t.closest("[data-back-progress]")) { state.progressDetail = null; render(); return; }
    if (t.closest("[data-view-exercise]")) { state.progressDetail = t.closest("[data-view-exercise]").dataset.viewExercise; render(); return; }

    const rangeBtn = t.closest("[data-weight-range]");
    if (rangeBtn) { state.weightRange = rangeBtn.dataset.weightRange; render(); return; }

    const restBtn = t.closest("[data-rest]");
    if (restBtn) { startRest(Number(restBtn.dataset.rest)); return; }

    // Body weight
    if (t.id === "save-bodyweight") {
      const val = readPositive(document.getElementById("bodyweight-input"), BODYWEIGHT_MAX, "Weight");
      if (val === null) return;
      await Repo.setBodyweight(todayStr(), val);
      state.bodyweight = await Repo.listBodyweight();
      render();
      toast("Weight logged");
      return;
    }
    if (t.id === "save-weight-goal") {
      const input = document.getElementById("weight-goal-input");
      // A number input reports text like "abc" as an empty value plus
      // badInput - don't mistake that for a deliberate clear.
      if (input.validity && input.validity.badInput) { toast("Goal: enter a number"); return; }
      if (input.value.trim() === "") {
        await Repo.setSetting("weightGoal", null);
        state.weightGoal = null;
        render();
        toast("Goal cleared");
        return;
      }
      const val = readPositive(input, BODYWEIGHT_MAX, "Goal");
      if (val === null) return;
      await Repo.setSetting("weightGoal", val);
      state.weightGoal = val;
      render();
      toast("Goal updated");
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
      persistActiveSession();
      render();
      return;
    }
    if (t.id === "discard-session") {
      if (confirm("Discard this workout? Nothing will be saved.")) {
        state.activeSession = null;
        persistActiveSession();
        addExerciseOpen = false;
        stopRest(true);
        render();
      }
      return;
    }
    if (t.id === "finish-session") {
      const active = state.activeSession;
      if (active.entries.length === 0) { toast("Add at least one exercise first"); return; }
      // Build the session to save as a copy: blank sets are dropped, and an
      // exercise with no logged sets is dropped with them - an "I meant to"
      // entry would otherwise count as training that muscle in the rotation.
      // The in-memory draft is left untouched so a refused finish loses nothing.
      const hasValue = (set) => Object.values(set).some((v) => v);
      const entries = active.entries
        .map((entry) => Object.assign({}, entry, { sets: entry.sets.filter(hasValue) }))
        .filter((entry) => entry.sets.length > 0);
      if (entries.length === 0) { toast("Log at least one set first"); return; }
      const skipped = active.entries.length - entries.length;
      const session = Object.assign({}, active, { entries, endedAt: Date.now() });
      stopRest(true);
      const bestBefore = bestSetsByVariation(state.sessions);
      await Repo.saveSession(session);
      state.sessions = await Repo.listSessions();
      const bestAfter = bestSetsByVariation(state.sessions);
      let prCount = 0;
      for (const key in bestAfter) {
        if (!bestBefore[key] || bestAfter[key].orm > bestBefore[key].orm) prCount++;
      }
      state.activeSession = null;
      persistActiveSession();
      addExerciseOpen = false;
      render();
      let msg = "Session saved";
      if (prCount > 0) msg += `: ${prCount} new PR${prCount > 1 ? "s" : ""}!`;
      if (skipped > 0) msg += ` (${skipped} exercise${skipped > 1 ? "s" : ""} with no sets skipped)`;
      toast(msg, prCount > 0);
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
      persistActiveSession();
      render();
      return;
    }
    const addSet = t.closest("[data-add-set]");
    if (addSet) {
      // A new set starts blank (Sam's preference) - the previous session's
      // numbers still show as placeholders for reference, but nothing is
      // pre-filled that could be saved by accident.
      const entry = state.activeSession.entries[Number(addSet.dataset.addSet)];
      entry.sets.push(emptySet(entry.metric || DEFAULT_METRIC));
      persistActiveSession();
      render();
      return;
    }
    const remSet = t.closest("[data-remove-set]");
    if (remSet) {
      const [ei, si] = remSet.dataset.removeSet.split(":").map(Number);
      const entry = state.activeSession.entries[ei];
      entry.sets.splice(si, 1);
      if (entry.sets.length === 0) entry.sets.push(emptySet(entry.metric || DEFAULT_METRIC));
      persistActiveSession();
      render();
      return;
    }

    // Settings: muscle groups
    if (t.id === "add-muscle-btn") {
      const nameInput = document.getElementById("new-muscle-name");
      const freqInput = document.getElementById("new-muscle-freq");
      const name = nameInput.value.trim();
      const frequency = clampFrequency(freqInput.value);
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
      trainFormOpen = false;
      resetExerciseForm();
      renderSettingsExtra();
      return;
    }
    const editEx = t.closest("[data-edit-exercise]");
    if (editEx) {
      const ex = state.exercises.find((x) => x.id === editEx.dataset.editExercise);
      if (ex) {
        trainFormOpen = false;
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
      const existing = editingExerciseId ? state.exercises.find((x) => x.id === editingExerciseId) : null;
      // Refuse a name another exercise already has - but not when an edit
      // keeps its own name (an imported duplicate would otherwise be uneditable).
      const renamed = !existing || existing.name.toLowerCase() !== name.toLowerCase();
      if (renamed && state.exercises.some((x) => x.id !== editingExerciseId && x.name.toLowerCase() === name.toLowerCase())) {
        toast("Already in your library"); return;
      }
      let exerciseId;
      if (editingExerciseId) {
        if (!existing) {
          // Deleted (or erased) while the edit form was open
          toast("That exercise no longer exists");
          customExerciseOpen = false; trainFormOpen = false; resetExerciseForm(); render();
          return;
        }
        await Repo.updateExercise(Object.assign({}, existing, {
          name, muscleGroups: selectedMuscles.slice(), variations: formVariations.slice(), metric: formMetric
        }));
        exerciseId = editingExerciseId;
      } else {
        exerciseId = await Repo.addExercise(name, selectedMuscles.slice(), formVariations.slice(), formMetric);
      }
      state.exercises = await Repo.listExercises();
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
          toast("Added to library. Pick a variation to add it");
        } else if (newEx) {
          addEntryToSession(newEx, "");
          toast("Added to library + workout");
        }
        return;
      }
      render();
      toast(wasEditing ? "Exercise updated" : "Exercise added");
      return;
    }
    const delEx = t.closest("[data-del-exercise]");
    if (delEx) {
      if (confirm("Delete this exercise? Past sessions keep their logged history.")) {
        if (editingExerciseId === delEx.dataset.delExercise) { customExerciseOpen = false; resetExerciseForm(); }
        await Repo.deleteExercise(delEx.dataset.delExercise);
        state.exercises = await Repo.listExercises();
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
      a.download = `custom-fit-backup-${todayStr()}.json`;
      document.body.appendChild(a); // Firefox needs it in the DOM to honour download=
      a.click();
      a.remove();
      // Revoking synchronously can cancel the download on iOS Safari - give it a moment.
      setTimeout(() => URL.revokeObjectURL(url), 10000);
      return;
    }
    if (t.id === "import-data-btn") { document.getElementById("import-file-input").click(); return; }
    if (t.id === "clear-all-data") {
      if (confirm("This erases ALL local data (sessions, body weight, custom exercises). This cannot be undone. Continue?")) {
        await Repo.clearAll();
        // Everything in memory referred to data that no longer exists
        state.activeSession = null;
        addExerciseOpen = false; pickingVariationFor = null; trainFormOpen = false; customExerciseOpen = false;
        resetExerciseForm();
        stopRest(true);
        await loadAll();
        render();
        toast("All data cleared");
      }
      return;
    }
  }

  // input listeners (change, not click) - set weight/reps and file import
  appEl.addEventListener("change", async (e) => {
    try { await handleChange(e); } catch (err) { console.error(err); toast("Something went wrong. Try again, or reload the app"); }
  });

  async function handleChange(e) {
    const t = e.target;
    const freqInput = t.closest("[data-muscle-freq]");
    if (freqInput) {
      const mg = state.muscleGroups.find((m) => m.id === freqInput.dataset.muscleFreq);
      const frequency = freqInput.value.trim() === "" && mg ? mg.frequency : clampFrequency(freqInput.value);
      freqInput.value = frequency; // show what was actually saved
      if (mg) {
        await Repo.updateMuscleGroup(Object.assign({}, mg, { frequency }));
        state.muscleGroups = await Repo.listMuscleGroups();
      }
      return;
    }
    if (t.id === "import-file-input" && t.files[0]) {
      const file = t.files[0];
      t.value = ""; // so picking the same file again still fires change
      try {
        const data = JSON.parse(await file.text());
        const r = await Repo.importAll(data);
        await loadAll();
        render();
        const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
        const parts = [];
        if (r.sessions) parts.push(plural(r.sessions, "session"));
        if (r.exercises) parts.push(plural(r.exercises, "exercise"));
        if (r.bodyweight) parts.push(plural(r.bodyweight, "weigh-in"));
        if (r.muscleGroups) parts.push(plural(r.muscleGroups, "muscle group"));
        if (r.updatedGroups) parts.push(plural(r.updatedGroups, "muscle group") + " updated");
        if (r.settings) parts.push("settings");
        toast(parts.length ? "Imported " + parts.join(", ") : "Nothing new in that backup");
      } catch (err) {
        toast(err && /not a Custom Fit backup/.test(err.message) ? "Import failed: not a Custom Fit backup" : "Import failed: invalid file");
      }
      return;
    }
    const setField = t.closest("[data-set-field]");
    if (setField) {
      const problem = applySetField(setField);
      if (problem) { setField.value = ""; toast(problem); }
      return;
    }
  }

  // live updates: exercise search filter, and set inputs (see applySetField)
  appEl.addEventListener("input", (e) => {
    if (e.target.id === "exercise-search") {
      pickerSearch = e.target.value;
      const listEl = document.getElementById("exercise-list");
      if (listEl) listEl.innerHTML = exerciseListHTML();
      return;
    }
    const setField = e.target.closest("[data-set-field]");
    if (setField) applySetField(setField);
  });

  function addEntryToSession(ex, variation) {
    const metric = ex.metric || DEFAULT_METRIC;
    state.activeSession.entries.push({
      exerciseId: ex.id, exerciseName: ex.name, muscleGroups: ex.muscleGroups,
      variation: variation || "", metric, sets: [emptySet(metric)]
    });
    persistActiveSession();
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
    try {
      await Repo.init();
      await loadAll();
      // Resume a workout that was in progress when the page last unloaded -
      // after the same shape checks as a stored session, so a corrupt draft
      // can't come back as "Invalid Date / NaN min".
      const draft = Repo.tidySession(await Repo.getSetting(ACTIVE_SESSION_KEY, null));
      if (draft) {
        draft.entries.forEach((entry) => { if (entry.sets.length === 0) entry.sets.push(emptySet(entry.metric)); });
        state.activeSession = draft;
      }
      render();
    } catch (err) {
      // Without this the app would sit on "Loading…" forever (e.g. IndexedDB
      // blocked in some private-browsing modes, or a failed upgrade).
      appEl.innerHTML = `<div class="empty" style="padding-top:60px">Couldn't load the app.<br><span class="small">${esc(err && err.message ? err.message : err)}</span><br><br>If you're in private browsing, try a normal tab. Otherwise reload, and if it keeps happening, restore from a backup after Erase all data.</div>`;
      return;
    }

    if ("serviceWorker" in navigator) {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    }

    // Ask the browser to protect our data from eviction, then measure usage.
    // Neither blocks the first paint - Settings re-renders once we know.
    if (navigator.storage && navigator.storage.persist) {
      await navigator.storage.persist().catch(() => {});
    }
    await refreshStorageInfo();
    if (state.route === "settings") render();
  }

  boot();
})();
