const PUSHOVER_URL = 'https://api.pushover.net/1/messages.json';

function clean(value, limit = 160) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

function cleanMessage(value, limit = 1024) {
  return String(value || '').replace(/\r/g, '').split('\n')
    .map(line => line.replace(/[ \t]+/g, ' ').trim()).filter(Boolean).join('\n').slice(0, limit);
}

function titleCase(value) {
  return clean(value).replace(/\b\w/g, letter => letter.toUpperCase());
}

function channelLabel(profile = {}) {
  const source = clean(profile.utm_source).toLowerCase();
  const medium = clean(profile.utm_medium).toLowerCase();
  if (source === 'google' && ['cpc', 'ppc', 'paid', 'paid_search'].includes(medium)) return 'Google Ads';
  if (['facebook', 'meta', 'instagram'].includes(source) && ['cpc', 'paid', 'paid_social'].includes(medium)) return 'Meta Ads';
  if (!source) return 'Direct / Unknown';
  return `${titleCase(source)}${medium ? ` / ${clean(medium)}` : ''}`;
}

function eventTime(value) {
  const date = value ? new Date(value) : new Date();
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit',
  }).format(date);
}

function attributionLines({ version, profile = {}, occurredAt }) {
  const lines = [`${clean(version).toUpperCase()} • ${channelLabel(profile)}`];
  const campaign = clean(profile.utm_campaign);
  if (campaign) lines.push(`Campaign: ${campaign}`);
  const time = eventTime(occurredAt);
  if (time) lines.push(time);
  return lines;
}

function money(amount, currency) {
  const code = clean(currency || 'usd', 3).toUpperCase();
  try {
    return new Intl.NumberFormat('en-US', { style:'currency', currency:code }).format(Number(amount || 0) / 100);
  } catch (_) {
    return `${(Number(amount || 0) / 100).toFixed(2)} ${code}`;
  }
}

async function sendAdminPush({ title, message }, options = {}) {
  const env = options.env || process.env;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const logger = options.logger || console;
  const token = env.PUSHOVER_APP_TOKEN;
  const user = env.PUSHOVER_USER_KEY;
  if (!token || !user || typeof fetchImpl !== 'function') return { sent:false, reason:'disabled' };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs || 3000);
  try {
    const response = await fetchImpl(PUSHOVER_URL, {
      method:'POST', signal:controller.signal,
      headers:{'Content-Type':'application/x-www-form-urlencoded'},
      body:new URLSearchParams({token,user,title:clean(title,250),message:cleanMessage(message)}),
    });
    if (!response.ok) {
      logger.warn?.(`[admin push] request failed with HTTP ${response.status}`);
      return { sent:false, reason:'http_error', status:response.status };
    }
    return { sent:true };
  } catch (_) {
    logger.warn?.('[admin push] request failed');
    return { sent:false, reason:'request_error' };
  } finally {
    clearTimeout(timeout);
  }
}

function notifyNewAccount({ version, profile, occurredAt }, options) {
  return sendAdminPush({
    title:'🎯 New ROOK Account',
    message:['24-hour access activated', ...attributionLines({version,profile,occurredAt})].join('\n'),
  }, options);
}

function notifyNewSubscriber({ version, profile, amountPaid, currency, occurredAt }, options) {
  return sendAdminPush({
    title:'💰 New ROOK Subscriber',
    message:[`${money(amountPaid,currency)} subscription payment confirmed`, ...attributionLines({version,profile,occurredAt})].join('\n'),
  }, options);
}

module.exports = { sendAdminPush, notifyNewAccount, notifyNewSubscriber, channelLabel };
