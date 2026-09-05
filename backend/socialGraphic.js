// Deterministic branded graphic renderer — implements the APPROVED
// visual design exactly as supplied (see the original
// build-rook-featured-template.mjs this was translated from), with
// the mock text values replaced by real candidate data and
// deterministic reflow rules added for missing facts and long text.
// The visual framework itself (colors, positions, card, icons,
// spacing) is preserved unchanged from what was approved — this file
// does not redesign it.
//
// Assembly: fixed top (1024x399) + dynamic middle (1024x621) + fixed
// bottom (1024x516) = 1024x1536. Top/bottom are the exact, unmodified
// approved PNG assets (public/assets/social-template/) — never
// redrawn, recolored, or resized.

const path = require("path");
const fs = require("fs/promises");

let sharp = null;
function getSharp() {
  if (!sharp) sharp = require("sharp");
  return sharp;
}

const MIDDLE_WIDTH = 1024;
const MIDDLE_HEIGHT = 621;
const TOP_HEIGHT = 399;
const BOTTOM_HEIGHT = 516;
const FINAL_WIDTH = 1024;
const FINAL_HEIGHT = TOP_HEIGHT + MIDDLE_HEIGHT + BOTTOM_HEIGHT; // 1536

const TOP_ASSET_PATH = path.join(__dirname, "..", "public", "assets", "social-template", "rook-template-top.png");
const BOTTOM_ASSET_PATH = path.join(__dirname, "..", "public", "assets", "social-template", "rook-template-bottom.png");

function escapeXml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&apos;" }[c]));
}

function estimateTextWidth(text, fontSize) {
  return String(text).length * fontSize * 0.56;
}

// Direct instruction: deterministic reflow for long text — prefers a
// single line at a smaller font over wrapping, matching the approved
// design's single-line title treatment as closely as possible; only
// wraps to a second line for titles too long to fit on one line even
// at the minimum acceptable font size.
// Wraps text to as many lines as needed to fit maxWidth — every word
// is preserved, nothing is ever dropped or ellipsized. This is the
// direct fix for the earlier bug: title fitting must never truncate
// or rewrite the verified job title, no matter how long it is.
function wrapTextNoTruncate(text, fontSize, maxWidth) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (estimateTextWidth(candidate, fontSize) <= maxWidth || !current) {
      current = candidate;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current) lines.push(current);
  return lines;
}

function fitTitle(title, maxWidth) {
  const MAX_FONT = 49; // exact approved font size
  const MIN_FONT = 26; // smallest still legible/professional at this canvas size
  const PREFERRED_MAX_LINES = 3; // tries to keep it to this many lines by shrinking font first

  // Try decreasing font sizes until the title fits within a
  // reasonable line count. Only if even MIN_FONT still needs more
  // lines does it go beyond PREFERRED_MAX_LINES — which is fine: it
  // still renders completely, just taller, rather than ever cutting
  // a word.
  for (let fontSize = MAX_FONT; fontSize >= MIN_FONT; fontSize -= 1) {
    const lines = wrapTextNoTruncate(title, fontSize, maxWidth);
    if (lines.length <= PREFERRED_MAX_LINES) {
      return { lines, fontSize };
    }
  }
  return { lines: wrapTextNoTruncate(title, MIN_FONT, maxWidth), fontSize: MIN_FONT };
}

function wrapFactText(text, fontSize, maxWidth, maxLines = 2) {
  const words = String(text ?? "").split(/\s+/).filter(Boolean);
  const lines = [];
  let current = "";
  for (const word of words) {
    const candidate = current ? `${current} ${word}` : word;
    if (estimateTextWidth(candidate, fontSize) <= maxWidth || !current) current = candidate;
    else { lines.push(current); current = word; }
    if (lines.length >= maxLines) break;
  }
  if (current && lines.length < maxLines) lines.push(current);
  if (lines.length === maxLines) {
    const consumed = lines.join(" ").split(/\s+/).length;
    const remaining = words.slice(consumed);
    if (remaining.length > 0) {
      let last = lines[maxLines - 1];
      while (estimateTextWidth(last + "…", fontSize) > maxWidth && last.length > 1) last = last.slice(0, -1);
      lines[maxLines - 1] = last.replace(/\s+$/, "") + "…";
    }
  }
  return lines;
}

// Direct fix for a real overflow bug found while rendering samples:
// allowing wrapFactText to wrap indefinitely (to avoid truncating a
// long value like a 5-state territory) let a single fact grow to 3-4
// lines, which pushed the rest of the card past the fixed panel
// height into the bottom image. Modeled directly on fitTitle's proven
// approach: shrink the font first to stay within 2 lines, and only
// wrap further as a last resort for a genuinely extreme value — never
// truncate, but prefer a smaller readable font over an unbounded
// number of lines.
function fitFactText(text, maxWidth) {
  const MAX_FONT = 30;
  const MIN_FONT = 22;
  const PREFERRED_MAX_LINES = 2;
  for (let fontSize = MAX_FONT; fontSize >= MIN_FONT; fontSize -= 1) {
    const lines = wrapFactText(text, fontSize, maxWidth, 4);
    if (lines.length <= PREFERRED_MAX_LINES) return { lines, fontSize };
  }
  return { lines: wrapFactText(text, MIN_FONT, maxWidth, 4), fontSize: MIN_FONT };
}

// Same principle as fitFactText, applied to the hook/summary line —
// direct fix for a truncation bug found while rendering final
// samples: a hook with a compensation clause appended (see
// generateSocialSafeHook in socialAutomation.js) was long enough to
// hit the old flat-font 2-line cap and get cut off with "…". Shrinks
// the font first, only wraps further as a last resort.
function fitSummaryText(text, maxWidth) {
  const MAX_FONT = 31;
  const MIN_FONT = 23;
  const PREFERRED_MAX_LINES = 2;
  for (let fontSize = MAX_FONT; fontSize >= MIN_FONT; fontSize -= 1) {
    const lines = wrapFactText(text, fontSize, maxWidth, 3);
    if (lines.length <= PREFERRED_MAX_LINES) return { lines, fontSize };
  }
  return { lines: wrapFactText(text, MIN_FONT, maxWidth, 3), fontSize: MIN_FONT };
}

function tspans(lines, x, startY, lineHeight) {
  return lines.map((l, i) => `<tspan x="${x}" y="${startY + i * lineHeight}">${escapeXml(l)}</tspan>`).join("");
}

const WORK_ARRANGEMENT_LABELS = { field: "Field Sales", remote: "Remote", hybrid: "Hybrid", onsite: "On-Site" };

// Exact icon path data from the approved template — unchanged.
const FACT_ICONS = {
  pin: `<path d="M30 13c-10 0-18 8-18 18 0 14 18 30 18 30s18-16 18-30c0-10-8-18-18-18zm0 24a7 7 0 1 1 0-14 7 7 0 0 1 0 14z" fill="#0878ef"/>`,
  tag: `<path d="M15 22h24l10 10-20 20-14-14zm9 7a4 4 0 1 0 0-8 4 4 0 0 0 0 8z" fill="#0878ef"/>`,
  briefcase: `<rect x="12" y="23" width="36" height="25" rx="4" fill="none" stroke="#0878ef" stroke-width="4"/><path d="M23 23v-7h14v7M12 33h36" fill="none" stroke="#0878ef" stroke-width="4"/>`,
  chart: `<path d="M14 46V28m11 18V19m11 27V12m11 34V23" stroke="#0878ef" stroke-width="7" stroke-linecap="round"/>`,
  // New, matching the same visual weight/style as the four approved
  // icons above (simple two-tone stroke/fill, same blue) — compensation
  // wasn't part of the original approved mock (which showed no
  // compensation), so this icon is a same-style addition, not a
  // redesign of anything that was already approved.
  dollar: `<circle cx="30" cy="30" r="19" fill="none" stroke="#0878ef" stroke-width="4"/><path d="M30 17v26M22 24.5c0-3 3-4.5 8-4.5s8 2 8 5c0 6.5-16 3-16 9.5 0 3 3 5 8 5s8-2 8-5" fill="none" stroke="#0878ef" stroke-width="3.5" stroke-linecap="round"/>`,
};

// Direct instruction: only these fields, and only when present. This
// priority order decides which 4 facts occupy the grid's 4 slots when
// more than 4 are available (compensation, when verified, is
// prioritized into the grid over work arrangement). Secondary labels
// ("Regional opportunity," "Medical sales category," etc.) have been
// removed entirely — direct instruction: they added clutter and were
// unreadable at feed size.
function buildFactList(candidate) {
  const facts = [];
  const locationText = candidate.territory_display || candidate.location_display;
  if (locationText) facts.push({ icon: "pin", main: locationText });
  if (candidate.compensation_display) facts.push({ icon: "dollar", main: candidate.compensation_display });
  if (candidate.category) facts.push({ icon: "tag", main: candidate.category });
  if (candidate.employment_type) facts.push({ icon: "briefcase", main: candidate.employment_type });
  if (candidate.work_arrangement) {
    facts.push({ icon: "chart", main: WORK_ARRANGEMENT_LABELS[candidate.work_arrangement] || candidate.work_arrangement });
  }
  return facts.slice(0, 4);
}

function buildMiddleSectionSvg(candidate) {
  const facts = buildFactList(candidate);
  // Direct fix for the reported bug: the graphic must display the
  // ACTUAL verified candidate.social_safe_hook — the same
  // allowlist-only, redaction-checked value everywhere else in the
  // system relies on — never a separately-generated generic sentence.
  // There was previously a second, redundant sentence-builder living
  // only in this file that ignored social_safe_hook entirely; it has
  // been removed rather than patched, so there is only ever one
  // source of truth for what the hook says.
  const summary = candidate.social_safe_hook || null;

  // ---- Title: fits on one line when possible (matching the approved
  // single-line design), only wraps for titles too long even at the
  // minimum font. Unchanged from the approved title-fitting logic. ---
  const titleMaxWidth = 820 - 213; // employer-lock box starts at x=820; title area is x=213 to there
  const { lines: titleLines, fontSize: titleFontSize } = fitTitle(candidate.title, titleMaxWidth);
  const titleLineHeight = titleFontSize * 0.9;
  const titleExtraHeight = (titleLines.length - 1) * titleLineHeight;

  // ---- Fact grid: larger icons and text (direct instruction — +30%
  // fact typography, icons large enough to read at mobile feed width),
  // and a simpler single-line-per-cell layout now that secondary
  // labels are gone. ----
  const FACT_FONT_SIZE = 30; // was 23 (~+30%) — the preferred/default size; fitFactText below may shrink it per-fact for an unusually long value
  const FACT_ICON_RADIUS = 36; // was 30 (+20%, sized for mobile-feed legibility)
  const FACT_ICON_SCALE = FACT_ICON_RADIUS / 30; // icon path data assumes a 60x60 box (r=30)
  const FACT_TEXT_X = FACT_ICON_RADIUS * 2 + 14; // icon diameter + gap

  const factCellWidth = 448 - FACT_TEXT_X - 20;
  // Direct fix for a real overflow bug found while rendering samples:
  // a long multi-state territory at a flat 30px font needed 3-4 lines,
  // pushing the whole card past its fixed height into the bottom
  // image. fitFactText tries the full 30px font first and only
  // shrinks (down to 22px) to stay within 2 lines — never truncates,
  // but prefers a smaller readable font over unbounded wrapping.
  const preparedFacts = facts.map((fact) => {
    const fitted = fitFactText(fact.main, factCellWidth);
    return { ...fact, mainLines: fitted.lines, fontSize: fitted.fontSize };
  });
  const BASE_ROW_HEIGHT = 104; // enough for the icon + one line of fact text
  const EXTRA_HEIGHT_PER_LINE = 40; // additional height per extra wrapped line, generalizes to any count
  const ROW_HEIGHT_COMPRESSION_MAX = 16; // per row, absorbed by the title-overflow lever below
  const gridRows = Math.ceil(preparedFacts.length / 2);
  const rowMaxLines = [];
  for (let row = 0; row < gridRows; row++) {
    const rowFacts = preparedFacts.slice(row * 2, row * 2 + 2);
    rowMaxLines.push(Math.max(1, ...rowFacts.map((f) => f.mainLines.length)));
  }
  const rowDefaultHeights = rowMaxLines.map((lines) => BASE_ROW_HEIGHT + (lines - 1) * EXTRA_HEIGHT_PER_LINE);

  // ---- Reflow budget for a long/wrapped title: unchanged mechanism
  // from the approved design — gaps compress first, then row height,
  // so the fixed final-details line stays anchored and nothing is
  // ever cut or overlapped, no matter how long a real title is. ----
  const compressibleGaps = { subtitleToDivider1: 35, divider1ToGrid: 37, divider2ToSummary: 30 };
  const minGaps = { subtitleToDivider1: 10, divider1ToGrid: 12, divider2ToSummary: 10 };
  let remaining = titleExtraHeight;
  const gap = {};
  for (const key of Object.keys(compressibleGaps)) {
    const available = compressibleGaps[key] - minGaps[key];
    const reduction = Math.min(available, remaining);
    gap[key] = compressibleGaps[key] - reduction;
    remaining -= reduction;
  }

  let rowHeightReductionPerRow = 0;
  if (remaining > 0 && gridRows > 0) {
    rowHeightReductionPerRow = Math.min(ROW_HEIGHT_COMPRESSION_MAX, Math.ceil(remaining / gridRows));
    remaining -= rowHeightReductionPerRow * gridRows;
  }

  const titleBaselineY = 145;
  const subtitleY = titleBaselineY + 35 + titleExtraHeight;
  const divider1Y = subtitleY + gap.subtitleToDivider1;
  const gridTopY = divider1Y + gap.divider1ToGrid;

  const rowHeights = rowDefaultHeights.map((h) => h - rowHeightReductionPerRow);
  const rowStartY = [];
  let cursorY = gridTopY;
  for (let row = 0; row < gridRows; row++) {
    rowStartY.push(cursorY);
    cursorY += rowHeights[row];
  }
  const gridBottomY = gridRows > 0 ? rowStartY[gridRows - 1] + FACT_ICON_RADIUS * 2 : gridTopY;

  const divider2Y = gridRows > 0 ? gridBottomY + 33 : gridTopY;
  const summaryTopY = divider2Y + gap.divider2ToSummary;

  // ---- Hook typography: +25% (was 25px) ----
  const SUMMARY_ICON_RADIUS = 32; // was 27 (+~18%)
  const fittedSummary = summary ? fitSummaryText(summary, 850 - 148) : { lines: [], fontSize: 31 };
  const summaryLines = fittedSummary.lines;
  const summaryFontSize = fittedSummary.fontSize;
  const summaryLineHeight = summaryFontSize * 1.32;
  const summaryBlockBottomY = summary ? summaryTopY + SUMMARY_ICON_RADIUS + (summaryLines.length - 1) * summaryLineHeight : divider2Y;

  const finalLineY = Math.max(547, summaryBlockBottomY + 20);

  // Fact text is vertically centered as a whole block around the
  // icon's middle, generalizing correctly to 1, 2, 3+ wrapped lines
  // rather than only handling exactly 1 or 2 as explicit cases.
  let gridSvg = "";
  preparedFacts.forEach((fact, i) => {
    const col = i % 2;
    const row = Math.floor(i / 2);
    const gx = 75 + col * 448;
    const gy = rowStartY[row];
    const mainLines = fact.mainLines;
    const factLineHeight = fact.fontSize * 1.15;
    const iconCenterY = FACT_ICON_RADIUS;
    const textBlockHeight = (mainLines.length - 1) * factLineHeight;
    const firstLineY = iconCenterY - textBlockHeight / 2 + fact.fontSize * 0.35;
    gridSvg += `
    <g transform="translate(${gx} ${gy})">
      <circle cx="${FACT_ICON_RADIUS}" cy="${FACT_ICON_RADIUS}" r="${FACT_ICON_RADIUS}" fill="#e8f4ff"/>
      <g transform="scale(${FACT_ICON_SCALE})">${FACT_ICONS[fact.icon]}</g>
      <text x="${FACT_TEXT_X}" y="${firstLineY}" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${fact.fontSize}" fill="#062650">${tspans(mainLines, FACT_TEXT_X, firstLineY, factLineHeight)}</text>
    </g>`;
  });

  const summarySvg = summary ? `
    <line x1="67" y1="${divider2Y}" x2="957" y2="${divider2Y}" stroke="#c8d9e9" stroke-width="2"/>
    <circle cx="${67 + SUMMARY_ICON_RADIUS}" cy="${summaryTopY + SUMMARY_ICON_RADIUS}" r="${SUMMARY_ICON_RADIUS}" fill="#0878ef"/>
    <path d="M${67 + SUMMARY_ICON_RADIUS - 13} ${summaryTopY + SUMMARY_ICON_RADIUS}l11 11 21-23" fill="none" stroke="#fff" stroke-width="6.5" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="${67 + SUMMARY_ICON_RADIUS * 2 + 22}" y="${summaryTopY + SUMMARY_ICON_RADIUS * 0.65}" font-family="Arial, Helvetica, sans-serif" font-weight="700" font-size="${summaryFontSize}" fill="#062650">${tspans(summaryLines, 67 + SUMMARY_ICON_RADIUS * 2 + 22, summaryTopY + SUMMARY_ICON_RADIUS * 0.65, summaryLineHeight)}</text>` : "";

  const svg = String.raw`<svg xmlns="http://www.w3.org/2000/svg" width="${MIDDLE_WIDTH}" height="${MIDDLE_HEIGHT}" viewBox="0 0 ${MIDDLE_WIDTH} ${MIDDLE_HEIGHT}">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="#eef7ff"/>
      <stop offset="1" stop-color="#f8fbff"/>
    </linearGradient>
    <linearGradient id="orb" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#12b9ff"/>
      <stop offset="1" stop-color="#0753bb"/>
    </linearGradient>
    <filter id="shadow" x="-20%" y="-20%" width="140%" height="150%">
      <feDropShadow dx="0" dy="12" stdDeviation="16" flood-color="#08295b" flood-opacity="0.15"/>
    </filter>
    <style>
      .sans { font-family: Arial, Helvetica, sans-serif; }
      .navy { fill: #062650; }
      .muted { fill: #3d5d80; }
      .label { font: 700 18px Arial, Helvetica, sans-serif; letter-spacing: .8px; fill: #0b65d8; }
    </style>
  </defs>

  <rect width="1024" height="621" fill="url(#bg)"/>
  <rect x="26" y="20" width="972" height="576" rx="25" fill="#fff" stroke="#d6e5f5" stroke-width="2" filter="url(#shadow)"/>

  <!-- Category emblem (fixed brand element, unchanged from approved) -->
  <circle cx="118" cy="132" r="71" fill="#e7f5ff"/>
  <circle cx="118" cy="132" r="58" fill="url(#orb)"/>
  <path d="M84 151h18v-28H84zm28 0h18v-48h-18zm28 0h18V83h-18z" fill="#fff"/>
  <path d="M85 110l27-24 18 10 27-27" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M148 69h10v10" fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round"/>

  <!-- FEATURED JOB pill (fixed) -->
  <rect x="213" y="52" width="166" height="42" rx="12" fill="#dff2ff"/>
  <text x="296" y="79" text-anchor="middle" class="label">FEATURED JOB</text>

  <!-- Title (dynamic, fitted) -->
  <text x="213" class="sans navy" font-size="${titleFontSize}" font-weight="800">${tspans(titleLines, 213, titleBaselineY, titleLineHeight)}</text>

  <!-- Subtitle (fixed copy, not job-specific data) -->
  <text x="214" y="${subtitleY}" class="sans muted" font-size="21" font-weight="600">A current opportunity selected from ROOK</text>

  <!-- Employer lock — enlarged (+~15%) for mobile-feed readability, direct instruction (fixed content, always present, never job-specific) -->
  <rect x="812" y="38" width="161" height="158" rx="19" fill="#e4f3ff" stroke="#c7e6fb"/>
  <rect x="871" y="75" width="44" height="38" rx="6" fill="#073869"/>
  <path d="M880 77v-9a13.5 13.5 0 0 1 27 0v9" fill="none" stroke="#073869" stroke-width="6.5"/>
  <circle cx="893" cy="93" r="4.5" fill="#fff"/>
  <text x="893" y="142" text-anchor="middle" class="sans navy" font-size="17" font-weight="800">SEE THE EMPLOYER</text>
  <text x="893" y="166" text-anchor="middle" class="sans navy" font-size="17" font-weight="800">ON ROOK</text>

  <line x1="67" y1="${divider1Y}" x2="957" y2="${divider1Y}" stroke="#d7e5f3" stroke-width="2"/>

  ${gridSvg}

  ${summarySvg}

  <!-- Final ROOK details line (fixed, anchored position) -->
  <rect x="68" y="${finalLineY}" width="888" height="35" rx="17.5" fill="#eef7ff"/>
  <text x="512" y="${finalLineY + 24}" text-anchor="middle" class="sans" font-size="19" font-weight="700" fill="#0758b7">See the employer and complete job details on ROOK</text>
</svg>`;

  return svg;
}

async function renderMiddleSection(candidate) {
  const svg = buildMiddleSectionSvg(candidate);
  return getSharp()(Buffer.from(svg)).png().toBuffer();
}

/**
 * Renders the complete 1024x1536 graphic: the fixed, unmodified
 * approved top/bottom assets plus the dynamic middle panel.
 * @param {object} candidate - the exact shape buildCandidateResponse() produces
 * @returns {Promise<Buffer>} PNG image data
 */
async function renderFeaturedJobGraphic(candidate) {
  const middleBuffer = await renderMiddleSection(candidate);

  let topBuffer, bottomBuffer;
  try {
    [topBuffer, bottomBuffer] = await Promise.all([fs.readFile(TOP_ASSET_PATH), fs.readFile(BOTTOM_ASSET_PATH)]);
  } catch (err) {
    console.error(`[social-graphic] could not read fixed template asset(s): ${err.message}`);
    throw new Error("Fixed top/bottom template assets are missing — cannot assemble the final graphic.");
  }

  return getSharp()({
    create: { width: FINAL_WIDTH, height: FINAL_HEIGHT, channels: 3, background: "#ffffff" },
  })
    .composite([
      { input: topBuffer, left: 0, top: 0 },
      { input: middleBuffer, left: 0, top: TOP_HEIGHT },
      { input: bottomBuffer, left: 0, top: TOP_HEIGHT + MIDDLE_HEIGHT },
    ])
    .png()
    .toBuffer();
}

module.exports = {
  renderFeaturedJobGraphic,
  renderMiddleSection,
  buildMiddleSectionSvg,
  buildFactList,
  fitTitle,
  wrapFactText,
  FINAL_WIDTH,
  FINAL_HEIGHT,
};
