---
version: alpha
name: SynapseState
website: "https://github.com/adityapawar112/SynapseState"
description: >-
  The incident-safety and lifecycle governance layer for OpenFeature. The design system treats a single saturated voltage orange (Kumo Brand #ff5e1f) as the canvas itself rather than a held-in-reserve accent — the above-fold hero is a full-bleed flat orange block carrying a 56px / weight 500 display headline in warm cream #fffbf5, with a fully-rounded cream pill CTA centered beneath. Below the fold the page inverts to a warm cream and white canvas, hairline-only cards in #f0f0f0 borders, and a second editorial display moment at 56px ink #262626. Monospace metadata carries every small-caps label, countdown clock, cryptographic hash, and code strip. Product domain chips and status badges enforce solid background colors with white typography, eliminating washed-out semi-transparent fills.

seo:
  title: "SynapseState Design System — Voltage as Canvas, Editorial Grotesque Display, Monospace Metadata & Solid Domain Badges"
  metaDescription: "Machine-readable DESIGN.md for SynapseState OpenFeature incident governance portal. Full-bleed brand canvas #ff5e1f, solid domain badges with white text, binary radius scale, and dark mode."
  highlights:
    - "Voltage as canvas — Brand orange #ff5e1f fills the entire above-fold hero rather than appearing as a scarce CTA accent"
    - "Editorial display in sans — 56px display at weight 500 with -1.4px tracking reads like a technical publication dek, not an enterprise SaaS hero"
    - "Monospace as supporting voice — Monospace metadata carries all small-caps labels, countdown clocks, hashes, and code strips"
    - "Solid domain colors with white text — Status chips and product domain badges use 100% solid color fills with crisp white #ffffff text, eliminating semi-transparent washes"
    - "Five product-domain colors — Compute #0a95ff, Storage #ee0ddb, AI #00bd7d, SASE #0d9488, plus Brand Orange #ff5e1f"
    - "Binary radius scale — 3px–8px small-step rounding for structural chrome plus 9999px full pill for interactive CTAs; no 12/16/20px middle tier"
    - "Zero drop-shadow elevation — Depth is achieved purely through hairline borders (#f0f0f0 light, #2a2a2e dark) and surface contrast"

colors:
  kumo-brand: "#ff5e1f"
  kumo-brand-hover: "#ff7038"
  kumo-brand-soft: "#ff9650"
  kumo-brand-dark: "#d63c01"
  emergency-red: "#ed1641"
  under-attack: "#b52932"
  cream: "#fffbf5"
  canvas: "#ffffff"
  ink: "#262626"
  ink-soft: "#414040"
  muted: "#727272"
  nav-muted: "#6a6967"
  hairline: "#f0f0f0"
  compute: "#0a95ff"
  storage: "#ee0ddb"
  ai: "#00bd7d"
  sase: "#0d9488"
  selection-bg: "#c82800"
  shadow: "#000000"
  dark-bg-base: "#0d0d0f"
  dark-canvas: "#1b1b1e"
  dark-cream: "#141416"
  dark-hairline: "#2a2a2e"
  dark-ink: "#f4f4f6"

typography:
  display-xl:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: 56px
    fontWeight: 500
    lineHeight: 56px
    letterSpacing: "-1.4px"
  display-lg:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: 48px
    fontWeight: 500
    lineHeight: 48px
    letterSpacing: "-1.2px"
  heading-md:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: 19.2px
    fontWeight: 400
    lineHeight: 23px
    letterSpacing: "-0.48px"
  heading-sm:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: 18px
    fontWeight: 500
    lineHeight: 21.6px
    letterSpacing: "-0.45px"
  body-md:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: 16px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: "-0.04px"
  body-sm:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: 14px
    fontWeight: 400
    lineHeight: 16.1px
    letterSpacing: "-0.14px"
  button-md:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: 16px
    fontWeight: 500
    lineHeight: 24px
    letterSpacing: "-0.16px"
  nav-link:
    fontFamily: '"Inter", -apple-system, BlinkMacSystemFont, sans-serif'
    fontSize: 14px
    fontWeight: 500
    lineHeight: 24px
    letterSpacing: 0
  mono-md:
    fontFamily: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace'
    fontSize: 14px
    fontWeight: 400
    lineHeight: 20px
    letterSpacing: 0
  mono-sm:
    fontFamily: '"JetBrains Mono", "IBM Plex Mono", ui-monospace, monospace'
    fontSize: 11px
    fontWeight: 600
    lineHeight: 16px
    letterSpacing: "0.05em"

rounded:
  none: "0px"
  xs: "3px"
  sm: "4px"
  md: "6px"
  lg: "8px"
  full: "9999px"

spacing:
  xs: "4px"
  sm: "6px"
  base: "8px"
  md: "12px"
  lg: "16px"
  xl: "24px"
  2xl: "32px"
  3xl: "40px"

components:
  hero-section:
    backgroundColor: "{colors.kumo-brand}"
    textColor: "{colors.cream}"
    typography: "{typography.display-xl}"
    rounded: "{rounded.none}"
    padding: "72px 24px 64px 24px"
  hero-heading:
    backgroundColor: transparent
    textColor: "{colors.cream}"
    typography: "{typography.display-xl}"
  section-heading:
    backgroundColor: transparent
    textColor: "{colors.ink}"
    typography: "{typography.display-xl}"
  body-paragraph:
    backgroundColor: transparent
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
  body-paragraph-muted:
    backgroundColor: transparent
    textColor: "{colors.muted}"
    typography: "{typography.body-md}"
  mono-caption:
    backgroundColor: transparent
    textColor: "{colors.muted}"
    typography: "{typography.mono-sm}"
  button-primary:
    backgroundColor: "{colors.cream}"
    textColor: "{colors.ink}"
    typography: "{typography.button-md}"
    rounded: "{rounded.full}"
    padding: "12px 24px"
    height: 46px
    border: "0"
  button-primary-hover:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.kumo-brand}"
    typography: "{typography.button-md}"
    rounded: "{rounded.full}"
    padding: "12px 24px"
    height: 46px
  button-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.button-md}"
    rounded: "{rounded.md}"
    padding: "8px 14px"
    height: 40px
    borderColor: "{colors.hairline}"
  top-nav:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.nav-link}"
    rounded: "{rounded.none}"
    padding: "0 24px"
    height: 64px
    borderBottom: "1px solid {colors.hairline}"
  nav-link:
    backgroundColor: transparent
    textColor: "{colors.nav-muted}"
    typography: "{typography.nav-link}"
    rounded: "{rounded.md}"
    padding: "6px 12px"
    height: 36px
  under-attack-link:
    backgroundColor: transparent
    textColor: "{colors.under-attack}"
    typography: "{typography.mono-sm}"
    textTransform: "uppercase"
  card-hairline:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.lg}"
    padding: "24px"
    borderColor: "{colors.hairline}"
  card-orange:
    backgroundColor: "{colors.kumo-brand}"
    textColor: "{colors.cream}"
    typography: "{typography.display-lg}"
    rounded: "{rounded.lg}"
    padding: "32px"
  category-tab:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.button-md}"
    rounded: "{rounded.full}"
    padding: "8px 16px"
    height: 36px
    borderColor: "{colors.hairline}"
  category-tab-active:
    backgroundColor: "{colors.kumo-brand}"
    textColor: "{colors.cream}"
    typography: "{typography.button-md}"
    rounded: "{rounded.full}"
    padding: "8px 16px"
    height: 36px
    border: "0"
  badge-solid:
    rounded: "{rounded.full}"
    padding: "3px 10px"
    textColor: "#ffffff"
    typography: "{typography.mono-sm}"
    border: "none"
  text-input:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.xs}"
    padding: "10px 14px"
    height: 40px
    borderColor: "{colors.hairline}"
---

# SynapseState Design System Specification

## 1. Architectural Mission & Invariants

SynapseState provides a cryptographic incident-safety and lifecycle governance layer for OpenFeature. Its user interface is built to reflect the high-assurance reliability of mission-critical systems:

1. **Voltage as Canvas:** Saturated Brand Orange (`#ff5e1f`) serves as the entire above-fold canvas, establishing instant authority during emergency incident triage.
2. **Solid Badges & White Text:** Status chips, role pills, and subsystem domain tags strictly use **100% solid color fills** with crisp `#ffffff` text. Washed-out, low-contrast semi-transparent fills (`rgba(...)`) are explicitly prohibited.
3. **Dual Typographic Voice:** Spoken content uses contemporary sans-serif at weight 500 with tight tracking (`-1.4px` on display sizes); annotated metadata, cryptographic hashes, countdown timers, and CLI syntax use monospace typography.
4. **Binary Radius Scale:** Small-step rounding (`3px`, `4px`, `6px`, `8px`) for inputs and structural card surfaces; maximum pill radius (`9999px`) for interactive CTAs, filter tabs, and status badges.
5. **Hairline Elevation:** Zero drop-shadow clutter. Structural depth is communicated through 1px hairline borders (`#f0f0f0` light, `#2a2a2e` dark) and surface contrast.

---

## 2. Color System

### Brand Voltage

- **Kumo Brand (`#ff5e1f`):** The primary voltage canvas. Fills the above-fold hero, active category tabs, and operator authority badges.
- **Kumo Brand Hover (`#ff7038`):** Hover/press state for brand-colored components.
- **Kumo Brand Soft (`#ff9650`):** Soft accent tones.
- **Kumo Brand Dark (`#d63c01`):** Deep brand accent.

### Surfaces

- **Cream (`#fffbf5`):** Warm off-white off-surface. Carries hero display typography, CTA pills, and table headers.
- **Canvas (`#ffffff`):** Pure white below-fold card background and top-nav surface.
- **Hairline (`#f0f0f0`):** Dominant structural border tone across all cards and dividers.

### Typography & Ink

- **Ink (`#262626`):** Dominant reading text for headlines and body copy.
- **Ink Soft (`#414040`):** Secondary paragraph and hint text.
- **Muted (`#727272`):** Tertiary metadata captions and inactive states.
- **Nav Muted (`#6a6967`):** Navigation bar links.

### Subsystem Product Domains (Solid Fills + White Text)

- **Compute (`#0a95ff`):** Blue. Represents In-Process SDK Provider, State Delivery, and Viewer RBAC.
- **Storage (`#ee0ddb`):** Pink. Represents Active Break-Glass Leases and Variant Overrides.
- **AI (`#00bd7d`):** Green. Represents Mesh Online status, Purger Quiescence, and Hash Continuity.
- **SASE (`#0d9488`):** Teal. Represents Control API Governance, Sealed Audit Checkpoints, and Admin RBAC.
- **Under Attack (`#b52932`):** Deep Red. Represents Incident routing, active revocation warnings, and security alerts.

---

## 3. Typography Hierarchy

| Token        | Size   | Weight | Line Height | Tracking | Role                                          |
| ------------ | ------ | ------ | ----------- | -------- | --------------------------------------------- |
| `display-xl` | 56px   | 500    | 56px        | -1.4px   | Hero headline ("Signed incident governance…") |
| `display-lg` | 48px   | 500    | 48px        | -1.2px   | Section display headers                       |
| `heading-md` | 19.2px | 400    | 23px        | -0.48px  | Section titles, operational state             |
| `heading-sm` | 18px   | 500    | 21.6px      | -0.45px  | Card titles, feature headers                  |
| `body-md`    | 16px   | 400    | 20px        | -0.04px  | Workhorse paragraph text                      |
| `body-sm`    | 14px   | 400    | 16.1px      | -0.14px  | Hint copy, secondary descriptions             |
| `button-md`  | 16px   | 500    | 24px        | -0.16px  | Interactive button labels                     |
| `nav-link`   | 14px   | 500    | 24px        | 0        | Top-nav links                                 |
| `mono-md`    | 14px   | 400    | 20px        | 0        | Code blocks, CLI commands                     |
| `mono-sm`    | 11px   | 600    | 16px        | 0.05em   | Small-caps labels, status badges, hashes      |

---

## 4. Solid Badges & Status Pills Specification

Every badge, tag, or status chip MUST adhere to the solid fill standard:

```css
.badge {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  font-family: var(--font-mono);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.05em;
  padding: 3px 10px;
  border-radius: 9999px;
  border: none;
  color: #ffffff; /* MANDATORY: Crisp white text */
}
```

- **Active Leases:** `backgroundColor: #00bd7d` (solid green) + `#ffffff` text.
- **Near-Expiry Leases:** `backgroundColor: #ff5e1f` (solid brand orange) + `#ffffff` text.
- **Expired Leases:** `backgroundColor: #727272` (solid muted grey) + `#ffffff` text.
- **Revoked Leases:** `backgroundColor: #b52932` (solid deep red) + `#ffffff` text.
- **Purger Candidates:** `backgroundColor: #00bd7d` (solid AI green) + `#ffffff` text.
- **Operator Role:** `backgroundColor: #ff5e1f` (solid orange) + `#ffffff` text + `#ffffff` dot.
- **Admin Role:** `backgroundColor: #0d9488` (solid SASE teal) + `#ffffff` text + `#ffffff` dot.
- **Viewer Role:** `backgroundColor: #0a95ff` (solid compute blue) + `#ffffff` text + `#ffffff` dot.
- **Mesh Online:** `backgroundColor: #00bd7d` (solid green) + `#ffffff` text.

---

## 5. Elevation & Radius Rules

- **Zero Drop-Shadow:** Shadows are omitted on 99% of surfaces. Depth is established through the `#f0f0f0` hairline border and color field contrast.
- **Binary Radius Rule:**
  - `3px`: Text inputs (`.text-input`), code chips.
  - `4px`: Dropdowns, popovers.
  - `6px`: Secondary buttons (`.btn-secondary`).
  - `8px`: Content cards (`.card-hairline`), stat cards (`.stat-card`), split panels.
  - `9999px`: Primary buttons (`.btn-pill-cream`, `.btn-pill-brand`), category tabs (`.category-tab`), status badges (`.badge`).
  - **No 12px, 16px, or 20px intermediate radii are permitted.**

---

## 6. Dark Mode Specification

Dark mode inverts the surface foundation while preserving high-voltage brand accents:

- **Body Background Floor:** `#0d0d0f` (deep obsidian).
- **Surface Cards:** `#1b1b1e` (zinc-charcoal).
- **Off-Surface Panels:** `#141416` (warm dark surface).
- **Hairline Borders:** `#2a2a2e` (subtle dark demarcation).
- **Typography:** Primary text renders in `#f4f4f6`, secondary in `#d2d2d6`, muted in `#8e8e98`.
- **Solid Badges:** Retain their solid product domain colors with `#ffffff` typography, delivering maximum clarity and triage speed in dark operating environments.

---

## 7. Do's and Don'ts

- **DO** treat `#ff5e1f` as the hero canvas itself rather than just a button accent.
- **DO** use solid color fills with `#ffffff` text for all badges, pills, and status tags.
- **DO** use `#fffbf5` warm cream for off-surfaces and hero CTA pills.
- **DO** keep display headlines at weight 500 with tight letter spacing.
- **DON'T** use washed-out semi-transparent backgrounds (`rgba(...)`) on badges or role chips.
- **DON'T** bump display headlines to bold (700+).
- **DON'T** introduce middle-tier border radii (12px, 16px, 20px).
- **DON'T** use drop-shadow layers for elevation; rely on hairline borders.
- **DON'T** use emojis for interface status or branding; use crisp vector icons from `react-icons`.
