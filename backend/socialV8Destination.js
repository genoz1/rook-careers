// Organic ROOK Facebook and Instagram acquisition links share the V8 entry.
const ENTRY = 'https://rookcareers.com/rook-onboarding-v8.html';

function socialV8Destination(platform, content) {
  if (!['facebook', 'instagram'].includes(platform)) throw Error('Unsupported V8 social destination');
  const url = new URL(ENTRY);
  url.search = new URLSearchParams({
    utm_source: platform,
    utm_medium: 'social',
    utm_campaign: 'organic',
    ...(content ? { utm_content: content } : {}),
  }).toString();
  return url.toString();
}

module.exports = { socialV8Destination };
