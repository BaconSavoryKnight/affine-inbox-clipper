// Build an AFFiNE (BlockSuite) page as a Y.Doc from a simple block list.
//
// Block spec:
//   { type: "paragraph" | "h1".."h6" | "quote", deltas }
//   { type: "bulleted" | "numbered" | "todo", deltas, checked?, children?: [block] }
//   { type: "code", text, language? }
//   { type: "divider" }
//   { type: "bookmark", url, title?, description?, icon?, image? }
// deltas: [{ insert: "text", attributes?: { bold, italic, underline, strike, code, link } }]
import * as Y from "yjs";
import { generateId } from "./client.js";

const NOTE_XYWH = "[0,0,800,92]";

function sysFields(block, id, flavour) {
  block.set("sys:id", id);
  block.set("sys:flavour", flavour);
  block.set("sys:version", flavour === "affine:page" ? 2 : flavour === "affine:surface" ? 5 : 1);
  block.set("sys:parent", null);
}

export function makeText(deltas) {
  const t = new Y.Text();
  let offset = 0;
  for (const d of deltas || []) {
    if (!d || !d.insert) continue;
    const attrs = {};
    for (const [k, v] of Object.entries(d.attributes || {})) if (v) attrs[k] = v;
    t.insert(offset, d.insert, attrs);
    offset += d.insert.length;
  }
  return t;
}

export const txt = (s, attributes) => ({ insert: String(s ?? ""), ...(attributes ? { attributes } : {}) });

export function buildPageDoc(title, specs) {
  const doc = new Y.Doc();
  const blocks = doc.getMap("blocks");

  const pageId = generateId();
  const page = new Y.Map();
  blocks.set(pageId, page);
  sysFields(page, pageId, "affine:page");
  const titleText = new Y.Text();
  titleText.insert(0, title || "Untitled");
  page.set("prop:title", titleText);
  const pageChildren = new Y.Array();
  page.set("sys:children", pageChildren);

  const surfaceId = generateId();
  const surface = new Y.Map();
  blocks.set(surfaceId, surface);
  sysFields(surface, surfaceId, "affine:surface");
  surface.set("sys:children", new Y.Array());
  const elements = new Y.Map();
  elements.set("type", "$blocksuite:internal:native$");
  elements.set("value", new Y.Map());
  surface.set("prop:elements", elements);

  const noteId = generateId();
  const note = new Y.Map();
  blocks.set(noteId, note);
  sysFields(note, noteId, "affine:note");
  note.set("prop:displayMode", "both");
  note.set("prop:xywh", NOTE_XYWH);
  note.set("prop:index", "a0");
  note.set("prop:hidden", false);
  const bg = new Y.Map();
  bg.set("light", "#ffffff");
  bg.set("dark", "#252525");
  note.set("prop:background", bg);
  const noteChildren = new Y.Array();
  note.set("sys:children", noteChildren);

  pageChildren.push([surfaceId, noteId]);

  const ids = [];
  for (const spec of specs || []) {
    const id = addBlock(blocks, spec);
    if (id) ids.push(id);
  }
  if (!ids.length) ids.push(addBlock(blocks, { type: "paragraph", deltas: [] }));
  noteChildren.push(ids);
  return doc;
}

function addBlock(blocks, spec) {
  if (!spec || !spec.type) return null;
  const id = generateId();
  const b = new Y.Map();
  blocks.set(id, b);
  const children = new Y.Array();

  switch (spec.type) {
    case "paragraph":
    case "quote":
    case "h1":
    case "h2":
    case "h3":
    case "h4":
    case "h5":
    case "h6":
      sysFields(b, id, "affine:paragraph");
      b.set("prop:type", spec.type === "paragraph" ? "text" : spec.type);
      b.set("prop:text", makeText(spec.deltas));
      break;
    case "bulleted":
    case "numbered":
    case "todo":
      sysFields(b, id, "affine:list");
      b.set("prop:type", spec.type);
      b.set("prop:checked", spec.type === "todo" ? !!spec.checked : false);
      b.set("prop:text", makeText(spec.deltas));
      for (const child of spec.children || []) {
        const cid = addBlock(blocks, child);
        if (cid) children.push([cid]);
      }
      break;
    case "code":
      sysFields(b, id, "affine:code");
      b.set("prop:language", spec.language || "Plain Text");
      b.set("prop:wrap", false);
      b.set("prop:text", makeText([{ insert: spec.text || "" }]));
      break;
    case "divider":
      sysFields(b, id, "affine:divider");
      break;
    case "bookmark":
      sysFields(b, id, "affine:bookmark");
      b.set("prop:style", spec.style || "horizontal");
      b.set("prop:url", spec.url);
      b.set("prop:caption", null);
      b.set("prop:title", spec.title || null);
      b.set("prop:description", spec.description || null);
      b.set("prop:icon", spec.icon || null);
      b.set("prop:image", spec.image || null);
      b.set("prop:xywh", "[0,0,0,0]");
      b.set("prop:index", "a0");
      b.set("prop:lockedBySelf", false);
      b.set("prop:rotate", 0);
      b.set("prop:footnoteIdentifier", null);
      break;
    default:
      blocks.delete(id);
      return null;
  }
  b.set("sys:children", children);
  return id;
}
