# Custom Fit UI rules

Rules for any change to how the app looks or feels. They exist so that every
screen, whoever or whatever builds it, reads as one app. Where a rule cites a
number, that number came from measuring the app as it stood on 16 Sep 2026.

The app's job: log a workout in the gym with one thumb, then answer "am I
getting stronger?" in one glance. Every rule below serves that.

## 1. Simplicity comes first

- One job per screen, one primary action per screen, and it sits in the
  thumb zone (lower half). Everything else is secondary.
- Show a number before a chart, a chart before a list. If the chart already
  says it, the list goes (Records and the exercise detail follow this).
- Remove before adding. A new element must earn its place by answering a
  question the user actually has in the gym or on the sofa afterwards.
- No feature is worth a second row of controls. If a screen needs two rows
  of chips or two toolbars, the screen is doing two jobs.

## 2. Tokens, not values

- Every colour, radius, and spacing step comes from the variables in
  `styles.css` `:root`. No hex or rgba values anywhere else. Today there are
  about 20 hard-coded colours outside `:root` (tints of the accent, the
  Strength Index purple, text-on-accent); the overhaul folds each into a
  named token.
- The muscle group palette (the colours used for group dots and bars) is
  the one exception: it is a named list in `app.js`, because it is data,
  not chrome.
- No inline `style=""` in `app.js` for anything reusable. There are 89 today.
  A one-off alignment tweak is fine; a font size, colour, or spacing is not.

## 3. Type scale

Six sizes only. Weights are 400, 600, 700, 800. Today 17 distinct sizes are
in use, which is why nothing lines up.

| Role     | Size   | Weight | Use                                    |
|----------|--------|--------|----------------------------------------|
| hero     | 30px   | 800    | the one number a screen is about        |
| stat     | 22px   | 800    | supporting numbers                      |
| title    | 16px   | 700    | card headings, screen header            |
| body     | 14px   | 400    | everything readable                     |
| small    | 12.5px | 600    | pills, chips, secondary lines           |
| caption  | 11px   | 600    | chart axes, unit labels, timestamps     |

Chart SVG text may sit below caption size because it scales with the chart.

## 4. Spacing and shape

- Spacing steps: 4, 8, 12, 16, 24. Nothing else.
- Radii: 999px for pills and chips, 12px for buttons and inputs, 16px
  (`--radius`) for cards, 20px for the bottom sheet. Nothing else.
- Cards are the only container. No nested cards, no borders inside cards
  except the 1px row divider.
- Touch targets are at least 44px tall. Chips and small buttons get that
  height from padding even when the text is small.
- Respect the safe areas top and bottom (already done in the header and nav).

## 5. Colour

- One accent (orange) and it means "act here" or "you": buttons, the active
  tab, your data line. It never decorates.
- Green, yellow and red mean good, due, and overdue or worse. They appear
  only on things that carry that meaning: rotation status, change pills,
  the best marker, delete. Never as a theme.
- Text-dim is for secondary lines, never for anything the user must read
  to act. Measured contrast on cards: text 14.5:1, text-dim 6.6:1, accent
  6.1:1, red 4.6:1. Anything new must stay above 4.5:1 for text and 3:1
  for icons and chart lines.
- Dark only. `color-scheme: dark` stays. A light theme is a separate
  project, not a side effect of the overhaul.

## 6. Components

Build from these and nothing else. If a screen needs something new, it is
added here first, with a name.

- Card, with a title row that may carry one link on the right.
- Row: label left, value right, optional second line under each.
- Pill (status) and Chip (selectable). A pill is never tappable; a chip
  always is.
- Button: primary (accent), success (green, Start Workout only), ghost,
  danger. Full-width in sheets, inline elsewhere.
- Input with its unit inside the field.
- Area chart (shared by Weight and exercise detail): readout line above,
  scrub guide, ticks per entry, date bins below.
- Collapsible group (Records): header with count and chevron.
- Bottom sheet for pickers and forms.
- Empty state: one sentence saying what to do, never how it feels.
- Toast: one line, disappears on its own.

## 7. Motion

- Transitions 150ms, ease. Used for chevrons, sheets, and toasts only.
- No entrance animations, no parallax, no loading skeletons. The app is
  local and renders instantly; motion would only slow it down.
- Honour `prefers-reduced-motion` by disabling the above.

## 8. Copy

- Sentence case everywhere. Buttons are verbs: "Start Workout", "Log",
  "Delete". The same word all the way through a flow.
- Units always shown with numbers: 80kg × 8, 4.8 km, 12 min.
- No long dashes anywhere in app text. Use a colon, a comma, or a new
  sentence.
- Empty states and errors say what to do next: "Log a session to start
  tracking lifts." Never "Nothing here yet!".
- Estimates are marked as such: "~101kg est. 1RM".

## 9. Charts

- One chart component, one look: accent line, soft area fill, hairline
  gridlines with a value label, date bins on the axis, a tick per entry,
  scrubbable.
- Best or goal is the only annotation, in green.
- Never label every point. Never add a legend; if a chart needs one, it
  has too many series.

## 10. Process for every UI change

1. Say which screen and which rule above the change serves.
2. Mock it before coding it when it changes layout, using the design
   canvas skill, and look at it at phone width.
3. Build it, then screenshot before and after at 375px wide and compare.
4. Check: no new hex values, no new font sizes, no new inline styles, no
   new component that is not in section 6.
5. One screen per commit, a CHANGES.md entry, and a service worker cache
   bump when app.js or styles.css changed.
