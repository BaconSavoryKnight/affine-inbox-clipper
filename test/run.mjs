import { build } from "esbuild";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
import * as Y from "yjs";
import http from "node:http";
import { Server } from "socket.io";

// 1) extraction in a jsdom page
const html = readFileSync(new URL("./fixture.html", import.meta.url), "utf8");
const dom = new JSDOM(html, { url: "https://breadlab.example/articles/sourdough", runScripts: "outside-only" });
const sel = dom.window.getSelection();
const r = dom.window.document.createRange();
const p = dom.window.document.querySelectorAll("p")[1];
r.selectNodeContents(p); sel.addRange(r);
const bundle = await build({ entryPoints: ["src/content/entry.js"], bundle: true, write: false, format: "iife" });
dom.window.eval(bundle.outputFiles[0].text);
const info = dom.window.__affineInboxClipExtract({ introParagraphs: 2 });
if (info.error) throw new Error(info.error);
console.log("INFO", JSON.stringify({ ...info, article: info.article.length + " blocks" }, null, 1));

// 2) compose + build doc
globalThis.crypto ??= (await import("node:crypto")).webcrypto;
const { composeClip } = await import("../src/compose.js");
const { buildPageDoc } = await import("../src/affine/blocks.js");
for (const mode of ["key", "snippet", "selection", "full"]) {
  const c = composeClip(info, { mode, note: "Try the rye trick" });
  const doc = buildPageDoc(c.title, c.blocks);
  const blocks = doc.getMap("blocks").toJSON();
  const flav = Object.values(blocks).map((b) => b["sys:flavour"] + (b["prop:type"] ? ":" + b["prop:type"] : ""));
  console.log("MODE", mode, c.blocks.length, "specs ->", flav.length, "blocks");
  if (mode === "key") for (const b of c.blocks) console.log("   ", b.type, JSON.stringify(b.deltas?.map(d=>d.insert).join("") ?? b.url ?? "").slice(0, 100), b.children?.length ? `(+${b.children.length} children)` : "");
  // structural checks
  const page = Object.values(blocks).find((b) => b["sys:flavour"] === "affine:page");
  for (const id of Object.values(blocks).flatMap((b) => b["sys:children"])) if (!blocks[id]) throw new Error("dangling child " + id);
  if (page["prop:title"] !== c.title) throw new Error("title mismatch");
}
const linkDelta = buildPageDoc("t", composeClip(info, { mode: "key" }).blocks).getMap("blocks");
let foundLink = false;
linkDelta.forEach((b) => { const t = b.get("prop:text"); if (t) for (const d of t.toDelta()) if (d.attributes?.link) foundLink = true; });
console.log("rich-text link attrs present:", foundLink);

// 3) mock AFFiNE server: graphql + socket.io sync
const WS = "ws-123";
const store = new Map(); // docId -> Y.Doc
const getDoc = (id) => { if (!store.has(id)) store.set(id, new Y.Doc()); return store.get(id); };
// seed workspace root + a folders doc with an "Inbox" folder
getDoc(WS).getMap("meta").set("name", "Second Brain");
getDoc(WS).getMap("meta").set("pages", new Y.Array());
const fd = getDoc(`db$${WS}$folders`); const f = fd.getMap("folder-inbox");
f.set("id", "folder-inbox"); f.set("type", "folder"); f.set("data", "Inbox"); f.set("parentId", null); f.set("index", "a0");
const seen = { headers: null, joins: [] };
const srv = http.createServer((req, res) => {
  let body = ""; req.on("data", (c) => (body += c)); req.on("end", () => {
    seen.headers = req.headers;
    const q = JSON.parse(body).query; const data = {};
    if (q.includes("serverConfig")) data.serverConfig = { version: "0.27.4" };
    if (q.includes("currentUser")) data.currentUser = { id: "u1", name: "Bacon", email: "b@x" };
    if (q.includes("workspaces")) data.workspaces = [{ id: WS }];
    res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ data }));
  });
});
const io = new Server(srv, { path: "/socket.io/" });
io.on("connection", (s) => {
  s.on("space:join", (p, ack) => { seen.joins.push(p); ack({ data: { clientId: s.id } }); });
  s.on("space:load-doc", (p, ack) => {
    if (!store.has(p.docId)) return ack({ error: { name: "DOC_NOT_FOUND" } });
    ack({ data: { missing: Buffer.from(Y.encodeStateAsUpdate(store.get(p.docId))).toString("base64"), state: "", timestamp: Date.now() } });
  });
  s.on("space:push-doc-update", (p, ack) => { Y.applyUpdate(getDoc(p.docId), Buffer.from(p.update, "base64")); ack({ data: { accepted: true, timestamp: Date.now() } }); });
});
await new Promise((r) => srv.listen(0, r));
const base = `http://127.0.0.1:${srv.address().port}`;
const { AffineClient } = await import("../src/affine/client.js");
const client = new AffineClient(base);
console.log("version:", await client.detectVersion(), "| workspace name:", await client.workspaceName(WS));
console.log("folders:", JSON.stringify(await client.listFolders(WS)));
const c = composeClip(info, { mode: "key", note: "check later" }); console.log("clean title:", c.title);
const res = await client.createDocInFolder({ workspaceId: WS, folderId: "folder-inbox", title: c.title, ydoc: buildPageDoc(c.title, c.blocks), tags: ["clipped", "bread"] });
console.log("create result:", res);
const sub = await client.createFolder(WS, "Reading", "folder-inbox");
console.log("folders after:", JSON.stringify((await client.listFolders(WS)).map(f=>f.path)));
client.disconnect();
const meta = store.get(WS).getMap("meta").toJSON();
console.log("meta.pages:", JSON.stringify(meta.pages));
console.log("tag options:", JSON.stringify(meta.properties.tags.options.map(o=>o.value)));
const links = AffineClient.readOrganizeNodes(store.get(`db$${WS}$folders`)).filter((n) => n.type === "doc");
console.log("folder links:", JSON.stringify(links));
console.log("creator:", JSON.stringify(store.get(`db$${WS}$docProperties`).getMap(res.docId).toJSON()));
console.log("stored page blocks:", Object.keys(store.get(res.docId).getMap("blocks").toJSON()).length);
console.log("x-affine-version header:", seen.headers["x-affine-version"], "| join clientVersion:", seen.joins[0].clientVersion);
const ok = links.length === 1 && links[0].data === res.docId && links[0].parentId === "folder-inbox" && meta.pages.some(p => p.id === res.docId && p.tags.length === 2) && res.filed;
console.log(ok ? "ALL CHECKS PASSED" : "CHECKS FAILED");
io.close(); srv.close(); process.exit(ok ? 0 : 1);
