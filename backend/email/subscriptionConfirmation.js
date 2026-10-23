// Customer-facing membership confirmation email (pricing, renewal, cancel).

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function money(cents) {
  return `$${(Number(cents || 0) / 100).toFixed(2)}`;
}

function buildSubscriptionConfirmationEmail(authorization, { publicAppUrl = 'https://rookcareers.com' } = {}) {
  const settingsUrl = `${String(publicAppUrl).replace(/\/$/, '')}/rook-settings.html?section=subscription`;
  const planLabel = {
    two_day: '2-Day Pass',
    monthly: 'Monthly membership',
    three_month: '3-Month Pass',
  }[authorization.plan_id] || 'ROOK membership';

  let pricingHtml;
  if (authorization.plan_id === 'monthly') {
    pricingHtml = `
      <li><strong>Charged today:</strong> ${escapeHtml(money(authorization.initial_price_cents))}</li>
      <li><strong>Then:</strong> ${escapeHtml(money(authorization.recurring_price_cents))} every month until you cancel</li>
      <li><strong>Renewal:</strong> automatic monthly billing</li>`;
  } else if (authorization.plan_id === 'two_day') {
    pricingHtml = `
      <li><strong>Charged today:</strong> ${escapeHtml(money(authorization.initial_price_cents))} one-time</li>
      <li><strong>Access:</strong> 48 hours</li>
      <li><strong>Renewal:</strong> none — this pass does not renew</li>`;
  } else {
    pricingHtml = `
      <li><strong>Charged today:</strong> ${escapeHtml(money(authorization.initial_price_cents))} one-time</li>
      <li><strong>Access:</strong> 3 months</li>
      <li><strong>Renewal:</strong> none — this pass does not renew</li>`;
  }

  const subject = `ROOK membership confirmed — ${planLabel}`;
  const html = `<!doctype html><html><body style="font-family:Inter,Arial,sans-serif;color:#0b294f;line-height:1.55">
  <h1 style="font-size:22px;margin:0 0 12px">Your ROOK membership is active</h1>
  <p>Thanks for joining ROOK Careers. This email confirms your purchase authorization and billing details.</p>
  <ul style="padding-left:18px">${pricingHtml}
    <li><strong>Cancellation:</strong> ${escapeHtml(authorization.cancellation_summary)}</li>
    <li><strong>Terms version accepted:</strong> ${escapeHtml(authorization.terms_version)}</li>
    <li><strong>Authorization recorded:</strong> ${escapeHtml(authorization.consented_at)}</li>
  </ul>
  <p><strong>Your exact authorization statement:</strong></p>
  <p style="background:#f4f8fc;border:1px solid #d3e0ea;border-radius:10px;padding:12px 14px;font-size:14px">
    ${escapeHtml(authorization.consent_text)}
  </p>
  <p>Manage billing or cancel anytime here:<br>
  <a href="${escapeHtml(settingsUrl)}">${escapeHtml(settingsUrl)}</a></p>
  <p style="color:#5a6e82;font-size:13px">If you did not authorize this purchase, reply to this email or contact hello@rookcareers.com immediately.</p>
  </body></html>`;

  return { subject, html, settingsUrl };
}

module.exports = { buildSubscriptionConfirmationEmail, escapeHtml, money };
