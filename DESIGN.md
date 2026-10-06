# split, design direction

The style direction for this app. `split-combined-spec.md` governs **density**, this file
governs **craft**, and `antislop` is the filter applied on top of both. Where craft and
density conflict, the spec wins (Spec 8.0).

Nothing here was invented. The palette, the type and the motif were extracted from
`src/routes/layout.css` and the screens that already exist, because the app already had an
identity, it just had no file saying so.

## Dials

**ENERGY 1 / RHYTHM 2 / MOTION 2 (constrained).**

- ENERGY 1, because restraint is the product's argument, not its mood. An app that competes
  by showing less cannot introduce itself loudly.
- RHYTHM 2, because the two registers are deliberate: DAILY screens (Today, Log) are calm and
  near empty, REVIEW screens are dense. That is one planned break, not varied composition
  everywhere.
- MOTION 2, constrained to navigation and state change only. No scroll reveal, no parallax,
  no entrance animation, no element that moves to announce itself.

## Who this is for

One tired person, at 11pm, on a phone, logging what they spent before sleeping. Every craft
decision answers to that. If a treatment would not survive being read half asleep in a dark
room, it does not ship.

## The mark

A dimension rule: two vertical end caps joined by a horizontal line.

- **Why:** the daily figure is a range, never a precise number. The mark is that rule, drawn.
  It states the product's whole argument before a word is read.
- **Why not the day strip:** the strip is live data on Today. A mark identical to something on
  screen that changes nightly is ambiguous.
- **Construction:** cap height 20 units, rule length 100, stroke 2.5 at a 120x40 viewbox.
  Below 24px, thicken the stroke to 3 so the caps do not merge into the rule.
- **Clear space:** one cap height on every side.
- **Colour:** `--ink` on `--ground`. Never accent coloured, never filled, never on a tint.

## Wordmark

`split`, lowercase, always. Set in `--font-ui` at the weight the surrounding text uses, with
`letter-spacing: -0.01em`.

- **Why lowercase:** the app never shouts a figure at you. A capitalised wordmark would be the
  one place it did.
- The mark and wordmark may lock up horizontally (mark, one cap height gap, wordmark) or stack.
  Neither is primary.

## Palette

Three neutrals, one accent, one counter hue. Status colours are not part of the core palette
and appear only to mark state.

| Token | Value | Role and reason |
| --- | --- | --- |
| `--ground` | `#131312` | The page. Warm near black, not pure black, so white text does not vibrate against it at night. |
| `--surface` | `#1a1a19` | Raised: inputs, chips, cards. One step only. A second elevation would imply a hierarchy this app does not have. |
| `--hairline` | `#2c2c2a` | Separation. The app separates with rules, never with shadow. |
| `--ink` | `#ffffff` | The figure, and anything you are meant to read first. |
| `--ink-secondary` | `#c3c2b7` | Supporting text. Warm, so it reads as quiet rather than disabled. |
| `--ink-muted` | `#898781` | Metadata and dormant state. |
| `--accent` | `#3987e5` | One accent, for the current item and the single most important mark on a screen. |
| `--accent-solid` | `#1f5fb0` | Filled controls carrying white text only. White on `--accent` is 3.64:1, under the 4.5:1 floor. This clears it at 6.3:1. |
| `--series-2` | `#d95926` | The counter hue, for the second series in a chart. Never decorative. |

Rules:

- **No gradient anywhere.** The app has one light source and no depth. A gradient would be
  decoration with no hierarchy to serve.
- **No shadow, no glow, no blur.** Elevation is communicated by a hairline and a surface step.
- **Accent is rationed.** One accent element per screen. If two things are accented, neither is.
- Status colours (`--status-good`, `--status-warning`, `--status-critical`) mark state only.
  They never become brand colour and never appear on a control at rest.

## Typography

System sans (`--font-ui`) for reading, system mono (`--font-mono`) for figures and labels.

- **Why system fonts:** this app is self hosted on a Mac and must load instantly on a phone
  with bad signal. A webfont is a network dependency on the screen that must never fail.
- **Figures are mono.** A number that changes length must not reflow the text around it, and
  tabular digits make two amounts comparable at a glance.
- **Eyebrow labels are mono, uppercase, letter spaced.** This is the one uppercase usage in the
  app. It marks a section label as a label, not as something to read.
- The daily figure is the largest thing on any screen, by a wide margin. It is the only
  element permitted to dominate.
- Two weights. Regular for everything, and the daily figure's lighter weight at display size.

## Motion

One rule: motion shows continuity, never arrival.

- **Navigation** uses a view transition. The active pill moves and content crossfades, so
  moving between screens reads as one surface changing rather than nine pages loading.
- **State changes** (a form opening, a row saving) may fade or slide a short distance.
- Nothing animates on first paint. Nothing loops. Nothing floats.
- **Why:** the app is used tired. Motion that draws the eye without carrying information is a
  cost paid every single night.

## Voice

Natural, educated Filipino English. Short, action led, specific.

**The headline rule.** A screen's heading is the word used in navigation. Underneath it, one
sentence naming the task. The method's philosophy belongs in the body, in help text, or
nowhere.

This is the rule that fixes the current headings. `Where the money is, and what it is waiting
on` and `Price the motivation, then choose` are the spec talking to itself. At 11pm they tell
you nothing about what the screen is for.

| Screen | Heading | Line underneath |
| --- | --- | --- |
| `/accounts` | Accounts | Update what each account holds, and move money between them. |
| `/irregulars` | Big bills | Money set aside for costs that land later. |
| `/subscriptions` | Bills and subscriptions | What renews, and what to cancel. |
| `/trips` | Trips | Plan a trip, track it, settle it. |
| `/debt` | Debt | What you owe, and how to clear it faster. |
| `/rules` | Wishlist and rules | Wants parked for 72 hours, and your own if then rules. |
| `/trends` | Trends | How your spending changed. |

Other rules:

- **No em dash** in UI copy, per antislop R-02. Use a comma, a colon, a period or brackets.
  This governs text written from here on. Existing code comments are not in scope.
- Never call a recommendation completed, or a schedule paid.
- Separate expected, reserved, recorded, paid and remaining in wording. These are different
  states and the app is wrong if it blurs them.
- Buttons name the action: `Add money`, `Record payment`, `Save trip`. Never `Submit`, never
  `Get started`.
- Empty states say what the screen is for and what to do, never `Nothing here yet`.
- English only. No Tagalog, including in hints and comments.

## The motif

The day strip: one cell per day, filled when logged, gapped when missed. It appears at the top
of Today and nowhere else.

It is the app's one piece of ornament that is also data. Keep it. Do not restyle it into a
progress bar, do not animate it, and do not reuse it as decoration on another screen, which
would cost it its meaning.

## What this direction forbids

Written down because design tooling will confidently suggest every one of these, and each is a
documented reason the app exists.

- No balance, account total, category total or precise remaining figure on Today, including
  inside forms. The daily figure is a range.
- No KPI row, stat grid, metric cards or dashboard home.
- No per category budgets, no spending donut.
- No chart on Today, ever.
- No light mode. Dark is not a style choice here: the ritual happens at 11pm in a dark room,
  and a white screen at that hour is a reason to skip the log. (Spec 8.0b.)
- No second accent colour, no third neutral step, no icon set.

If a redesign proposal breaks one of these, the proposal is wrong, not the rule.
