---
name: refine-landing-page
description: Run a concrete second-pass implementation on an existing landing page. Use when asked to refine, polish, improve, or QA a first-pass marketing page while preserving its approved artistic direction. Inspect the rendered page at desktop and mobile sizes, measure computed typography and geometry, fix every objective checklist failure, and repeat until the page passes checks for clarity, heading proportions, text size, WCAG AA contrast, proof composition, testimonial attribution, semantic list numbering, icon-library use, imagery, responsive layout, and interaction consistency.
---

# Refine Landing Page

Perform an implementation pass, not a critique. Inspect the rendered page, record failures, fix them, render again, and repeat until every applicable check passes.

Preserve the approved artistic direction, copy, imagery, section sequence, and primary CTA unless one of them causes a checklist failure or the user asks to change it. Do not redesign the page from scratch.

If the user asks only for analysis, report failures without editing. Otherwise, invocation authorizes the fixes needed to pass this checklist.

## Required loop

1. Read repository instructions and inspect the full implementation.
2. Identify the primary CTA, current visual direction, content sources, and repeated components.
3. Start the site and render the actual page at approximately 1440px, 768px, and 390px wide. Use the production page if a trustworthy local render is unavailable.
4. Evaluate every check below against rendered output and computed browser styles. Do not infer rendered quality from CSS source alone.
5. Fix every objective failure. Prefer a shared component or token change when all instances fail; use a local change when only one instance fails.
6. Render all three widths again. Recheck changed sections, shared components, and any new wrapping or overflow.
7. Repeat until no objective failure remains.
8. Run the repository's existing lint, type, and production-build checks. Leave a comprehensive web audit to the dedicated audit skill when requested.

Do not stop after listing problems. Do not declare success with known checklist failures.

## Rendered measurement

Judge the browser result, not the unit used in source code. `rem`, `clamp()`, `vw`, and design tokens are valid only when their computed results pass at every tested width.

When browser evaluation is available, inspect text-bearing elements with computed styles and bounding rectangles. A useful text-size query is:

```js
[...document.querySelectorAll("body *")]
  .filter((element) => {
    const style = getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    const hasOwnText = [...element.childNodes].some(
      (node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim()
    );
    return hasOwnText && rect.width > 0 && rect.height > 0 &&
      style.visibility !== "hidden" && style.display !== "none";
  })
  .map((element) => ({
    element,
    text: element.textContent.trim().slice(0, 80),
    fontSize: parseFloat(getComputedStyle(element).fontSize),
  }))
  .filter(({ fontSize }) => fontSize < 16);
```

Inspect heading geometry with:

```js
[...document.querySelectorAll("h1, h2, h3, h4, h5, h6")].map((element) => {
  const style = getComputedStyle(element);
  const rect = element.getBoundingClientRect();
  const fontSize = parseFloat(style.fontSize);
  const lineHeight = parseFloat(style.lineHeight) || fontSize * 1.2;
  return {
    element,
    text: element.textContent.trim(),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
    lines: Math.round(rect.height / lineHeight),
    fontSize,
    lineHeight,
  };
});
```

If the browser cannot evaluate JavaScript, inspect computed styles through its developer tools and verify the same values visually. Do not treat source-code inspection as a substitute for a rendered pass.

## Pass 1: First-screen clarity

- Confirm the hero heading states what the business offers or the outcome it creates. Replace vague language only when necessary for comprehension.
- Confirm supporting copy adds useful detail instead of paraphrasing the heading.
- Confirm the primary CTA is visible, specific, and visually primary.
- Confirm the first screen has no accidental obstruction, overflow, clipped copy, or competing primary action.

Pass when a new visitor can identify the offer and next action without reading the rest of the page.

## Pass 2: Heading geometry and hierarchy

Check every heading at every rendered width.

- Limit each heading to three rendered lines.
- Require each heading's rendered bounding box to be wider than it is tall.
- Reject headings that consume most of the viewport merely to create drama.
- Use a font size and measure appropriate to the section, content, viewport, and artistic direction.
- Tighten multiline heading line-height enough that the lines read as one unit without colliding.
- Remove manual line breaks that cause fragile wrapping. Add an intentional break only when it remains sound across viewports.
- Fix failures by adjusting copy measure, container width, grid allocation, font-size bounds, line-height, or copy length. Do not solve every failure by shrinking type.

Use this default order in any section containing text:

1. Eyebrow
2. Heading
3. Body copy
4. Additional content

Preserve that hierarchy when columns stack. Deviate only when the requested artistic direction clearly requires it.

Pass when no heading exceeds three lines, no heading is taller than wide, and the reading order is unambiguous.

## Pass 3: Readability and contrast

Check the computed result for every visible piece of meaningful text, including navigation, eyebrows, captions, metadata, buttons, form labels, testimonial attribution, and footer copy.

- Require a computed font size of at least 16px. Decorative SVG marks with no textual meaning are exempt.
- Require WCAG AA contrast: at least 4.5:1 for normal text and 3:1 for large text.
- Use an automated contrast checker, accessibility scan, or browser audit. Also inspect text over photography, video, transparency, and gradients manually because automated checks can miss the effective background.
- Fix image-overlay failures with a dependable overlay, scrim, solid panel, or different text color.
- Check default, hover, active, focus, and disabled states on both light and dark backgrounds.
- Keep visible focus indicators distinct from the surrounding colors.

Pass when the computed-size scan returns no meaningful text below 16px and no text state fails AA contrast.

## Pass 4: Icons and controls

Inspect the source and rendered controls.

- Check `package.json` for an installed high-quality icon library and use it consistently.
- Replace Unicode glyphs, emoji, HTML entities, hand-drawn text symbols, and CSS-drawn approximations used as interface icons. Common failures include arrows, chevrons, menu marks, plus/minus marks, and close marks.
- If no suitable library exists, install one appropriate library or omit nonessential icons.
- Keep brand logos and intentionally sourced custom artwork as assets; they are not interface icons.
- Mark decorative icons `aria-hidden="true"`.
- Give icon-only controls an accessible name.
- Use native buttons and links for interaction.

Punctuation and mathematical symbols used as actual text are exempt.

Pass when every interface icon comes from one coherent, high-quality icon family or an intentional brand asset, and every control has correct accessible semantics.

## Pass 5: Testimonials and proof

Inventory all completed work, testimonials, awards, statistics, guarantees, credentials, press, partnerships, and other demonstrated proof already supported by the source material.

- Give each proof section one clear claim or customer question to answer.
- Group related evidence into as many sections as needed for each group to remain understandable.
- Recompose crowded proof before deleting useful evidence. More proof is effective when composition makes it understandable; poorly composed proof becomes noise.
- Place each item where its meaning is evident. For example, third-party logos belong in a clearly contextualized client, partner, press, certification, or recognition treatment.
- Label statistics and credentials so the visitor knows what they prove.
- Keep source truth. Do not invent awards, quantities, guarantees, names, titles, locations, or relationships.
- Require visible attribution for every testimonial. Use the person's name and any role, company, location, or project information present in the source.
- Do not invent missing attribution. Omit a testimonial that cannot be credibly attributed unless the user explicitly asks to retain it.
- Use semantic quotation markup where appropriate.

Pass when every proof item is supported, contextualized, and understandable by itself, and no testimonial appears without visible attribution.

## Pass 6: Lists and numbering

Inspect every ordered list, CSS counter, numeric badge, and hardcoded sequence such as `01`, `02`, or `03`.

- Show numbers only when order changes meaning: instructions, chronology, rankings, stages, or a genuinely sequential process.
- Use unordered semantics or unnumbered composition when items can be rearranged without changing meaning.
- Do not convert an ordered list from drafted Markdown into visible decorative numbering without first verifying that sequence matters.
- Treat dates, quantities, measurements, and proof statistics as data, not list numbering.

For every visible list number, answer: “What becomes incorrect if these items are reordered?” Remove the number if there is no concrete answer.

Pass when every visible sequence is semantically ordered and no decorative numbering remains.

## Pass 7: Images and media

Create a quick inventory of each image's source, source dimensions, section, rendered size, and crop.

- Do not repeat photography or project imagery across sections unless the user explicitly requests repetition. Logos and persistent brand marks are exempt.
- Use a source image large enough for its rendered dimensions and density.
- Inspect focal point and crop at every tested width. Avoid accidental portrait crops caused by narrow grid columns or fixed aspect ratios.
- Prefer a wider split when a section image needs environmental context.
- Ensure media adds evidence, product context, atmosphere, or narrative value rather than filling empty space.
- Provide meaningful alternative text for informative images and empty alternative text for decorative images.
- Prevent layout shift with stable dimensions or aspect ratio.

Pass when all images are unique in use, sufficiently sharp, intentionally cropped, and accessible.

## Pass 8: Brand, composition, and decoration

Inspect borders, badges, cards, shadows, gradients, floating shapes, animations, and ornamental dividers.

- Locate and use the business's actual logo from its source site or supplied assets. Do not replace it with typeset text, recreate it, or invent a new mark. Prefer the highest-quality official file and preserve its proportions; use an official light, dark, or monochrome variant when contrast requires it.
- Require each addition to serve a structural, semantic, interactive, or brand purpose.
- Remove it when it has no purpose, duplicates a job already handled by spacing or typography, creates visual clutter, or conflicts with the artistic direction.
- Do not preserve an element merely because it makes the page look designed.
- Avoid automatic card grids when a stronger composition fits the content.
- Ensure neighboring sections vary intentionally without creating arbitrary zigzags or repetitive templates.
- Keep the primary CTA label, destination, visual treatment, and interaction language consistent wherever it appears.

Pass when the business's actual logo is used, every remaining decorative device has a defensible job, and the composition communicates before it decorates.

## Pass 9: Responsive and interaction integrity

- Preserve reading order and text hierarchy when grids stack.
- Check horizontal overflow, clipped focus rings, overlapping controls, awkward empty space, and tap-target crowding.
- Ensure navigation, accordions, carousels, forms, and menus work with keyboard and touch.
- Respect reduced-motion preferences.
- Keep hover effects supplementary; never make hover the only way to reveal necessary information.
- Recheck every instance after changing a shared component or token.

Pass when the page remains understandable and operable at all tested widths without overflow or interaction regressions.

## Completion gate

Finish only when:

- The page has been rendered and checked at desktop, tablet, and mobile widths after the final edit.
- Every applicable pass above succeeds.
- Any deliberate exception is required by an explicit user instruction and is documented in the handoff.
- Existing lint, type, and production-build checks pass, or a pre-existing failure is clearly identified.

Report the fixes made and any explicit exception. Keep the handoff concise.
