export type PagePlan = {
  metadata: { title: string; description: string };
  cta: { title: string; url: string } | null;
  sections: Array<{ id: string; purpose: string; proof: string[]; relumeQuery: string }>;
};

export type SectionSelection = {
  sections: Array<{ id: string; slug: string; imageIds: string[] }>;
};

export type Theme = {
  backgroundPrimary: string;
  backgroundSecondary: string;
  backgroundTertiary: string;
  backgroundAlternative: string;
  textPrimary: string;
  textSecondary: string;
  textAlternative: string;
  borderPrimary: string;
  borderSecondary: string;
  borderAlternative: string;
  buttonText: string;
  fontSans: string;
  fontDisplay: string;
  radius: string;
  shadow: string;
};

function object(value: unknown, name: string) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value as Record<string, unknown>;
}

function string(value: unknown, name: string) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must be a non-empty string`);
  return value.trim();
}

export function parsePagePlan(json: string, validLinks: string[]): PagePlan {
  const value = object(JSON.parse(json), "sections.json");
  const metadata = object(value.metadata, "metadata");
  const cta = value.cta === null ? null : object(value.cta, "cta");
  if (!Array.isArray(value.sections) || value.sections.length === 0) throw new Error("sections.json must contain sections");
  const ids = new Set<string>();
  const sections = value.sections.map((item, index) => {
    const section = object(item, `sections[${index}]`);
    const id = string(section.id, `sections[${index}].id`);
    if (!/^[a-z][a-z0-9-]*$/.test(id) || ids.has(id)) throw new Error(`Invalid or duplicate section id: ${id}`);
    ids.add(id);
    if (!Array.isArray(section.proof) || section.proof.some((proof) => typeof proof !== "string" || !proof.trim())) {
      throw new Error(`sections[${index}].proof must contain strings`);
    }
    const relumeQuery = string(section.relumeQuery, `sections[${index}].relumeQuery`);
    if (relumeQuery.split(/\s+/).length > 8 || relumeQuery.length > 80) {
      throw new Error(`sections[${index}].relumeQuery must be a concise search query of at most eight words`);
    }
    return {
      id,
      purpose: string(section.purpose, `sections[${index}].purpose`),
      proof: section.proof.map((proof) => proof.trim()),
      relumeQuery,
    };
  });
  const parsedCta = cta ? { title: string(cta.title, "cta.title"), url: string(cta.url, "cta.url") } : null;
  if (parsedCta && !validLinks.includes(parsedCta.url)) throw new Error(`CTA uses an unverified destination: ${parsedCta.url}`);
  return {
    metadata: { title: string(metadata.title, "metadata.title"), description: string(metadata.description, "metadata.description") },
    cta: parsedCta,
    sections,
  };
}

export function parseImageSelection(json: string, validImageIds: string[]) {
  const value = object(JSON.parse(json), "image selection");
  if (!Array.isArray(value.imageIds)) throw new Error("imageIds must be an array");
  const imageIds = value.imageIds.map((imageId, index) => string(imageId, `imageIds[${index}]`));
  if (new Set(imageIds).size !== imageIds.length) throw new Error("An image selection cannot repeat an image");
  for (const imageId of imageIds) {
    if (!validImageIds.includes(imageId)) throw new Error(`Unknown image ID: ${imageId}`);
  }
  return imageIds;
}

export function parseSectionSelection(json: string, plan: PagePlan, validImageIds: string[]): SectionSelection {
  const value = object(JSON.parse(json), "section-selection.json");
  if (!Array.isArray(value.sections) || value.sections.length !== plan.sections.length) {
    throw new Error("section-selection.json must contain every planned section exactly once");
  }
  const imageIds = new Set<string>();
  const sections = value.sections.map((item, index) => {
    const section = object(item, `sections[${index}]`);
    const id = string(section.id, `sections[${index}].id`);
    if (id !== plan.sections[index].id) throw new Error(`Section order mismatch at ${id}`);
    const slug = string(section.slug, `sections[${index}].slug`);
    if (!Array.isArray(section.imageIds)) throw new Error(`sections[${index}].imageIds must be an array`);
    const selected = section.imageIds.map((imageId) => string(imageId, `sections[${index}].imageIds`));
    for (const imageId of selected) {
      if (!validImageIds.includes(imageId)) throw new Error(`Unknown image ID: ${imageId}`);
      if (imageIds.has(imageId)) throw new Error(`Image selected more than once: ${imageId}`);
      imageIds.add(imageId);
    }
    return { id, slug, imageIds: selected };
  });
  return { sections };
}

const color = /^#[0-9a-f]{6}$/i;
const safeCss = /^[^;{}\n]+$/;

export function parseTheme(json: string): Theme {
  const value = object(JSON.parse(json), "theme.json");
  const theme = Object.fromEntries([
    "backgroundPrimary", "backgroundSecondary", "backgroundTertiary", "backgroundAlternative",
    "textPrimary", "textSecondary", "textAlternative", "borderPrimary", "borderSecondary", "borderAlternative", "buttonText",
    "fontSans", "fontDisplay", "radius", "shadow",
  ].map((key) => [key, string(value[key], key)])) as Theme;
  for (const [key, value] of Object.entries(theme).slice(0, 11)) {
    if (!color.test(value)) throw new Error(`${key} must be a six-digit hex color`);
  }
  for (const [key, value] of Object.entries(theme).slice(11)) {
    if (!safeCss.test(value)) throw new Error(`${key} is not a safe CSS value`);
  }
  return theme;
}

export function applyTheme(css: string, theme: Theme) {
  const values: Record<string, string> = {
    "--color-background-primary": theme.backgroundPrimary,
    "--color-background-secondary": theme.backgroundSecondary,
    "--color-background-tertiary": theme.backgroundTertiary,
    "--color-background-alternative": theme.backgroundAlternative,
    "--color-text-primary": theme.textPrimary,
    "--color-text-secondary": theme.textSecondary,
    "--color-text-alternative": theme.textAlternative,
    "--color-border-primary": theme.borderPrimary,
    "--color-border-secondary": theme.borderSecondary,
    "--color-border-alternative": theme.borderAlternative,
    "--scheme-button-text": theme.buttonText,
    "--font-sans": theme.fontSans,
    "--font-display": theme.fontDisplay,
    "--shadow-card": theme.shadow,
  };
  for (const key of ["--radius-button", "--radius-card", "--radius-image", "--radius-form", "--radius-badge", "--radius-control"]) {
    values[key] = theme.radius;
  }
  return Object.entries(values).reduce((result, [key, value]) => {
    const pattern = new RegExp(`(${key.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&")}:)[^;]+;`);
    if (!pattern.test(result)) throw new Error(`Missing theme variable: ${key}`);
    return result.replace(pattern, `$1 ${value};`);
  }, css);
}

export function renderLayout(metadata: PagePlan["metadata"]) {
  return `import type { Metadata } from "next";\nimport "./globals.css";\n\nexport const metadata: Metadata = ${JSON.stringify(metadata, null, 2)};\n\nexport default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {\n  return (\n    <html lang="en">\n      <body>{children}</body>\n    </html>\n  );\n}\n`;
}
