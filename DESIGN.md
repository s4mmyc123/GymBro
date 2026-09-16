# Custom Fit UI rules

Rules for any change to how the app looks or feels. They exist so that every
screen, whoever or whatever builds it, reads as one app. Where a rule cites a
number, that number came from measuring the app as it stood on 16 Sep 2026.

The app's job: log a workout in the gym with one thumb, then answer "am I
getting stronger?" in one glance. Every rule below serves that.

## 0. Direction: quiet luxury

The look to build toward. Sleek and modern, and it should feel expensive
the way a good watch does: through precision, material and restraint, not
through ornament. The old look (rounded cards, coloured badges on
everything) is what we are leaving.

- **Flat, not boxed.** Content sits directly on the screen in sections
  divided by hairlines and space. No card boxes. The only raised surface
  is the bottom sheet.
- **Sharp geometry.** Corners are square. The only exception is a 2px
  radius on buttons and inputs so they don't look like a bug.
- **Numbers are the ornament.** Large, light-weight numerals are the one
  expressive element. Everything else is quiet.
- **Status is text, not badges.** A change reads "+33%" in green text
  beside its label, not inside a coloured pill. Rotation status is a thin
  bar and a plain word.
- **Air is the luxury.** More space between things than feels necessary
  on a first pass. If a screen looks empty, it is probably right.
- **One accent, rarely.** The accent appears on the single primary action
  and on your data line. Nothing else is orange.

The simplicity rules in section 1 are unchanged. Luxury never adds a
control; it removes one.

## 1. Simplicity comes first

- One job per screen, one primary action per screen, and it sits in the
  thumb zone (lower half). Everything else is secondary.
- Show a number before a chart, a chart before a list. If the chart already
  says it, the list goes (Records and the exercise detail follow this).
- Remove before adding. A new element must earn its place by answering a
  question the user actually has in the gym or on the sofa afterwards.
- No feature is worth a second row of controls. If a screen needs two rows
  of chips or two toolbars, the screen is doing two jobs.
- Explanations live behind the small "i" in a section title, never inline.

## 2. Tokens, not values

- Every colour, radius, and spacing step comes from the variables in
  `styles.css` `:root`. No hex or rgba values anywhere else. Today there are
  about 20 hard-coded colours outside `:root` (tints of the accent, the
  Strength Index purple, text-on-accent); the overhaul folds each into a
  named token.
- Muscle groups have no colour of their own. Rotation bars are coloured by
  status (good, due, overdue), never by which group they are.
- No inline `style=""` in `app.js` for anything reusable. There are 89 today.
  A one-off alignment tweak is fine; a font size, colour, or spacing is not.

## 3. Type

Two faces. A display face for numbers, light weight, tabular figures, used
at hero and stat size only. The system font for everything else, so body
text stays native and instant. The display face ships as one self-hosted
woff2 that the service worker caches. Candidates: Inter Tight Light,
Manrope Light, or Outfit Light; pick one and never mix.

Six sizes only. Today 17 distinct sizes are in use, which is why nothing
lines up.

| Role     | Size   | Weight | Face    | Use                                   |
|----------|--------|--------|---------|---------------------------------------|
| hero     | 44px   | 300    | display | the one number a screen is about       |
| stat     | 24px   | 300    | display | supporting numbers                     |
| title    | 15px   | 600    | system  | section titles, screen header          |
| body     | 14px   | 400    | system  | everything readable                    |
| small    | 12.5px | 400    | system  | secondary lines                        |
| label    | 11px   | 600    | system  | eyebrows, units, axes: uppercase, letter-spacing 0.08em |

Units sit beside a hero number at label size, not inside it: a large 80
with a small KG. Chart SVG text may sit below label size because it scales
with the chart.

## 4. Space and shape

- Spacing steps: 4, 8, 16, 24, 32. Sections are separated by 32px and a
  hairline; rows inside a section by 16px.
- Radii: 0 everywhere, 2px on buttons and inputs. No pills.
- Hairlines are 1px in the hairline token, and they are the only lines.
  No borders around sections, no boxes inside sections.
- Touch targets are at least 44px tall, achieved with padding and row
  height, never by making text bigger.
- Respect the safe areas top and bottom (already done in the header and nav).

## 5. Colour

Warm near-black, off-white, one copper accent, three muted status colours.
Measured on the background:

| Token    | Hex     | Role                                | Contrast |
|----------|---------|-------------------------------------|----------|
| bg       | #0e0d0c | the screen                          |          |
| surface  | #161514 | bottom sheet, inputs                |          |
| hairline | #2a2826 | dividers                            |          |
| text     | #efeae2 | primary text                        | 16.2     |
| text-dim | #9a948b | secondary text, labels              | 6.5      |
| accent   | #e08a3c | primary action, your data line      | 7.3      |
| good     | #7cc49a | improved, on track                  | 9.5      |
| warn     | #d9b256 | due                                 | 9.7      |
| bad      | #e07070 | overdue, worse, delete              | 6.2      |

- Text on the accent is bg, not white.
- Status colours are used on text and thin bars only, never as fills or
  backgrounds. Anything new must stay above 4.5:1 for text and 3:1 for
  icons and chart lines.
- Dark only. `color-scheme: dark` stays. A light theme is a separate
  project, not a side effect of the overhaul.

## 6. Components

Build from these and nothing else. If a screen needs something new, it is
added here first, with a name.

- Section: an eyebrow label or title, content, and a hairline below.
  Optional "i" info button at the right of the title.
- Row: label left, value right, optional second line under each, 16px
  tall gap, hairline between rows.
- Hero: one display number with its unit at label size, and one line of
  context under it.
- Status text: a value coloured good, warn or bad, with no background.
- Tabs: a row of text options with a 1px underline on the active one.
  Used for ranges and variations.
- Button: primary (accent fill, bg text), secondary (hairline outline),
  danger (bad-coloured text, no fill). Full-width in sheets, inline
  elsewhere. Label in sentence case.
- Input: underline only, unit at label size on the right, no box.
- Area chart (shared by Weight and exercise detail): readout line above,
  1.5px line, faint fill, scrub guide, tick per entry, date bins below.
- Collapsible group (Records): title row with count and a thin chevron.
- Bottom sheet: the only surface, square corners, slides up.
- Empty state: one sentence saying what to do, never how it feels.
- Toast: one line, disappears on its own.
- Bottom nav: hairline above, text labels, active one in text colour with a
  1px underline, inactive in text-dim.

## 7. Motion

- One transition: opacity and transform, 200ms, ease-out. Used for the
  sheet, the toast, the info text, and chevrons only.
- No entrance animations, no parallax, no loading skeletons. The app is
  local and renders instantly; motion would only slow it down.
- Honour `prefers-reduced-motion` by disabling the above.

## 8. Copy

- Sentence case everywhere. Buttons are verbs: "Start workout", "Log",
  "Delete". The same word all the way through a flow.
- Units always shown with numbers: 80kg × 8, 4.8 km, 12 min.
- No long dashes anywhere in app text. Use a colon, a comma, or a new
  sentence.
- Empty states and errors say what to do next: "Log a session to start
  tracking lifts." Never "Nothing here yet!".
- Estimates are marked as such: "~101kg est. 1RM".

## 9. Charts

- One chart component, one look: accent line at 1.5px, a barely-there
  fill, hairline gridlines with a value label, date bins on the axis, a
  tick per entry, scrubbable.
- Best or goal is the only annotation, in good.
- Never label every point. Never add a legend; if a chart needs one, it
  has too many series.

## 10. Process for every UI change

1. Say which screen and which rule above the change serves.
2. Mock it before coding it when it changes layout, using the design
   canvas skill, and look at it at phone width.
3. Build it, then screenshot before and after at 375px wide and compare.
4. Check: no new hex values, no new font sizes, no new inline styles, no
   new component that is not in section 6, no rounded corner, no badge.
5. One screen per commit, a CHANGES.md entry, and a service worker cache
   bump when app.js or styles.css changed.
