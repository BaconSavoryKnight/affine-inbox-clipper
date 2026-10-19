import { extractPage } from "./extract.js";
window.__affineInboxClipExtract = (opts) => {
  try {
    return extractPage(opts);
  } catch (e) {
    return { error: String(e && e.message || e) };
  }
};
