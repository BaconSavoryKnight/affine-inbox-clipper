// Turns extracted page info + user choices into a title and block list.
import { txt } from "./affine/blocks.js";

export const MODES = {
  key: "Key info + link",
  snippet: "Brief snippet + link",
  selection: "Selection + link",
  full: "Full article",
};

function fmtDate(value) {
  if (!value) return "";
  const d = new Date(value);
  if (isNaN(d)) return String(value).slice(0, 40);
  return d.toISOString().slice(0, 10);
}

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function sourceLine(info) {
  const host = (() => {
    try {
      return new URL(info.url).hostname.replace(/^www\./, "");
    } catch {
      return info.url;
    }
  })();
  const d = [txt("Source: ", { bold: true }), txt(info.siteName || host, { link: info.url })];
  const extras = [];
  if (info.author) extras.push(`by ${info.author}`);
  if (info.published) extras.push(`published ${fmtDate(info.published)}`);
  if (info.readingMinutes) extras.push(`~${info.readingMinutes} min read`);
  extras.push(`clipped ${today()}`);
  d.push(txt("  ·  " + extras.join("  ·  ")));
  return { type: "paragraph", deltas: d };
}

function noteBlocks(note) {
  const text = String(note || "").trim();
  if (!text) return [];
  const lines = text.split(/\n+/).map((s) => s.trim()).filter(Boolean);
  return [
    { type: "paragraph", deltas: [txt("Why I saved this: ", { bold: true }), txt(lines[0])] },
    ...lines.slice(1).map((l) => ({ type: "paragraph", deltas: [txt(l)] })),
  ];
}

// "How X Works | Bread Lab" -> "How X Works" when the suffix is the site name.
export function cleanTitle(title, siteName) {
  const t = String(title || "").trim();
  if (!siteName) return t;
  const esc = siteName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const stripped = t.replace(new RegExp(`\\s+[|\\-–—:·•]\\s+${esc}\\s*$`, "i"), "").trim();
  return stripped.length >= 3 ? stripped : t;
}

export function composeClip(info, { mode = "key", note = "", title } = {}) {
  const blocks = [];
  if (mode === "selection" && !info.selection?.length) mode = "key";

  blocks.push({
    type: "bookmark",
    url: info.url,
    title: info.title,
    description: info.description || null,
    icon: info.favicon || null,
    image: info.image || null,
  });
  blocks.push(sourceLine(info));
  blocks.push(...noteBlocks(note));

  if (mode === "selection") {
    blocks.push({ type: "h3", deltas: [txt("Highlights")] });
    for (const p of info.selection) blocks.push({ type: "quote", deltas: [txt(p)] });
  } else if (mode === "snippet") {
    const snippet = info.description || info.intro?.[0] || "";
    if (snippet) blocks.push({ type: "quote", deltas: [txt(snippet)] });
  } else if (mode === "key") {
    if (info.description) {
      blocks.push({ type: "h3", deltas: [txt("Summary")] });
      blocks.push({ type: "paragraph", deltas: [txt(info.description)] });
    }
    const intro = (info.intro || []).filter((p) => p && p !== info.description);
    if (intro.length) {
      blocks.push({ type: "h3", deltas: [txt("Intro")] });
      for (const p of intro) blocks.push({ type: "paragraph", deltas: [txt(p)] });
    }
    if (info.outline?.length >= 2) {
      blocks.push({ type: "h3", deltas: [txt("Key sections")] });
      const minLevel = Math.min(...info.outline.map((h) => h.level));
      // nest deeper headings one level under the previous top-level heading
      let lastTop = null;
      for (const h of info.outline) {
        const item = { type: "bulleted", deltas: [txt(h.text)], children: [] };
        if (h.level > minLevel && lastTop) lastTop.children.push(item);
        else {
          blocks.push(item);
          lastTop = item;
        }
      }
    } else if (info.keyPoints?.length) {
      blocks.push({ type: "h3", deltas: [txt("Key points")] });
      for (const k of info.keyPoints) blocks.push({ type: "bulleted", deltas: [txt(k)] });
    }
    if (info.selection?.length) {
      blocks.push({ type: "h3", deltas: [txt("Highlights")] });
      for (const p of info.selection) blocks.push({ type: "quote", deltas: [txt(p)] });
    }
  } else if (mode === "full") {
    if (info.selection?.length) {
      blocks.push({ type: "h3", deltas: [txt("Highlights")] });
      for (const p of info.selection) blocks.push({ type: "quote", deltas: [txt(p)] });
    }
    blocks.push({ type: "divider" });
    blocks.push(...(info.article || []));
  }

  blocks.push({ type: "divider" });
  blocks.push({ type: "paragraph", deltas: [txt("Read the original → "), txt(info.url, { link: info.url })] });

  return { title: (title || cleanTitle(info.title, info.siteName) || info.url).trim(), blocks, mode };
}
