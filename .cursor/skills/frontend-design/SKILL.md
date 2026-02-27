---
name: frontend-design
description: Create distinctive, production-grade frontend interfaces with high design quality. Use this skill when the user asks to build web components, pages, or applications. Generates creative, polished code that avoids generic AI aesthetics.
license: Complete terms in LICENSE.txt
---

# Frontend Design

## When to Use This Skill

Use this skill whenever the user:

- Asks to design or implement **web UI**: components, pages, dashboards, marketing sites, internal tools, or full applications.
- Mentions **visual design quality**, **distinctive aesthetics**, **non-generic / non-AI-slop** design, or wants something that “looks really good”.
- Provides **purpose / audience / brand context** and expects the frontend to reflect that.
- Needs **production-grade** HTML/CSS/JS/React/Vue/etc., not just wireframes or rough sketches.

The agent should **not** use this skill for:
- Pure backend tasks with no UI.
- Very low-fidelity wireframes or purely functional prototypes where visual style is explicitly “not important”.

---

## Core Principles

1. **Context first, code second**  
   Always understand:
   - Purpose: What problem does this interface solve?
   - Audience: Who is using it? What do they care about?
   - Constraints: Framework, performance expectations, accessibility requirements, design tokens, or brand guidelines (if any).

2. **Bold, coherent aesthetic direction**  
   Each UI must choose **one clear aesthetic direction** and commit to it. Examples:
   - Brutally minimal
   - Maximalist chaos
   - Retro-futuristic
   - Organic/natural
   - Luxury/refined
   - Playful/toy-like
   - Editorial/magazine
   - Brutalist/raw
   - Art deco/geometric
   - Soft/pastel
   - Industrial/utilitarian  
   The direction should be **specific, intentional, and traceable** in all design decisions (type, color, spacing, motion, layout).

3. **Production-grade implementation**
   - Real, working code: valid HTML, clean CSS, and correct JS/TS/React/Vue/etc.
   - Sensible component boundaries and props.
   - Responsive behavior for at least mobile and desktop breakpoints unless the user explicitly restricts scope.
   - Reasonable attention to accessibility (colors, focus states, semantic structure).

4. **Anti–generic AI aesthetics (CRITICAL)**
   Avoid:
   - Overused font families: **Inter, Roboto, Arial, default system UI**.
   - Cliché color schemes: especially **purple/blue gradients on white**, washed-out “default SaaS” palettes.
   - Predictable layouts: hero + three cards + call-to-action that look like boilerplate.
   - Repeating the same font, color, and layout choices across different projects.  
   Every design should feel **context-specific and memorable**, not like a template.

---

## Design Workflow

Follow this workflow **before** writing code:

### 1. Analyze Context

Extract and, if needed, restate:

- **Purpose**: What is this interface trying to achieve?
- **Primary user**: Role, skill level, emotional state (e.g., anxious trader, curious student, busy executive).
- **Usage environment**: Desktop command center, mobile on the go, presentation on big screens, etc.
- **Technical stack & constraints**:
  - Framework (e.g., React, Vue, Svelte, plain HTML).
  - Design system or UI library that must be respected (if any).
  - Performance limits (e.g., avoid heavy animations on low-power devices).
  - Accessibility requirements (WCAG level, keyboard-only usage, screen readers).

Summarize this briefly in your own words before choosing a visual direction.

### 2. Choose a Bold Aesthetic Direction

Based on the context, choose **one** clear direction and write 2–4 sentences that define it. For example:

- *“Retro-futuristic terminal for power users: dark, phosphor greens and ambers, monospaced display type, glowing scanlines, layered grids with subtle noise. Feels like an elevated 80s trading desk UI, but precise and modern.”*
- *“Editorial financial magazine: large confident headlines, asymmetric layouts, generous white space, muted serif/body pairings with a single sharp accent color. Feels like a modern print cover, adapted to the web.”*

Be explicit about:
- **Typography personality**
- **Color palette & mood**
- **Spatial density** (airy vs dense)
- **Motion philosophy** (subtle vs dramatic)

### 3. Translate Direction into a Design System

Convert the direction into concrete design tokens and rules:

- **Typography**
  - Choose **two fonts**:
    - A **display or headline font** with strong character.
    - A **body font** that is refined and legible.
  - Prefer distinctive fonts (e.g., expressive serifs, grotesques, monos with character, humanist sans) over default system fonts.
  - Define font sizes, line heights, letter spacing for key text roles (headline, subhead, body, captions, UI labels).

- **Color**
  - Define a compact palette as CSS variables:
    - `--color-bg`, `--color-surface`, `--color-text-main`, `--color-text-muted`
    - `--color-accent`, `--color-accent-soft`
    - Optional `--color-border`, `--color-danger`, etc.
  - Choose **one or two dominant hues** and **one punchy accent**; avoid flat, evenly spread rainbow palettes unless the aesthetic demands it.

- **Layout & Spatial System**
  - Define spacing scales (e.g., 4/8/12/16/24/32).
  - Decide on:
    - Asymmetry vs symmetry.
    - Grid or freeform composition.
    - Overlaps, layering, and depth.
  - Commit to generous negative space **or** dense information design; do not stay in the “safe middle”.

- **Motion & Interaction**
  - Identify **1–3 key moments** where motion adds real value:
    - Page load / initial mount.
    - Hover/press on primary CTAs.
    - Critical data changes or state transitions.
  - Use:
    - CSS transitions and keyframes for HTML/CSS.
    - Motion libraries (e.g., Framer Motion) for React if the stack permits.
  - Keep timing and easing consistent with the mood (snappy and elastic vs slow and cinematic).

- **Atmosphere & Details**
  - Create depth and mood with:
    - Gradient meshes, soft vignettes.
    - Noise/grain overlays.
    - Subtle textures (paper, glass, metal, fabric) approximated via CSS.
    - Custom borders, corner shapes, shadows, and overlays.
  - Always ensure these details support, not fight, the chosen aesthetic.

### 4. Implement the UI

When writing code:

- **Structure**
  - Use semantic HTML tags where possible.
  - Break down into logical components with clear responsibilities.
  - Keep class names meaningful and aligned with the design system.

- **Styling**
  - Prefer modern CSS features:
    - Flexbox/Grid for layouts.
    - Custom properties (CSS variables).
    - `clamp()` for responsive typography.
  - Group styles semantically (by component or role) rather than sprawling utility chaos, unless the project mandates a utility-first approach.

- **Responsiveness**
  - At minimum handle:
    - A narrow viewport (~375–480px).
    - A wide viewport (~1200–1440px).
  - Adjust font sizes, paddings, and layout structures to maintain the intended mood at each size, not just squeeze everything.

- **Accessibility**
  - Pay attention to:
    - Color contrast for text.
    - Focus states for interactive elements.
    - ARIA labels when needed.
  - Do not let style destroy basic usability.

---

## Anti-Patterns to Avoid

Never default to:

- **Fonts**
  - Inter, Roboto, Arial, Helvetica, or plain system stacks unless the user explicitly requests them.
  - Reusing the same “favorite” designer font across different projects.

- **Color**
  - Generic purple/blue gradients on white as a default.
  - Unconsidered “techy” neon accents just because it’s a dashboard.

- **Layout**
  - Repetitive “hero + three cards + CTA” patterns with no twist.
  - Generic card grids with identical spacing and corners without any compositional interest.

- **Repetition Across Projects**
  - Do not converge on:
    - The same 1–2 typefaces.
    - The same 1–2 color palettes.
    - The same 1–2 layout structures.  
  Each project should feel like it was designed **fresh for that context**.

---

## Quality Checklist

Before finalizing, check:

- **Concept**
  - [ ] The aesthetic direction is clearly articulated and specific.
  - [ ] The visual system (type, color, layout, motion) all serve that direction.

- **Implementation**
  - [ ] Code is valid, clean, and idiomatic for the chosen stack.
  - [ ] Styles are organized and reusable (not an unstructured dump).
  - [ ] The layout is responsive for at least mobile and desktop.

- **Experience**
  - [ ] There is at least one **memorable design moment** (layout, motion, typography, or detail).
  - [ ] The UI is usable and readable; aesthetics never obscure core actions.

- **Non-generic**
  - [ ] Fonts are **not** Inter/Roboto/Arial/system unless explicitly requested.
  - [ ] Colors and layout do **not** resemble default “AI-generated” SaaS templates.
  - [ ] This design would be recognizable in a lineup as distinct.

---

## Examples (Concept-Level)

These examples illustrate how to think and talk about direction before coding.

### Example 1: Quant Trading Dashboard

- **Context**: Power users, dense live data, multi-monitor desktop setup.
- **Direction**: Industrial/utilitarian dark UI.
  - Typography: Functional, slightly condensed sans for numbers; high legibility under long gaze.
  - Color: Deep charcoal background, desaturated steel surfaces, one sharp lime highlight for crucial metrics.
  - Layout: Dense grid with intentional clustering; key metrics oversized and pinned.
  - Motion: Subtle fades for live updates; no flashy transitions.

### Example 2: Mindfulness Journal App

- **Context**: Mobile-first, reflective, personal.
- **Direction**: Organic, soft, pastel.
  - Typography: Gentle serif for headings, warm sans for body text.
  - Color: Warm off-white background, soft sage and blush accents, low contrast but still readable.
  - Layout: Generous spacing, flowing vertical rhythm, rounded cards with overlapping elements.
  - Motion: Slow, easing-in transitions; breathing-like pulsation on primary actions.

### Example 3: Experimental Music Landing Page

- **Context**: Artist site, desktop-first, visual spectacle welcome.
- **Direction**: Maximalist chaos / retro-futuristic.
  - Typography: High-contrast display type, mixed caps, experimental spacing.
  - Color: Neon gradients on deep black, glitch overlays, chromatic aberrations.
  - Layout: Overlapping layers, tilted sections, unpredictable but navigable.
  - Motion: Bold entrance animations, responsive to hover/scroll, but performance-tested.

Use these as mental templates for how detailed and intentional your aesthetic thinking should be before you start coding.

