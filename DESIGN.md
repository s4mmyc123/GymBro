# Custom Fit UI rules

Rules for any change to how the app looks or feels. They exist so that every
screen, whoever or whatever builds it, reads as one app. Where a rule cites a
number, that number came from measuring the app as it stood on 16 Sep 2026.

The app's job: log a workout in the gym with one thumb, then answer "am I
getting stronger?" in one glance. Every rule below serves that.

## 0. Direction: quiet modern

The look to build toward. Sleek, modern and simple: precision, material
and restraint rather than ornament. The old look (rounded cards, coloured
badges on everything) is what we are leaving. Decided on 23 Sep 2026:
Graphite is the palette, the Home structure is `mockups/13-home-structure.html`
(wordmark title with the date under it and a logo placeholder top right;
This week, Body weight, Muscle rotation with day ticks; no history list).

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
- **Air is the point.** More space between things than feels necessary
  on a first pass. If a screen looks empty, it is probably right.
- **One accent, rarely.** The accent appears on the single primary action
  and on your data line. Nothing else carries it. The one exception is
  the start buttons (Start workout and Resume workout on Home, Start new
  session on Train), which stay green: starting a workout is the app's
  main verb and has always been green.
- **Themes, not skins.** The user chooses between a few palettes in
  Settings. Each is the same nine tokens with different values; nothing
  else changes. See section 5.

The simplicity rules in section 1 are unchanged. Modern never adds a
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

## 5. Colour and themes

The user picks a theme in Settings. A theme is nothing more than a set of
values for the nine colour tokens below; layout, type and components never
change between themes, and no code outside `:root` knows which theme is
active. That is the whole point of the token rule.

Tokens every theme must define: bg, surface, hairline, text, text-dim,
accent, good, warn, bad. Text on the accent is always bg.

Three themes ship. Graphite is the default. Measured contrast on each
theme's bg is in brackets.

| Token    | Graphite (warm dark) | Onyx (true black)   | Ivory (light)        |
|----------|----------------------|---------------------|----------------------|
| bg       | #0e0d0c              | #000000             | #f4f1ec              |
| surface  | #161514              | #121212             | #ffffff              |
| hairline | #2a2826              | #262626             | #dcd6cc              |
| text     | #efeae2 (16.2)       | #f2f2f2 (18.8)      | #1a1816 (15.7)       |
| text-dim | #9a948b (6.5)        | #9b9b9b (7.6)       | #6b655d (5.1)        |
| accent   | #e08a3c copper (7.3) | #d9d4c7 platinum (14.2) | #a8561a copper (4.7) |
| good     | #7cc49a (9.5)        | #8fcfa6 (11.6)      | #2a7348 (4.9)        |
| warn     | #d9b256 (9.7)        | #dcc26a (12.0)      | #7a5e0e (4.9)        |
| bad      | #e07070 (6.2)        | #e27b7b (7.4)       | #b4373a (5.3)        |

Rules that hold in every theme:

- Status colours are used on text and thin bars only, never as fills or
  backgrounds. Anything new must stay above 4.5:1 for text and 3:1 for
  icons and chart lines, in every theme, not just the default.
- The accent appears on the primary action and your data line only.
- Adding a theme means adding one block of nine values and a swatch in the
  picker, nothing else. If a theme needs a code change elsewhere, the code
  is wrong, not the theme.
- The choice is saved as a setting, applied as `data-theme` on the root
  element before first paint so there is no flash, mirrored into the
  `theme-color` meta tag so the phone's status bar matches, and included
  in backups like the weight goal. `color-scheme` follows the theme so
  native controls match.
- Every UI change is screenshotted in all three themes. Ivory is the one
  that finds mistakes: any hard-coded dark value shows up there at once.

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
- Bottom nav: hairline above, the five icons with small uppercase labels,
  active one in the accent with a short 2px line under it, inactive in
  text-dim.
- Screen header: the screen name as a light 28px wordmark, the date (and
  on Home the greeting) as a label under it, a 40px logo box top right.
- Rotation row (Home): name with its weekly target under it, seven ticks
  (one lit per day since last trained, all seven for never), and the
  status word in its colour.
- Theme picker (Settings): one row of square swatches, one per theme, the
  chosen one outlined in text colour. Tapping applies it immediately.

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
3. Build it, then screenshot before and after at 375px wide, in every
   theme, and compare.
4. Check: no new hex values, no new font sizes, no new inline styles, no
   new component that is not in section 6, no rounded corner, no badge.
5. One screen per commit, a CHANGES.md entry, and a service worker cache
   bump when app.js or styles.css changed.
