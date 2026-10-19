const $ = (id) => document.getElementById(id);
const send = (msg) => browser.runtime.sendMessage(msg);

const DEFAULTS = {
  serverUrl: "https://app.affine.pro",
  workspaceId: "",
  workspaceName: "",
  inboxFolderId: "",
  inboxFolderName: "",
  defaultMode: "key",
  defaultTags: "",
  introParagraphs: 2,
  openAfterClip: false,
};

function status(id, text, kind = "") {
  $(id).className = "status " + kind;
  $(id).textContent = text;
}

function normUrl(v) {
  let s = String(v || "").trim().replace(/\/+$/, "");
  if (s && !/^https?:\/\//i.test(s)) s = "https://" + s;
  return s;
}

let current = { ...DEFAULTS };

function fillSelect(sel, items, selectedId, emptyLabel) {
  sel.textContent = "";
  if (!items.length) {
    const o = document.createElement("option");
    o.value = "";
    o.textContent = emptyLabel;
    sel.appendChild(o);
    return;
  }
  for (const it of items) {
    const o = document.createElement("option");
    o.value = it.id;
    o.textContent = it.label;
    if (it.id === selectedId) o.selected = true;
    sel.appendChild(o);
  }
}

async function loadFolders(preferId) {
  const workspaceId = $("workspace").value;
  if (!workspaceId) return;
  status("wsStatus", "Loading folders…");
  const r = await send({ type: "folders", serverUrl: normUrl($("serverUrl").value), workspaceId });
  if (!r?.ok) return status("wsStatus", r?.error || "Could not load folders.", "err");
  const folders = r.data;
  let selected = preferId || current.inboxFolderId;
  if (!folders.some((f) => f.id === selected)) {
    selected = folders.find((f) => f.name?.trim().toLowerCase() === "inbox")?.id || "";
  }
  fillSelect(
    $("folder"),
    [{ id: "", label: "— don't file into a folder —" }, ...folders.map((f) => ({ id: f.id, label: f.path }))],
    selected,
    "No folders yet",
  );
  status(
    "wsStatus",
    selected ? "" : folders.length ? "Pick your Inbox folder, or create one below." : "No folders yet — create an Inbox folder below.",
    selected ? "" : "warn",
  );
}

async function connect() {
  const serverUrl = normUrl($("serverUrl").value);
  $("serverUrl").value = serverUrl;
  let origin;
  try {
    origin = new URL(serverUrl).origin;
  } catch {
    return status("connStatus", "That doesn't look like a valid URL.", "err");
  }
  // Must be called synchronously inside the click handler.
  const granted = await browser.permissions.request({ origins: [origin + "/*"] });
  if (!granted) return status("connStatus", "Permission to reach the AFFiNE server was declined.", "err");

  status("connStatus", "Connecting…");
  const r = await send({ type: "connect", serverUrl });
  if (!r?.ok) {
    const hint = r?.code === "AUTH" ? " Sign in at " + serverUrl + " in a normal tab, then click Connect again." : "";
    return status("connStatus", (r?.error || "Could not connect.") + hint, "err");
  }
  const { user, workspaces, version } = r.data;
  status("connStatus", `Connected as ${user.name || user.email} · AFFiNE ${version}`, "ok");
  $("wsSection").hidden = false;
  fillSelect(
    $("workspace"),
    workspaces.map((w) => ({ id: w.id, label: w.name })),
    current.workspaceId || workspaces[0]?.id,
    "No workspaces found",
  );
  await loadFolders();
}

async function createFolder() {
  const name = $("newFolder").value.trim();
  if (!name) return;
  status("wsStatus", "Creating folder…");
  const r = await send({
    type: "createFolder",
    serverUrl: normUrl($("serverUrl").value),
    workspaceId: $("workspace").value,
    name,
  });
  if (!r?.ok) return status("wsStatus", r?.error || "Could not create the folder.", "err");
  await loadFolders(r.data.id);
  status("wsStatus", `Created “${name}”. Remember to Save settings.`, "ok");
}

async function save() {
  const ws = $("workspace");
  const folder = $("folder");
  const next = {
    serverUrl: normUrl($("serverUrl").value) || DEFAULTS.serverUrl,
    defaultMode: $("defaultMode").value,
    defaultTags: $("defaultTags").value.trim(),
    introParagraphs: Math.max(0, Math.min(6, Number($("introParagraphs").value) || 0)),
    openAfterClip: $("openAfterClip").checked,
  };
  if (!$("wsSection").hidden && ws.value) {
    next.workspaceId = ws.value;
    next.workspaceName = ws.selectedOptions[0]?.textContent || "";
    next.inboxFolderId = folder.value;
    next.inboxFolderName = folder.value ? folder.selectedOptions[0]?.textContent || "" : "";
  }
  await browser.storage.local.set(next);
  current = { ...current, ...next };
  const warn = !current.workspaceId
    ? " Connect and pick a workspace to start clipping."
    : !current.inboxFolderId
      ? " No Inbox folder chosen — clips will land in All docs only."
      : "";
  status("saveStatus", "Saved." + warn, warn ? "warn" : "ok");
}

async function init() {
  current = { ...DEFAULTS, ...(await browser.storage.local.get(DEFAULTS)) };
  $("serverUrl").value = current.serverUrl;
  $("defaultMode").value = current.defaultMode;
  $("defaultTags").value = current.defaultTags;
  $("introParagraphs").value = current.introParagraphs;
  $("openAfterClip").checked = !!current.openAfterClip;
  $("connect").onclick = connect;
  $("workspace").onchange = () => loadFolders();
  $("refreshFolders").onclick = () => loadFolders($("folder").value);
  $("createFolder").onclick = createFolder;
  $("save").onclick = save;
  if (current.workspaceId) {
    status("connStatus", `Using ${current.workspaceName || current.workspaceId} → ${current.inboxFolderName || "(no folder)"}. Click Connect to change.`);
  }
}

init();
