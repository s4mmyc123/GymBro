# Custom Fit

Local-first gym tracker PWA. Plain HTML, CSS and JS with no build step; one
`app.js` holds the data layer (the `Repo` object is the only code that
touches IndexedDB), the views, and the rotation, PR and Strength Index
logic. See README.md for what the app does.

## Working rules

- Any change to how the app looks or feels follows DESIGN.md. Read it
  before touching `styles.css` or view code, and run its section 10
  checklist before committing.
- Never use long dashes in app text, comments, or docs.
- Every user-facing change gets a numbered section in CHANGES.md, dated,
  in plain language.
- Bump the `CACHE` name in `sw.js` whenever `app.js`, `styles.css`,
  `index.html` or `manifest.json` change, or installed phones keep the old
  files.
- Run it with `serve.ps1` (port 8080) and check at 375px wide; that is the
  real target.
- Commit messages: one line saying what changed for the user, then
  "CHANGES.md section N." when there is one.
