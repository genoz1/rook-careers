// Keep the read-only allocation preview within the hosting gateway's request window.
// A slow platform must be reported explicitly: allocating without its campaigns
// would make the proposed combined budget inaccurate.
const PREVIEW_TIMEOUT_MS = 20_000;

async function fetchPreviewReports(platforms, clients, timeoutMs = PREVIEW_TIMEOUT_MS) {
  return Promise.all(platforms.map(async platform => {
    let timer;
    try {
      const campaigns = await Promise.race([
        clients[platform].fetchCampaignPerformance("yesterday"),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`Yesterday's report exceeded ${Math.round(timeoutMs / 1000)} seconds`)), timeoutMs);
        }),
      ]);
      return { platform, campaigns };
    } catch (err) {
      return { platform, error:err.message };
    } finally {
      clearTimeout(timer);
    }
  }));
}

module.exports = { fetchPreviewReports };
