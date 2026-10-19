import { AffineClient } from "./affine/client.js";
import { buildPageDoc } from "./affine/blocks.js";
import { composeClip, cleanTitle } from "./compose.js";

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

export async function getSettings() {
  const s = await browser.storage.local.get(DEFAULTS);
  return { ...DEFAULTS, ...s };
}

function originPattern(serverUrl) {
  return new URL(serverUrl).origin + "/*";
}

async function hasHostPermission(serverUrl) {
  try {
    return await browser.permissions.contains({ origins: [originPattern(serverUrl)] });
  } catch {
    return false;
  }
}

async function withClient(serverUrl, fn) {
  if (!(await hasHostPermission(serverUrl))) {
    throw new Error("The clipper doesn't have permission to reach your AFFiNE server yet. Open the clipper settings and click Connect.");
  }
  const client = new AffineClient(serverUrl);
  try {
    return await fn(client);
  } finally {
    client.disconnect();
  }
}

// ---------- extraction ----------
async function extractFromTab(tabId, settings) {
  const tab = await browser.tabs.get(tabId);
  const fallback = {
    url: tab.url,
    title: tab.title || tab.url,
    siteName: "",
    description: "",
    favicon: tab.favIconUrl || "",
    selection: [],
    intro: [],
    outline: [],
    keyPoints: [],
    article: [],
  };
  try {
    await browser.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    const [res] = await browser.scripting.executeScript({
      target: { tabId },
      func: (opts) => window.__affineInboxClipExtract(opts),
      args: [{ introParagraphs: Number(settings.introParagraphs) || 2 }],
    });
    if (res?.result?.url) return { ...res.result, cleanTitle: cleanTitle(res.result.title, res.result.siteName) };
    return { ...fallback, warning: "Could not read this page's content; clipping the link only." };
  } catch (e) {
    return { ...fallback, warning: "This page can't be read by extensions (browser or store page); clipping the link only." };
  }
}

// ---------- clip ----------
function parseTags(s) {
  return String(s || "")
    .split(",")
    .map((t) => t.trim())
    .filter(Boolean);
}

async function clip({ info, mode, note, title, tags }) {
  const settings = await getSettings();
  if (!settings.workspaceId) throw new Error("Pick a workspace and Inbox folder in the clipper settings first.");
  const composed = composeClip(info, { mode: mode || settings.defaultMode, note, title });
  const ydoc = buildPageDoc(composed.title, composed.blocks);
  const tagList = tags !== undefined ? parseTags(tags) : parseTags(settings.defaultTags);
  const result = await withClient(settings.serverUrl, (client) =>
    client.createDocInFolder({
      workspaceId: settings.workspaceId,
      folderId: settings.inboxFolderId,
      title: composed.title,
      ydoc,
      tags: tagList,
    }),
  );
  ydoc.destroy();
  if (settings.openAfterClip) browser.tabs.create({ url: result.url });
  return { ...result, title: composed.title, folderName: settings.inboxFolderName };
}

function notify(title, message) {
  browser.notifications
    .create({ type: "basic", iconUrl: "icons/icon-96.png", title, message })
    .catch(() => {});
}

async function quickClip(tab, { selectionOnly = false, linkUrl, linkText } = {}) {
  const settings = await getSettings();
  try {
    let info;
    let mode = settings.defaultMode;
    if (linkUrl) {
      info = {
        url: linkUrl,
        title: (linkText || linkUrl).trim(),
        siteName: "",
        description: "",
        selection: [],
        intro: [],
        outline: [],
        keyPoints: [],
        article: [],
      };
      mode = "snippet";
    } else {
      info = await extractFromTab(tab.id, settings);
      if (selectionOnly && info.selection?.length) mode = "selection";
    }
    const r = await clip({ info, mode });
    notify(
      r.filed ? `Saved to ${r.folderName || "Inbox"}` : "Saved to AFFiNE (not filed)",
      r.filed ? r.title : `${r.title}\n${r.fileError || ""}`,
    );
  } catch (e) {
    notify("AFFiNE clip failed", e.message || String(e));
  }
}

// ---------- menus & commands ----------
function setupMenus() {
  browser.contextMenus.removeAll().then(() => {
    browser.contextMenus.create({ id: "clip-page", title: "Clip page to AFFiNE Inbox", contexts: ["page"] });
    browser.contextMenus.create({ id: "clip-selection", title: "Clip selection to AFFiNE Inbox", contexts: ["selection"] });
    browser.contextMenus.create({ id: "clip-link", title: "Clip link to AFFiNE Inbox", contexts: ["link"] });
  });
}
browser.runtime.onInstalled.addListener(async (details) => {
  setupMenus();
  if (details.reason === "install") browser.runtime.openOptionsPage();
});
browser.runtime.onStartup.addListener(setupMenus);

browser.contextMenus.onClicked.addListener((data, tab) => {
  if (data.menuItemId === "clip-page") quickClip(tab);
  else if (data.menuItemId === "clip-selection") quickClip(tab, { selectionOnly: true });
  else if (data.menuItemId === "clip-link") quickClip(tab, { linkUrl: data.linkUrl, linkText: data.linkText });
});

browser.commands.onCommand.addListener(async (cmd) => {
  if (cmd !== "quick-clip") return;
  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (tab) quickClip(tab, { selectionOnly: true });
});

// ---------- messages from popup / options ----------
browser.runtime.onMessage.addListener((msg) => {
  const handlers = {
    async extract() {
      const settings = await getSettings();
      return extractFromTab(msg.tabId, settings);
    },
    async clip() {
      return clip(msg);
    },
    async connect() {
      return withClient(msg.serverUrl, async (client) => {
        const version = await client.detectVersion();
        const user = await client.currentUser();
        const ids = await client.listWorkspaceIds();
        const workspaces = [];
        for (const id of ids) {
          let name = id;
          try {
            name = await client.workspaceName(id);
          } catch {}
          workspaces.push({ id, name });
        }
        return { version, user, workspaces };
      });
    },
    async folders() {
      return withClient(msg.serverUrl, (client) => client.listFolders(msg.workspaceId));
    },
    async createFolder() {
      return withClient(msg.serverUrl, (client) => client.createFolder(msg.workspaceId, msg.name, msg.parentId || null));
    },
  };
  const h = handlers[msg?.type];
  if (!h) return undefined;
  return h().then(
    (data) => ({ ok: true, data }),
    (e) => ({ ok: false, error: e?.message || String(e), code: e?.code }),
  );
});
