// Resume text extraction — pulls plain text out of an uploaded résumé
// file so it can be sent to the AI parser. Supports PDF and DOCX.
//
// NOTE: legacy .doc (the old binary Word format, not .docx) is NOT
// supported — mammoth only reads the modern .docx XML format. A .doc
// upload will fail extraction gracefully (returns null) rather than
// crashing the upload itself; the file is still stored either way.

const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");

/**
 * Extract plain text from a résumé file buffer.
 * @param {Buffer} buffer - the uploaded file's raw bytes
 * @param {string} mimetype - the uploaded file's MIME type
 * @returns {Promise<string|null>} extracted text, or null if extraction failed/unsupported
 */
async function extractResumeText(buffer, mimetype) {
  try {
    if (mimetype === "application/pdf") {
      const data = await pdfParse(buffer);
      return data.text.trim() || null;
    }
    if (mimetype === "application/vnd.openxmlformats-officedocument.wordprocessingml.document") {
      const result = await mammoth.extractRawText({ buffer });
      return result.value.trim() || null;
    }
    // Legacy .doc (application/msword) isn't supported by mammoth.
    return null;
  } catch (err) {
    console.error(`Resume text extraction failed: ${err.message}`);
    return null;
  }
}

module.exports = { extractResumeText };
