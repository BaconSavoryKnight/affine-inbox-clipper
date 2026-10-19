// Minimal AFFiNE client for a browser extension.
// Auth: the browser session cookie for the AFFiNE server (sign in to AFFiNE
// in a normal tab once). Writes go through AFFiNE's realtime socket as Yjs
// updates, the same way the AFFiNE web app saves documents.
import { io } from "socket.io-client";
import * as Y from "yjs";
import { generateKeyBetween } from "fractional-indexing";

const FALLBACK_CLIENT_VERSION = "0.26.0";
const ACK_TIMEOUT_MS = 15000;

// ---------- small utils ----------
export function toBase64(bytes) {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}
export function fromBase64(b64) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
const ID_CHARS = "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz-_";
export function generateId(length = 21, chars = ID_CHARS) {
  const buf = new Uint8Array(length);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < length; i++) s += chars[buf[i] % chars.length];
  return s;
}

// Matches AFFiNE's fractional-indexing helper (key + "0" + random postfix).
export function nextIndexAfter(lastIndex) {
  const postfix = generateId(32, "123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz");
  let base = null;
  if (lastIndex) base = lastIndex.length > 33 ? lastIndex.slice(0, lastIndex.length - 33) : lastIndex;
  let key;
  try {
    key = generateKeyBetween(base, null);
  } catch {
    key = generateKeyBetween(null, null);
  }
  return key + "0" + postfix;
}

function normalizeBaseUrl(url) {
  return String(url || "").trim().replace(/\/+$/, "");
}

// ---------- client ----------
export class AffineClient {
  constructor(baseUrl, { clientVersion } = {}) {
    this.baseUrl = normalizeBaseUrl(baseUrl);
    this.clientVersion = clientVersion || null;
    this.socket = null;
    this.joined = new Set();
  }

  // ---- GraphQL ----
  async gql(query, variables = {}) {
    const res = await fetch(`${this.baseUrl}/graphql`, {
      method: "POST",
      credentials: "include",
      headers: {
        "content-type": "application/json",
        "x-affine-version": this.clientVersion || FALLBACK_CLIENT_VERSION,
      },
      body: JSON.stringify({ query, variables }),
    });
    let json = null;
    try {
      json = await res.json();
    } catch {
      throw new Error(`AFFiNE returned a non-JSON response (HTTP ${res.status}). Check the server URL.`);
    }
    if (json?.errors?.length) {
      const msg = json.errors.map((e) => e.message).join("; ");
      const err = new Error(msg);
      if (/auth|sign ?in|login|unauthor/i.test(msg) || res.status === 401) err.code = "AUTH";
      throw err;
    }
    if (!res.ok) throw new Error(`AFFiNE HTTP ${res.status}`);
    return json.data;
  }

  async detectVersion() {
    if (this.clientVersion) return this.clientVersion;
    try {
      const d = await this.gql("query { serverConfig { version } }");
      const v = d?.serverConfig?.version;
      if (typeof v === "string" && /^\d+\.\d+/.test(v)) this.clientVersion = v.replace(/[-+].*$/, "");
    } catch {
      /* fall through */
    }
    if (!this.clientVersion) this.clientVersion = FALLBACK_CLIENT_VERSION;
    return this.clientVersion;
  }

  async currentUser() {
    const d = await this.gql("query { currentUser { id name email } }");
    if (!d?.currentUser) {
      const e = new Error("Not signed in to AFFiNE. Open your AFFiNE server in a tab and sign in, then try again.");
      e.code = "AUTH";
      throw e;
    }
    return d.currentUser;
  }

  async listWorkspaceIds() {
    const d = await this.gql("query { workspaces { id } }");
    return (d?.workspaces || []).map((w) => w.id);
  }

  // ---- socket ----
  async connect() {
    if (this.socket?.connected) return this.socket;
    await this.detectVersion();
    this.socket = await new Promise((resolve, reject) => {
      const s = io(this.baseUrl, {
        path: "/socket.io/",
        transports: ["websocket", "polling"],
        withCredentials: true,
        reconnection: false,
        timeout: ACK_TIMEOUT_MS,
      });
      const t = setTimeout(() => {
        s.disconnect();
        reject(new Error("Timed out connecting to AFFiNE realtime server."));
      }, ACK_TIMEOUT_MS);
      s.once("connect", () => {
        clearTimeout(t);
        resolve(s);
      });
      s.once("connect_error", (err) => {
        clearTimeout(t);
        s.disconnect();
        reject(new Error(`Could not connect to AFFiNE realtime server: ${err?.message || err}`));
      });
    });
    this.joined.clear();
    return this.socket;
  }

  disconnect() {
    try {
      this.socket?.disconnect();
    } catch {}
    this.socket = null;
    this.joined.clear();
  }

  emitAck(event, payload) {
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error(`${event} timed out`)), ACK_TIMEOUT_MS);
      this.socket.emit(event, payload, (ack) => {
        clearTimeout(t);
        resolve(ack);
      });
    });
  }

  async join(workspaceId) {
    await this.connect();
    if (this.joined.has(workspaceId)) return;
    const ack = await this.emitAck("space:join", {
      spaceType: "workspace",
      spaceId: workspaceId,
      clientVersion: this.clientVersion,
    });
    if (ack?.error) throw new Error(`Could not open workspace: ${ack.error.message || ack.error.name || "join failed"}`);
    this.joined.add(workspaceId);
  }

  // Returns a Y.Doc (empty if the doc does not exist yet).
  async loadDoc(workspaceId, docId) {
    await this.join(workspaceId);
    const ack = await this.emitAck("space:load-doc", { spaceType: "workspace", spaceId: workspaceId, docId });
    const doc = new Y.Doc();
    if (ack?.error) {
      if (ack.error.name === "DOC_NOT_FOUND") return { doc, exists: false };
      throw new Error(`load-doc failed: ${ack.error.message || ack.error.name}`);
    }
    const missing = ack?.data?.missing;
    if (typeof missing === "string" && missing.length) Y.applyUpdate(doc, fromBase64(missing));
    return { doc, exists: typeof missing === "string" };
  }

  async pushUpdate(workspaceId, docId, update) {
    await this.join(workspaceId);
    const ack = await this.emitAck("space:push-doc-update", {
      spaceType: "workspace",
      spaceId: workspaceId,
      docId,
      update: toBase64(update),
    });
    if (ack?.error) throw new Error(`Saving to AFFiNE failed: ${ack.error.message || ack.error.name}`);
    return ack?.data?.timestamp || Date.now();
  }

  // Load a doc, run a mutation, push only the delta.
  async mutateDoc(workspaceId, docId, fn) {
    const { doc } = await this.loadDoc(workspaceId, docId);
    const before = Y.encodeStateVector(doc);
    const result = await fn(doc);
    const delta = Y.encodeStateAsUpdate(doc, before);
    await this.pushUpdate(workspaceId, docId, delta);
    doc.destroy();
    return result;
  }

  // ---- workspace info ----
  async workspaceName(workspaceId) {
    const { doc } = await this.loadDoc(workspaceId, workspaceId);
    const name = doc.getMap("meta").get("name");
    doc.destroy();
    return typeof name === "string" && name ? name : workspaceId;
  }

  foldersDocId(workspaceId) {
    return `db$${workspaceId}$folders`;
  }
  docPropertiesDocId(workspaceId) {
    return `db$${workspaceId}$docProperties`;
  }

  static readOrganizeNodes(doc) {
    const nodes = [];
    for (const key of doc.share.keys()) {
      const rec = doc.getMap(key);
      if (!rec || rec.size === 0 || rec.get("$$DELETED") === true) continue;
      const r = rec.toJSON();
      if (typeof r.id !== "string" || typeof r.type !== "string" || typeof r.index !== "string") continue;
      nodes.push({ id: r.id, type: r.type, data: r.data, parentId: r.parentId ?? null, index: r.index });
    }
    return nodes;
  }

  // Folder list with a readable path ("Projects / Web"), sorted like the sidebar.
  async listFolders(workspaceId) {
    const { doc } = await this.loadDoc(workspaceId, this.foldersDocId(workspaceId));
    const nodes = AffineClient.readOrganizeNodes(doc).filter((n) => n.type === "folder");
    doc.destroy();
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const pathOf = (n) => {
      const parts = [];
      let cur = n;
      const seen = new Set();
      while (cur && !seen.has(cur.id)) {
        seen.add(cur.id);
        parts.unshift(cur.data || "(unnamed)");
        cur = cur.parentId ? byId.get(cur.parentId) : null;
      }
      return parts.join(" / ");
    };
    return nodes.map((n) => ({ id: n.id, name: n.data, path: pathOf(n), parentId: n.parentId })).sort((a, b) => a.path.localeCompare(b.path));
  }

  async createFolder(workspaceId, name, parentId = null) {
    const id = generateId();
    await this.mutateDoc(workspaceId, this.foldersDocId(workspaceId), (doc) => {
      const siblings = AffineClient.readOrganizeNodes(doc)
        .filter((n) => n.parentId === parentId)
        .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
      const rec = doc.getMap(id);
      rec.set("id", id);
      rec.set("type", "folder");
      rec.set("data", name);
      rec.set("parentId", parentId);
      rec.set("index", nextIndexAfter(siblings.at(-1)?.index ?? null));
    });
    return { id, name };
  }

  async addDocToFolder(workspaceId, folderId, docId) {
    const linkId = generateId();
    await this.mutateDoc(workspaceId, this.foldersDocId(workspaceId), (doc) => {
      const nodes = AffineClient.readOrganizeNodes(doc);
      const folder = nodes.find((n) => n.id === folderId && n.type === "folder");
      if (!folder) throw new Error("The Inbox folder no longer exists. Pick it again in the clipper's settings.");
      const siblings = nodes
        .filter((n) => n.parentId === folderId)
        .sort((a, b) => (a.index < b.index ? -1 : a.index > b.index ? 1 : 0));
      const rec = doc.getMap(linkId);
      rec.set("id", linkId);
      rec.set("type", "doc");
      rec.set("data", docId);
      rec.set("parentId", folderId);
      rec.set("index", nextIndexAfter(siblings.at(-1)?.index ?? null));
    });
    return linkId;
  }

  // Register the page in workspace metadata (sidebar "All docs"), with tags.
  async registerPage(workspaceId, docId, title, tagNames = []) {
    await this.mutateDoc(workspaceId, workspaceId, (doc) => {
      const meta = doc.getMap("meta");
      let pages = meta.get("pages");
      if (!(pages instanceof Y.Array)) {
        pages = new Y.Array();
        meta.set("pages", pages);
      }
      const tagIds = tagNames.length ? ensureTagOptions(meta, tagNames) : [];
      const now = Date.now();
      const entry = new Y.Map();
      entry.set("id", docId);
      entry.set("title", title);
      entry.set("createDate", now);
      entry.set("updatedDate", now);
      const tags = new Y.Array();
      if (tagIds.length) tags.push(tagIds);
      entry.set("tags", tags);
      pages.push([entry]);
    });
  }

  async setCreator(workspaceId, docId, userId) {
    try {
      await this.mutateDoc(workspaceId, this.docPropertiesDocId(workspaceId), (doc) => {
        const rec = doc.getMap(docId);
        rec.set("id", docId);
        if (!rec.get("createdBy")) rec.set("createdBy", userId);
      });
    } catch {
      /* cosmetic only */
    }
  }

  // Full create flow. `ydoc` is a Y.Doc built by buildPageDoc().
  async createDocInFolder({ workspaceId, folderId, title, ydoc, tags = [] }) {
    const user = await this.currentUser();
    await this.join(workspaceId);
    const docId = generateId();
    await this.pushUpdate(workspaceId, docId, Y.encodeStateAsUpdate(ydoc));
    await this.registerPage(workspaceId, docId, title, tags);
    await this.setCreator(workspaceId, docId, user.id);
    let filed = false;
    let fileError = null;
    if (folderId) {
      try {
        await this.addDocToFolder(workspaceId, folderId, docId);
        filed = true;
      } catch (e) {
        fileError = e.message;
      }
    }
    return { docId, url: `${this.baseUrl}/workspace/${workspaceId}/${docId}`, filed, fileError };
  }
}

const TAG_COLORS = [
  "var(--affine-tag-blue)", "var(--affine-tag-green)", "var(--affine-tag-red)",
  "var(--affine-tag-orange)", "var(--affine-tag-purple)", "var(--affine-tag-yellow)",
  "var(--affine-tag-teal)", "var(--affine-tag-pink)", "var(--affine-tag-gray)",
];

function ensureYMap(parent, key) {
  let m = parent.get(key);
  if (!(m instanceof Y.Map)) {
    m = new Y.Map();
    parent.set(key, m);
  }
  return m;
}

// Returns tag option ids for the given names, creating options as needed.
function ensureTagOptions(meta, names) {
  const tagsMap = ensureYMap(ensureYMap(meta, "properties"), "tags");
  let options = tagsMap.get("options");
  if (!(options instanceof Y.Array)) {
    options = new Y.Array();
    tagsMap.set("options", options);
  }
  const existing = [];
  options.forEach((o) => {
    const id = o instanceof Y.Map ? o.get("id") : o?.id;
    const value = o instanceof Y.Map ? o.get("value") : o?.value;
    if (typeof id === "string" && typeof value === "string") existing.push({ id, value });
  });
  const ids = [];
  for (const raw of names) {
    const name = String(raw).trim();
    if (!name) continue;
    const hit = existing.find((o) => o.value.toLowerCase() === name.toLowerCase());
    if (hit) {
      if (!ids.includes(hit.id)) ids.push(hit.id);
      continue;
    }
    const now = Date.now();
    const id = generateId();
    const opt = new Y.Map();
    opt.set("id", id);
    opt.set("value", name);
    opt.set("color", TAG_COLORS[existing.length % TAG_COLORS.length]);
    opt.set("createDate", now);
    opt.set("updateDate", now);
    options.push([opt]);
    existing.push({ id, value: name });
    ids.push(id);
  }
  return ids;
}
