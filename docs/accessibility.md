# Frontend accessibility

Scope: the Next.js frontend under this repo (trade, launch, portfolio,
activity, settings pages). This document does not cover protocol/backend
surfaces.

**This is not a WCAG conformance claim.** Automated tooling (axe-core)
only catches a minority of real accessibility defects -- missing alt text,
insufficient color contrast, malformed ARIA, missing form labels, bad
landmark structure. It cannot verify that a screen reader announces
content sensibly, that a complex interaction is actually usable non-
visually, or that focus behaves correctly through every possible sequence
of actions. The manual pass below is a checklist of what was actually
exercised, not an audit against every WCAG success criterion.

## Automated coverage

`tests/browser/accessibility.spec.ts` runs axe-core's `wcag2a`/`wcag2aa`/
`wcag21a`/`wcag21aa` rule sets against the trade page (signed out and
signed in), settings, activity, and portfolio. It currently passes with
zero violations across all five states. The diagnostics page (dev-only,
not linked from production nav) is not scanned.

**Fixed as part of building this**, all real, axe-detected violations, not
speculative:
- `color-contrast`: `--muted` (#65777a), `--green` (#008d70), and `--red`
  (#c94d50) each fell just under WCAG AA's 4.5:1 minimum for normal-size
  text against their typical backgrounds (4.35, 3.63, and 3.84:1
  respectively). Darkened to #556669 / #006e57 / #a83a41 -- see the
  comment above `:root` in `app/globals.css` for the exact ratios. This
  also improved (never regressed) the white-on-button contrast for the
  long/short submit buttons.

## Manual checklist

Each item below was actually exercised (in a real Chrome instance or via
a Playwright test that drives real keyboard events), not just inspected
in source and assumed to work.

| Area | Status | Notes |
|---|---|---|
| Keyboard-only login flow | ✅ Verified | `tests/browser/keyboard-only.spec.ts` tabs to "Sign in", confirms a visible focus ring, activates via Enter (no click), and confirms focus lands somewhere real afterward. |
| Focus loss on control replacement | ✅ Fixed | The topbar's Sign in / Choose wallet / wallet-address+Log out controls are mutually exclusive; activating one used to unmount it and drop focus to `<body>` with no visible indicator anywhere. `components/layout/top-bar.tsx` now moves focus to whichever control replaces the one the user just activated. Found by the keyboard-only test above (it failed before this fix). |
| Skip link | ✅ Added | `tests/browser/keyboard-only.spec.ts` confirms a "Skip to main content" link is the first focusable element on every page and moves focus into `#main-content` (not just scrolls) on activation. Previously absent -- a keyboard user had to tab through the full nav on every page load. |
| Keyboard operability of the order form | ✅ Verified | The "Preview order"/"Place order" submit button is reachable by Tab and activates via Enter (`keyboard-only.spec.ts`). |
| No non-semantic clickable elements | ✅ Checked | Grepped for `onClick` on `<div>`/`<span>` across `features/` and `components/` -- none found. Every interactive control is a real `<button>`, `<a>`, `<input>`, or ARIA `role="radio"` button (WalletSelector), all natively keyboard-operable. |
| `outline: none` without a replacement | ✅ Checked | No occurrence in `app/globals.css`. Browser default focus rings are intact everywhere; nothing suppresses them. |
| `prefers-reduced-motion` | ✅ Added | No media query existed at all; the settlement-lifecycle spinner (`.active-step` `animation: spin`) and the skip link's `top` transition ran unconditionally. Added a global override in `app/globals.css` collapsing all animation/transition durations to near-zero under `prefers-reduced-motion: reduce`. |
| Icon-only buttons have accessible names | ✅ Checked / 1 fixed | Every button with icon+text content gets its name from the visible text. One icon-only button (`LifecyclePanel`'s fee-payer top-up, `<BadgeDollarSign>` with no text) relied on `title` alone, which the HTML accname algorithm does accept but which isn't consistently exposed by all assistive tech / doesn't appear on touch. Added an explicit `aria-label` alongside it. |
| Landmark structure / heading order | ✅ Covered by automated scan | axe's `landmark-*`/`heading-order`/`page-has-heading-one` rules are included in the `wcag2a`/`wcag2aa` sets already run; no violations. Not independently re-verified with a screen reader. |
| `<html lang>` | ✅ Checked | `app/layout.tsx` sets `lang="en"`. |
| Screen-reader behavior (NVDA/VoiceOver/JAWS) | ❌ Not done | No screen reader was actually run against this app. Automated tooling and the checks above do not substitute for this -- treat everything above as "keyboard- and structure-level accessible," not "screen-reader verified." |
| Zoom / reflow to 400% | ❌ Not done | Not tested. The layout uses CSS grid with fixed-ish column widths (`.terminal-grid`, `.settings-grid`) and a single `@media (max-width: 680px)` breakpoint; behavior between those breakpoints at high browser zoom is unverified. |
| Full site keyboard sweep beyond the login/order path | ⚠️ Partial | Login, skip-link, and order-preview flows are verified end to end. Settings' wallet selector (`role="radio"` buttons), the lifecycle action buttons, and the launch-lab form were checked for semantic correctness (real `<button>`/`<input>` elements, see above) but not driven end-to-end with a dedicated keyboard-only Playwright test each. |

## Known limitations, stated plainly

- This checklist is a snapshot of one review pass, not an ongoing audit.
  Any new page or interactive control added later needs its own pass.
- The order book, market panel, and price chart are primarily visual
  (numeric tables and an SVG sparkline); no attempt was made to give them
  a meaningfully different non-visual representation beyond the table
  markup already present -- a screen-reader user gets the raw numbers,
  not a description of the shape of the book or the chart.
- "No automated violations" is a floor, not a ceiling. Treat this document
  as "here is what was actually checked and how," and re-verify before
  making any compliance claim to a third party.
