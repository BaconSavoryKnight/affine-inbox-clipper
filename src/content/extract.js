// Runs inside the page (injected on demand). Collects metadata, the user's
// selection, a reader-mode version of the article and converts it to the
// clipper's block spec. Result is returned to the background script.
import { Readability } from "@mozilla/readability";

const BLOCK_TAGS = new Set([
  "P", "H1", "H2", "H3", "H4", "H5", "H6", "UL", "OL", "LI", "BLOCKQUOTE", "PRE", "HR",
  "TABLE", "FIGURE", "SECTION", "ARTICLE", "DIV", "HEADER", "FOOTER", "MAIN", "ASIDE", "DL", "DT", "DD",
]);
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "SVG", "BUTTON", "FORM", "IFRAME", "INPUT", "SELECT", "TEXTAREA"]);

function meta(doc, ...names) {
  for (const n of names) {
    const el =
      doc.querySelector(`meta[property="${n}"]`) ||
      doc.querySelector(`meta[name="${n}"]`) ||
      doc.querySelector(`meta[itemprop="${n}"]`);
    const v = el?.getAttribute("content")?.trim();
    if (v) return v;
  }
  return "";
}

function absUrl(href, base) {
  try {
    const u = new URL(href, base);
    return /^(https?|mailto):$/.test(u.protocol) ? u.href : "";
  } catch {
    return "";
  }
}

function clean(s) {
  return String(s || "").replace(/\s+/g, " ");
}

// ---- inline → deltas ----
function inlineDeltas(node, base, attrs = {}, out = []) {
  for (const child of node.childNodes) {
    if (child.nodeType === 3) {
      const text = clean(child.nodeValue);
      if (text) out.push({ insert: text, attributes: { ...attrs } });
      continue;
    }
    if (child.nodeType !== 1) continue;
    const tag = child.tagName;
    if (SKIP_TAGS.has(tag)) continue;
    if (tag === "BR") {
      out.push({ insert: "\n", attributes: { ...attrs } });
      continue;
    }
    const next = { ...attrs };
    if (tag === "B" || tag === "STRONG") next.bold = true;
    if (tag === "I" || tag === "EM") next.italic = true;
    if (tag === "U") next.underline = true;
    if (tag === "S" || tag === "DEL" || tag === "STRIKE") next.strike = true;
    if (tag === "CODE" || tag === "KBD" || tag === "SAMP") next.code = true;
    if (tag === "A") {
      const href = absUrl(child.getAttribute("href"), base);
      if (href) next.link = href;
    }
    if (tag === "IMG") {
      const alt = clean(child.getAttribute("alt"));
      const src = absUrl(child.getAttribute("src"), base);
      if (src) out.push({ insert: alt ? `[image: ${alt}]` : "[image]", attributes: { link: src } });
      continue;
    }
    inlineDeltas(child, base, next, out);
  }
  return out;
}

function tidy(deltas) {
  // merge neighbours with identical attributes, trim edges, collapse spaces
  const merged = [];
  for (const d of deltas) {
    const prev = merged.at(-1);
    if (prev && JSON.stringify(prev.attributes || {}) === JSON.stringify(d.attributes || {})) prev.insert += d.insert;
    else merged.push({ insert: d.insert, attributes: d.attributes });
  }
  for (const d of merged) d.insert = d.insert.replace(/ {2,}/g, " ").replace(/ ?\n ?/g, "\n");
  if (merged.length) {
    merged[0].insert = merged[0].insert.replace(/^\s+/, "");
    merged[merged.length - 1].insert = merged[merged.length - 1].insert.replace(/\s+$/, "");
  }
  return merged.filter((d) => d.insert.length);
}

const plain = (deltas) => deltas.map((d) => d.insert).join("");

function hasBlockChild(el) {
  for (const c of el.children) if (BLOCK_TAGS.has(c.tagName)) return true;
  return false;
}

// ---- block conversion ----
function listBlocks(listEl, base, ordered) {
  const out = [];
  for (const li of listEl.children) {
    if (li.tagName !== "LI") continue;
    const inlineHost = li.cloneNode(true);
    for (const sub of inlineHost.querySelectorAll("ul,ol")) sub.remove();
    const deltas = tidy(inlineDeltas(inlineHost, base));
    const children = [];
    for (const sub of li.querySelectorAll(":scope > ul, :scope > ol")) {
      children.push(...listBlocks(sub, base, sub.tagName === "OL"));
    }
    const isTodo = !!li.querySelector(':scope > input[type="checkbox"]');
    out.push({
      type: isTodo ? "todo" : ordered ? "numbered" : "bulleted",
      checked: isTodo ? !!li.querySelector(':scope > input[type="checkbox"]')?.checked : undefined,
      deltas,
      children,
    });
  }
  return out;
}

export function htmlToBlocks(root, base) {
  const out = [];
  const walk = (el) => {
    for (const node of el.childNodes) {
      if (node.nodeType === 3) {
        const t = clean(node.nodeValue).trim();
        if (t) out.push({ type: "paragraph", deltas: [{ insert: t }] });
        continue;
      }
      if (node.nodeType !== 1) continue;
      const tag = node.tagName;
      if (SKIP_TAGS.has(tag)) continue;
      if (/^H[1-6]$/.test(tag)) {
        const deltas = tidy(inlineDeltas(node, base));
        if (deltas.length) out.push({ type: "h" + Math.min(6, Math.max(2, Number(tag[1]))), deltas });
      } else if (tag === "P" || tag === "DT" || tag === "DD") {
        const deltas = tidy(inlineDeltas(node, base));
        if (deltas.length) out.push({ type: "paragraph", deltas });
      } else if (tag === "UL" || tag === "OL") {
        out.push(...listBlocks(node, base, tag === "OL"));
      } else if (tag === "BLOCKQUOTE") {
        if (hasBlockChild(node)) {
          for (const p of node.querySelectorAll("p")) {
            const deltas = tidy(inlineDeltas(p, base));
            if (deltas.length) out.push({ type: "quote", deltas });
          }
        } else {
          const deltas = tidy(inlineDeltas(node, base));
          if (deltas.length) out.push({ type: "quote", deltas });
        }
      } else if (tag === "PRE") {
        const code = node.textContent.replace(/\n$/, "");
        const lang = (node.querySelector("code")?.className.match(/language-([\w+#-]+)/) || [])[1];
        if (code.trim()) out.push({ type: "code", text: code, language: lang || "Plain Text" });
      } else if (tag === "HR") {
        out.push({ type: "divider" });
      } else if (tag === "TABLE") {
        for (const tr of node.querySelectorAll("tr")) {
          const cells = [...tr.children].map((c) => clean(c.textContent).trim()).filter(Boolean);
          if (cells.length) out.push({ type: "paragraph", deltas: [{ insert: cells.join("  |  ") }] });
        }
      } else if (tag === "IMG") {
        const d = tidy(inlineDeltas({ childNodes: [node] }, base));
        if (d.length) out.push({ type: "paragraph", deltas: d });
      } else if (BLOCK_TAGS.has(tag) || hasBlockChild(node)) {
        walk(node);
      } else {
        const deltas = tidy(inlineDeltas({ childNodes: [node] }, base));
        if (deltas.length) out.push({ type: "paragraph", deltas });
      }
    }
  };
  walk(root);
  return out;
}

function truncate(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max);
  const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
  return (stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.replace(/\s+\S*$/, "") + "…").trim();
}

function firstSentence(text) {
  const m = text.match(/^(.{20,220}?[.!?])(\s|$)/);
  return m ? m[1] : truncate(text, 180);
}

function selectionParagraphs() {
  const sel = window.getSelection?.();
  if (!sel || sel.isCollapsed) return [];
  return String(sel.toString())
    .split(/\n{2,}|\r\n\r\n/)
    .map((s) => s.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, 50);
}

function jsonLd(doc) {
  const out = {};
  for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
    try {
      const data = JSON.parse(s.textContent);
      const items = Array.isArray(data) ? data : data["@graph"] || [data];
      for (const it of items) {
        if (!it || typeof it !== "object") continue;
        out.published ||= it.datePublished;
        const a = Array.isArray(it.author) ? it.author[0] : it.author;
        out.author ||= typeof a === "string" ? a : a?.name;
      }
    } catch {}
  }
  return out;
}

export function extractPage({ introParagraphs = 2, maxOutline = 12 } = {}) {
  const doc = document;
  const url = location.href;
  const ld = jsonLd(doc);
  const info = {
    url,
    title: meta(doc, "og:title", "twitter:title") || doc.title || url,
    siteName: meta(doc, "og:site_name", "application-name") || location.hostname.replace(/^www\./, ""),
    description: meta(doc, "og:description", "twitter:description", "description"),
    author: meta(doc, "author", "article:author", "parsely-author") || ld.author || "",
    published: meta(doc, "article:published_time", "datePublished", "date", "pubdate") || ld.published || "",
    image: absUrl(meta(doc, "og:image", "twitter:image"), url),
    favicon: absUrl(
      doc.querySelector('link[rel~="icon"]')?.getAttribute("href") || "/favicon.ico",
      url,
    ),
    selection: selectionParagraphs(),
    intro: [],
    outline: [],
    keyPoints: [],
    article: [],
    readingMinutes: 0,
  };

  let article = null;
  try {
    article = new Readability(doc.cloneNode(true), { charThreshold: 300 }).parse();
  } catch {}

  let blocks = [];
  if (article?.content) {
    const parsed = new DOMParser().parseFromString(article.content, "text/html");
    blocks = htmlToBlocks(parsed.body, url);
    if (article.title && info.title === url) info.title = article.title;
    info.author ||= clean(article.byline || "").trim();
    info.description ||= clean(article.excerpt || "").trim();
    info.siteName = info.siteName || article.siteName || "";
    const words = (article.textContent || "").trim().split(/\s+/).length;
    info.readingMinutes = Math.max(1, Math.round(words / 230));
  } else {
    blocks = htmlToBlocks(doc.querySelector("main, article, [role=main]") || doc.body, url);
  }
  info.article = blocks.slice(0, 1500);

  const paras = blocks.filter((b) => b.type === "paragraph" && plain(b.deltas).length >= 80);
  info.intro = paras.slice(0, introParagraphs).map((b) => truncate(plain(b.deltas), 600));
  info.outline = blocks
    .filter((b) => /^h[2-4]$/.test(b.type))
    .map((b) => ({ level: Number(b.type[1]), text: truncate(plain(b.deltas), 140) }))
    .filter((h) => h.text && !/^(share|related|comments?|subscribe|newsletter|advertisement)/i.test(h.text))
    .slice(0, maxOutline);
  info.keyPoints = paras
    .slice(introParagraphs, introParagraphs + 6)
    .map((b) => firstSentence(plain(b.deltas)));

  info.title = clean(info.title).trim();
  info.description = truncate(clean(info.description).trim(), 400);
  return info;
}
