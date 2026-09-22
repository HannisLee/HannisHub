# Design System — Claude-inspired Dark Editorial UI

> **Status:** Project-wide visual specification  
> **Purpose:** All new pages must read and follow this file before implementation.  
> **Reference:** Claude / Anthropic dark pricing surface shown in the supplied screenshot.  
> **Principle:** warm near-black background + warm off-white typography + editorial serif headings + restrained sans-serif UI + thin low-contrast borders + generous whitespace.

---

## 0. Implementation rule for agents

Before creating or redesigning any page in this project:

1. Read this `design.md` first.
2. Reuse the tokens and component rules defined here instead of inventing new values.
3. Do not introduce a new color, radius, shadow, font family, spacing scale, or button style unless the existing system cannot express the requirement.
4. Prefer CSS variables / design tokens. Do not scatter raw hex values through components.
5. Preserve the visual hierarchy: **serif display typography for major headings; sans-serif for navigation, controls, metadata, and body copy.**
6. Keep the interface restrained. Avoid gradients, neon accents, glassmorphism, strong drop shadows, and overly dense layouts unless explicitly required.

---

## 1. Likely frontend technology stack

The public Anthropic / Claude website is currently detected by third-party technology profiling as using **Next.js + React**. The exact implementation of this specific page is not publicly documented, so treat the following as a practical reconstruction rather than a claim about Anthropic's private source code.

### Recommended stack for reproducing this style

- **Framework:** Next.js
- **UI runtime:** React
- **Language:** TypeScript
- **Styling:** CSS Modules, vanilla CSS, or Tailwind backed by CSS variables
- **Design tokens:** CSS custom properties in a global token file
- **Icons:** thin-line SVG icons; keep stroke weight around `1.25–1.5px`
- **Animation:** CSS transitions for ordinary interactions; Motion only when a richer transition is genuinely useful

### Important observation

This visual system looks **custom-designed rather than framework-default**. Even if Tailwind or another utility framework is used internally, the important part is the token system and typography—not the framework itself.

---

# 2. Color system

The screenshot uses a warm, non-neutral dark palette. Avoid pure black `#000` and cold slate grays.

## 2.1 Core palette

| Token | Value | Usage |
|---|---:|---|
| `--color-bg` | `#141413` | Main page background |
| `--color-surface` | `#1F1E1D` | Cards / raised dark surfaces |
| `--color-surface-hover` | `#272624` | Hovered segmented controls / subtle active surfaces |
| `--color-surface-soft` | `#1B1B19` | Secondary dark section background |
| `--color-text-primary` | `#FAF9F5` | Main headings / high-emphasis text |
| `--color-text-secondary` | `#B0AEA5` | Body copy / secondary labels |
| `--color-text-muted` | `#8F8E89` | Metadata / tertiary copy |
| `--color-border` | `#353431` | Card and control border |
| `--color-divider` | `#302F2D` | Full-width separators / nav divider |
| `--color-brand` | `#D97757` | Claude-like warm terracotta accent |
| `--color-control-light` | `#FAF9F5` | Light CTA / selected pill background |
| `--color-on-light` | `#1C1B19` | Text on light CTA / selected pill |
| `--color-white` | `#FFFFFF` | Reserved for very high-contrast cases |

### 2.2 Semantic colors

Use semantic colors sparingly; the base UI should stay nearly monochrome.

| Token | Value |
|---|---:|
| `--color-success` | `#5DB872` |
| `--color-warning` | `#D4A017` |
| `--color-error` | `#C64545` |
| `--color-info` | `#6A9BCC` |

### 2.3 Color usage ratios

Recommended visual proportion per page:

- **70–80%** `#141413` background
- **10–20%** dark surfaces / borders
- **5–10%** off-white text and controls
- **<3%** terracotta or semantic accent

Do not turn the brand accent into a dominant UI color. It works best as a logo / indicator / small highlight.

---

# 3. Typography

The key visual characteristic is the contrast between an **editorial serif display face** and a **clean humanist sans-serif UI face**.

Anthropic's public web typography is commonly identified as using self-hosted `Anthropic Serif`, `Anthropic Sans`, and `Anthropic Mono`; earlier / related font lineage is often associated with Copernicus / Tiempos and Styrene. Do **not** redistribute proprietary font files.

## 3.1 Recommended font stacks

```css
--font-display: "Anthropic Serif", "Tiempos Headline", Georgia, "Times New Roman", serif;
--font-ui: "Anthropic Sans", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
--font-mono: "Anthropic Mono", "JetBrains Mono", "SFMono-Regular", Consolas, monospace;
```

If the proprietary Anthropic fonts are unavailable, use the fallback stack directly.

## 3.2 Type scale

| Token | Size | Weight | Line height | Letter spacing | Usage |
|---|---:|---:|---:|---:|---|
| `display-xl` | `56px` | `400` | `1.08` | `-1.4px` | Main hero heading |
| `display-lg` | `48px` | `400` | `1.10` | `-1.0px` | Large section heading |
| `display-md` | `36px` | `400` | `1.15` | `-0.5px` | Section heading / large card title |
| `display-sm` | `32px` | `400` | `1.20` | `-0.3px` | Pricing card title |
| `title-lg` | `22px` | `500` | `1.30` | `0` | Major UI title |
| `title-md` | `18px` | `500` | `1.40` | `0` | Card / control title |
| `body-lg` | `17px` | `400` | `1.55` | `0` | Prominent body copy |
| `body-md` | `16px` | `400` | `1.55` | `0` | Default body copy |
| `body-sm` | `14px` | `400` | `1.55` | `0` | Secondary description |
| `caption` | `13px` | `400–500` | `1.40` | `0` | Metadata / footer text |
| `nav` | `15px` | `400–500` | `1.40` | `0` | Navigation items |
| `button` | `16px` | `400–500` | `1.00` | `0` | Large CTA buttons |

### 3.3 Rules

- Major page titles: **display serif**, regular weight.
- Pricing / editorial card titles: display serif.
- Body text, nav, buttons, tabs, labels: sans-serif.
- Avoid bold-heavy typography; hierarchy comes primarily from **font family, size, whitespace, and contrast**.
- Do not use all-caps for ordinary navigation or headings.
- Keep long-form body text around `60–72ch` maximum width.

### 3.4 Responsive heading sizes

```css
.hero-title {
  font-size: clamp(42px, 4vw, 56px);
  line-height: 1.08;
  letter-spacing: -0.025em;
}
```

---

# 4. Spacing system

Use an **8px base grid**, with 4px half-steps for compact UI.

## 4.1 Spacing tokens

| Token | Value |
|---|---:|
| `--space-1` | `4px` |
| `--space-2` | `8px` |
| `--space-3` | `12px` |
| `--space-4` | `16px` |
| `--space-5` | `20px` |
| `--space-6` | `24px` |
| `--space-8` | `32px` |
| `--space-10` | `40px` |
| `--space-12` | `48px` |
| `--space-16` | `64px` |
| `--space-20` | `80px` |
| `--space-24` | `96px` |
| `--space-32` | `128px` |

## 4.2 Page spacing

- Desktop horizontal page padding: `64–80px`
- Tablet horizontal padding: `32px`
- Mobile horizontal padding: `20–24px`
- Header / navbar horizontal padding: same as page container
- Hero top spacing after secondary nav: `72–88px`
- Hero heading → segmented control: `88–104px`
- Segmented control → card grid: `48px`
- Section-to-section spacing: `96–128px`

## 4.3 Component spacing

### Card

- Card padding: `32px`
- Card icon → title: `24px`
- Title → body: `10–12px`
- Body → price: `28–32px`
- Price → supporting text: `8px`
- Supporting text → CTA: `24–28px`

### Navigation

- Header height: approximately `68–72px`
- Secondary nav height: approximately `44px`
- Main nav item gap: `28–32px`
- Logo → first nav group: flexible spacer

### Grid

- Desktop pricing-card gap: `24px`
- Three-column desktop layout
- Two-column tablet layout where viable
- One-column mobile layout

---

# 5. Layout

## 5.1 Main container

```css
.page-container {
  width: min(100% - 48px, 1232px);
  margin-inline: auto;
}
```

For large desktop screens, target a content width around **1200–1240px**.

## 5.2 Hero

- Center aligned.
- Keep the hero unusually clean: one small icon / mark, one headline, then a generous vertical gap.
- Avoid subtitles unless the page genuinely needs them.
- Hero headline max-width: `760–900px`.

## 5.3 Card grid

```css
.pricing-grid {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  gap: 24px;
}
```

Cards should have equal height where they appear in the same row.

---

# 6. Component styles

## 6.1 Buttons

### Primary light button

Used for the strongest CTA on dark surfaces.

```css
.button-primary {
  min-height: 42px;
  padding: 0 20px;
  border: 1px solid #FAF9F5;
  border-radius: 9px;
  background: #FAF9F5;
  color: #1C1B19;
  font: 500 16px/1 var(--font-ui);
  box-shadow: none;
  transition: background-color 160ms ease,
              border-color 160ms ease,
              transform 120ms ease;
}

.button-primary:hover {
  background: #FFFFFF;
}

.button-primary:active {
  transform: translateY(1px);
}
```

### Secondary outline button

```css
.button-secondary {
  min-height: 38px;
  padding: 0 16px;
  border: 1px solid #454440;
  border-radius: 9px;
  background: transparent;
  color: #FAF9F5;
}
```

### Rules

- Default radius: `8–10px`.
- No pill-shaped primary buttons unless the design specifically calls for a segmented switch.
- No heavy shadows.
- Buttons use controlled, modest hover contrast rather than dramatic animation.

---

## 6.2 Segmented control / tabs

Visual reference: `Individual / Team & Enterprise` switch.

```css
.segmented {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border-radius: 14px;
  background: #272624;
}

.segmented__item {
  min-height: 40px;
  padding: 0 18px;
  border-radius: 10px;
  color: #D3D1CA;
  background: transparent;
}

.segmented__item[aria-selected="true"] {
  background: #FAF9F5;
  color: #1C1B19;
}
```

- Outer control radius: `14px`
- Selected item radius: `10px`
- Do not add a visible border unless contrast is insufficient.

---

## 6.3 Cards

```css
.card {
  background: #1F1E1D;
  border: 1px solid #353431;
  border-radius: 22px;
  padding: 32px;
  box-shadow: none;
}
```

### Card rules

- Radius: `20–24px`; standard = `22px`.
- Border: `1px solid` low-contrast warm gray.
- No default box-shadow.
- Do not float cards with strong elevation; separation comes from **surface tone + border**.
- Card content should breathe. Prefer more vertical empty space over extra decoration.

### Interactive card hover

Only if the whole card is clickable:

```css
.card--interactive:hover {
  border-color: #4B4945;
  background: #22211F;
}
```

Do not scale cards on hover.

---

## 6.4 Navigation bar

### Primary navbar

```css
.navbar {
  height: 70px;
  border-bottom: 1px solid #302F2D;
  background: #141413;
}
```

- Logo aligned left.
- Main links aligned right on desktop.
- Text: `15px`, sans-serif, muted off-white.
- CTA cluster may include one outline button and one light button.
- Nav dropdown chevrons should be small and low contrast.

### Secondary navbar

```css
.subnav {
  min-height: 44px;
  border-bottom: 1px solid #302F2D;
  background: #141413;
}
```

- Smaller `12–13px` text.
- Useful for product-context navigation or breadcrumb-like product labels.

---

## 6.5 Icons

- Use line icons instead of filled icons.
- Stroke: `1.25–1.5px`.
- Default size: `16px` inline; `28–40px` decorative.
- Icon color: `#FAF9F5` or `#B0AEA5`.
- Decorative icons should not compete with headings.

---

# 7. Border, radius, and shadow rules

## Radius scale

```css
--radius-sm: 8px;
--radius-md: 10px;
--radius-lg: 14px;
--radius-xl: 22px;
--radius-pill: 999px;
```

Use `--radius-pill` only for chips / badges / unavoidable pills.

## Border rules

- Standard: `1px solid #353431`
- Dividers: `1px solid #302F2D`
- Focus: `1px solid #8F8E89` plus a subtle outer ring if needed for accessibility

## Shadow rules

The default system is essentially **shadowless**.

If a temporary overlay genuinely requires elevation:

```css
box-shadow: 0 12px 32px rgba(0, 0, 0, 0.28);
```

Do not use shadows on ordinary content cards.

---

# 8. Interaction and motion

- Hover transitions: `140–180ms ease`.
- Page / section reveal: optional `220–320ms` opacity + small translate.
- Avoid springy motion on marketing / pricing components.
- Respect `prefers-reduced-motion`.
- No animated gradient backgrounds.
- No persistent glow effects.

Example:

```css
@media (prefers-reduced-motion: no-preference) {
  .interactive {
    transition: background-color 160ms ease,
                border-color 160ms ease,
                color 160ms ease;
  }
}
```

---

# 9. Responsive rules

## Desktop — `>= 1024px`

- 3-column pricing grid
- Full navigation links visible
- Horizontal padding: `64–80px`
- Hero heading up to `56px`

## Tablet — `768–1023px`

- 2-column grid, with the final card either full width or balanced according to content
- Horizontal padding: `32px`
- Hero heading: `44–50px`

## Mobile — `< 768px`

- 1-column grid
- Horizontal padding: `20–24px`
- Card padding: `24px`
- Hero heading: `38–44px`
- Collapse desktop nav into a menu
- Segmented control may remain inline if it fits; otherwise use full-width equal segments

---

# 10. Accessibility

- Maintain WCAG AA text contrast.
- Every interactive element must have a keyboard-visible focus state.
- Minimum comfortable touch target: `40×40px`; prefer `44×44px` on mobile.
- Do not communicate state only with color.
- Decorative icons should be `aria-hidden="true"`.
- Use semantic heading hierarchy; do not choose heading tags based on visual size.

---

# 11. CSS token starter

```css
:root {
  /* Color */
  --color-bg: #141413;
  --color-surface: #1F1E1D;
  --color-surface-hover: #272624;
  --color-surface-soft: #1B1B19;
  --color-text-primary: #FAF9F5;
  --color-text-secondary: #B0AEA5;
  --color-text-muted: #8F8E89;
  --color-border: #353431;
  --color-divider: #302F2D;
  --color-brand: #D97757;
  --color-control-light: #FAF9F5;
  --color-on-light: #1C1B19;

  /* Typography */
  --font-display: "Anthropic Serif", "Tiempos Headline", Georgia, "Times New Roman", serif;
  --font-ui: "Anthropic Sans", Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", Arial, sans-serif;
  --font-mono: "Anthropic Mono", "JetBrains Mono", "SFMono-Regular", Consolas, monospace;

  /* Spacing */
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 20px;
  --space-6: 24px;
  --space-8: 32px;
  --space-10: 40px;
  --space-12: 48px;
  --space-16: 64px;
  --space-20: 80px;
  --space-24: 96px;
  --space-32: 128px;

  /* Radius */
  --radius-sm: 8px;
  --radius-md: 10px;
  --radius-lg: 14px;
  --radius-xl: 22px;
  --radius-pill: 999px;
}
```

---

# 12. Visual do / don't

## Do

- Warm near-black canvas.
- Large serif display headings.
- Modest sans-serif navigation and controls.
- Generous whitespace.
- Low-contrast borders.
- Rounded cards, but not excessively bubbly UI.
- Very limited accent color.
- Strong alignment and consistent container widths.

## Don't

- Pure black backgrounds everywhere.
- Blue-gray SaaS palette.
- Purple AI gradients.
- Glassmorphism.
- Thick shadows around cards.
- Excessive pills.
- Bold 700/800 weight as the primary hierarchy mechanism.
- Dense dashboards unless the product requires density.
- Random one-off spacing values such as `13px`, `37px`, `53px` without a clear reason.

---

# 13. Page review checklist

Before a page is considered finished, verify:

- [ ] `design.md` was read before implementation.
- [ ] Page background is based on `--color-bg`.
- [ ] Major headings use the display-serif stack.
- [ ] Body / nav / controls use the UI sans stack.
- [ ] All colors come from tokens.
- [ ] All spacing comes from the spacing scale unless a documented exception exists.
- [ ] Ordinary cards use `22px` radius, `1px` border, and no shadow.
- [ ] Main buttons use light background / dark text on dark surfaces.
- [ ] Accent terracotta is used sparingly.
- [ ] Desktop / tablet / mobile states were checked.
- [ ] Keyboard focus and text contrast are acceptable.
- [ ] No unnecessary visual effect was introduced just to make the page feel “modern.”

