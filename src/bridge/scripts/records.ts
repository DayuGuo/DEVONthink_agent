/**
 * records.ts — Record read/write JXA templates
 */

import { escapeForJXA } from "../executor.js";

/**
 * Read record content — intelligently selects the best extraction method based on document type.
 *
 * - Markdown → reads raw .md content directly from file path (source() returns rendered HTML boilerplate, unusable)
 * - HTML / webarchive / formatted note → source() preserves HTML structure (headings, links, tables)
 * - PDF / Word / PPT / other → plainText()
 * - Image → returns file path and metadata (cannot extract text content)
 */
export function getRecordContentScript(uuid: string, maxLength: number = 16000): string {
  const u = escapeForJXA(uuid);
  return `(() => {
  ObjC.import("Foundation");
  const app = Application("DEVONthink");
  const r = app.getRecordWithUuid(${u});
  if (!r) return JSON.stringify({error: "Record not found"});

  const rType = r.recordType();
  let content = "";
  let contentFormat = "plain_text";

  // Markdown files: read raw .md file directly from disk.
  // Note: DEVONthink's source() for Markdown returns the fully rendered HTML page
  // (including <html>/<head>/CSS/JS boilerplate), which fills the character limit
  // and loses the actual content. Therefore we cannot use it.
  if (rType === "markdown") {
    try {
      const filePath = r.path();
      if (filePath) {
        const nsStr = $.NSString.stringWithContentsOfFileEncodingError(
          filePath, $.NSUTF8StringEncoding, null
        );
        if (nsStr && !nsStr.isNil()) {
          content = nsStr.js;
          contentFormat = "markdown";
        }
      }
    } catch(e) { /* File read failed, will fall back to plainText below */ }
  }

  // HTML / Webarchive / Formatted Note: use source() to preserve structure
  const htmlTypes = ["html", "webarchive", "formatted note"];
  if (!content && htmlTypes.indexOf(rType) !== -1) {
    try {
      const src = r.source();
      if (src && src.length > 0) {
        content = src;
        contentFormat = "html";
      }
    } catch(e) { /* source() unavailable, will fall back to plainText below */ }
  }

  // Image type: cannot extract text, return file info
  if (!content && rType === "picture") {
    let filePath = "";
    try { filePath = r.path() || ""; } catch(e) {}
    return JSON.stringify({
      uuid: r.uuid(),
      name: r.name(),
      recordType: rType,
      contentFormat: "image",
      content: "[This record is an image file; text content cannot be extracted]",
      path: filePath,
      truncated: false,
      totalLength: 0,
      wordCount: 0,
    });
  }

  // Fall back to plainText() (PDF, Word, PPT, etc. — text extracted by DEVONthink's internal converter)
  if (!content) {
    try {
      content = r.plainText() || "";
    } catch(e) {
      content = "";
    }
  }

  const totalLength = content.length;
  const truncated = totalLength > ${maxLength};
  const output = truncated ? content.slice(0, ${maxLength}) : content;

  let filePath = "";
  try { filePath = r.path() || ""; } catch(e) {}

  return JSON.stringify({
    uuid: r.uuid(),
    name: r.name(),
    recordType: rType,
    contentFormat: contentFormat,
    content: output,
    truncated: truncated,
    totalLength: totalLength,
    wordCount: r.wordCount(),
    path: filePath,
  });
})()`;
}

/**
 * Read record metadata.
 */
export function getRecordMetadataScript(uuid: string): string {
  const u = escapeForJXA(uuid);
  return `(() => {
  const app = Application("DEVONthink");
  const r = app.getRecordWithUuid(${u});
  if (!r) return JSON.stringify({error: "Record not found"});
  let url = "";
  try { url = r.url() || ""; } catch(e) {}
  let comment = "";
  try { comment = r.comment() || ""; } catch(e) {}
  let customMeta = {};
  try { customMeta = r.customMetaData() || {}; } catch(e) {}
  return JSON.stringify({
    uuid: r.uuid(),
    name: r.name(),
    recordType: r.recordType(),
    tags: r.tags(),
    rating: r.rating(),
    label: r.label(),
    state: r.state(),
    location: r.location(),
    url: url,
    comment: comment,
    referenceURL: r.referenceURL(),
    creationDate: r.creationDate().toISOString(),
    modificationDate: r.modificationDate().toISOString(),
    size: r.size(),
    wordCount: r.wordCount(),
    numberOfDuplicates: r.numberOfDuplicates(),
    numberOfReplicants: r.numberOfReplicants(),
    database: r.database().name(),
    customMetaData: customMeta,
  });
})()`;
}

// Note: Write operations (createRecord, moveRecord, createLink, etc.) have been
// intentionally removed to enforce the strict read-only principle of this Agent.
