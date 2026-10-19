const $ = (id) => document.getElementById(id);
const send = (msg) => browser.runtime.sendMessage(msg);

function setStatus(text, kind = "") {
  const el = $("status");
  el.className = "status " + kind;
  el.textContent = text;
}

function describe(info, mode) {
  const parts = [];
  if (mode === "key") {
    if (info.description) parts.push("summary");
    if (info.intro?.length) parts.push(`${info.intro.length} intro paragraph${info.intro.length > 1 ? "s" : ""}`);
    if (info.outline?.length >= 2) parts.push(`${info.outline.length} section headings`);
    else if (info.keyPoints?.length) parts.push(`${info.keyPoints.length} key points`);
    if (info.selection?.length) parts.push("your highlight");
  } else if (mode === "snippet") parts.push("one short excerpt");
  else if (mode === "selection") parts.push(`${info.selection.length} highlighted passage${info.selection.length > 1 ? "s" : ""}`);
  else if (mode === "full") parts.push(`${info.article?.length || 0} blocks of article text`);
  return "Saves a link card + source line" + (parts.length ? ", " + parts.join(", ") : "") + ".";
}

async function main() {
  const settings = await browser.storage.local.get({
    workspaceId: "",
    inboxFolderName: "",
    workspaceName: "",
    defaultMode: "key",
    defaultTags: "",
  });
  $("settings").onclick = $("openSettings").onclick = (e) => {
    e.preventDefault();
    browser.runtime.openOptionsPage();
    window.close();
  };
  if (!settings.workspaceId) {
    $("setup").hidden = false;
    return;
  }
  $("dest").textContent = `→ ${settings.inboxFolderName || "(no folder)"}`;
  $("dest").title = `${settings.workspaceName} / ${settings.inboxFolderName}`;
  $("form").hidden = false;
  $("tags").value = settings.defaultTags;

  const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  $("title").value = tab.title || tab.url;

  const res = await send({ type: "extract", tabId: tab.id });
  if (!res?.ok) {
    setStatus(res?.error || "Could not read the page.", "err");
    return;
  }
  const info = res.data;
  if (info.title) $("title").value = info.cleanTitle || info.title;
  if (info.warning) setStatus(info.warning, "warn");

  const hasSel = !!info.selection?.length;
  const selRadio = document.querySelector('input[value="selection"]');
  selRadio.disabled = !hasSel;
  if (!info.article?.length) document.querySelector('input[value="full"]').disabled = true;
  let mode = hasSel && settings.defaultMode !== "full" ? "selection" : settings.defaultMode;
  const radio = document.querySelector(`input[value="${mode}"]`);
  if (!radio || radio.disabled) mode = "key";
  document.querySelector(`input[value="${mode}"]`).checked = true;
  $("preview").textContent = describe(info, mode);
  $("modes").onchange = (e) => {
    $("preview").textContent = describe(info, e.target.value);
  };

  $("clip").disabled = false;
  $("clip").textContent = "Save to Inbox";
  $("note").focus();

  $("form").onsubmit = async (e) => {
    e.preventDefault();
    $("clip").disabled = true;
    $("clip").textContent = "Saving…";
    setStatus("");
    const chosen = document.querySelector('input[name="mode"]:checked')?.value || "key";
    const r = await send({
      type: "clip",
      info,
      mode: chosen,
      note: $("note").value,
      title: $("title").value,
      tags: $("tags").value,
    });
    if (r?.ok) {
      const d = r.data;
      const where = d.filed ? `in ${settings.inboxFolderName || "Inbox"}` : "in AFFiNE, but not filed";
      const a = document.createElement("a");
      a.href = d.url;
      a.target = "_blank";
      a.textContent = "Open it";
      setStatus(`Saved ${where}. `, d.filed ? "ok" : "warn");
      $("status").appendChild(a);
      if (!d.filed && d.fileError) $("status").append(` (${d.fileError})`);
      $("clip").textContent = "Saved";
    } else {
      setStatus(r?.error || "Something went wrong.", "err");
      $("clip").disabled = false;
      $("clip").textContent = "Try again";
    }
  };
}

main().catch((e) => setStatus(e.message || String(e), "err"));
