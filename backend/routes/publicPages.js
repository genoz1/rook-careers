// Server-rendered public pages — the partial-reveal job detail page and
// a dynamic sitemap. These exist as real Express routes (not static
// files) specifically so the HTML that comes back on the FIRST request
// already has real, per-job <title>/<meta> tags and visible content —
// search engines and link-preview bots (Slack, Facebook, Twitter) mostly
// don't execute JavaScript, so a page that only fills in real content
// via a client-side fetch() after load is functionally invisible to
// them. Every other ROOK page in this project is a static file that
// fetches its own data client-side; this is deliberately different,
// because these two pages are the ones meant to be found by search
// engines and shared as links, not just used by people already signed in.

const express = require("express");
const { createClient } = require("@supabase/supabase-js");
const { getTrialPeriodDays } = require("../routes/stripe");

const router = express.Router();

const isConfigured = Boolean(process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY);
const supabaseAnon = isConfigured
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;

const APP_BASE_URL = process.env.PUBLIC_APP_URL || "https://seashell-app-hbjuo.ondigitalocean.app";

function escapeHtml(str) {
  return String(str || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// Extract "City, ST" from raw location strings like
// "Tampa, Florida, United States" or "Tampa, FL, US"
function shortLocation(raw) {
  if (!raw) return null;
  const STATE_ABBR = { Florida:"FL",Texas:"TX",California:"CA","New York":"NY",Ohio:"OH",Illinois:"IL",Georgia:"GA","North Carolina":"NC",Michigan:"MI",Pennsylvania:"PA",Tennessee:"TN",Virginia:"VA",Washington:"WA",Massachusetts:"MA",Arizona:"AZ",Colorado:"CO",Minnesota:"MN","New Jersey":"NJ",Indiana:"IN",Missouri:"MO",Maryland:"MD",Wisconsin:"WI",Connecticut:"CT",Nevada:"NV",Louisiana:"LA",Alabama:"AL","South Carolina":"SC",Kentucky:"KY",Oregon:"OR",Oklahoma:"OK","New Mexico":"NM",Utah:"UT",Iowa:"IA",Arkansas:"AR",Kansas:"KS",Nebraska:"NE","West Virginia":"WV",Idaho:"ID","New Hampshire":"NH",Maine:"ME",Montana:"MT",Delaware:"DE","North Dakota":"ND","South Dakota":"SD",Alaska:"AK",Vermont:"VT",Wyoming:"WY","Rhode Island":"RI",Hawaii:"HI",Mississippi:"MS" };
  const parts = raw.split(",").map(s => s.trim()).filter(s => s && !/^(United States?|US|USA)$/i.test(s));
  if (parts.length === 0) return null;
  const city = parts[0];
  const stateRaw = parts[1] || "";
  if (/^[A-Z]{2}$/.test(stateRaw)) return `${city}, ${stateRaw}`;
  const abbr = STATE_ABBR[stateRaw];
  if (abbr) return `${city}, ${abbr}`;
  if (stateRaw.length > 0 && stateRaw.length <= 20) return `${city}, ${stateRaw}`;
  return city;
}

// Shared page chrome (nav, footer, styles) so the job page and sitemap-
// adjacent pages look like the rest of ROOK rather than a bare document.
function pageShell({ title, description, canonicalUrl, ogImage, bodyHtml, jsonLd, jobId }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <!-- Google tag (gtag.js) — these server-rendered pages have no
       existing Google tag to integrate with, unlike the static public/
       pages, so this is a standalone loader rather than an added
       config() call. -->
  <script async src="https://www.googletagmanager.com/gtag/js?id=G-LDG2CL5Z8R"></script>
  <script>
    window.dataLayer = window.dataLayer || [];
    function gtag(){dataLayer.push(arguments);}
    gtag('js', new Date());
    gtag('config', 'G-LDG2CL5Z8R');
  </script>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>${escapeHtml(title)}</title>
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${escapeHtml(canonicalUrl)}">
  <meta property="og:type" content="website">
  <meta property="og:title" content="${escapeHtml(title)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonicalUrl)}">
  ${ogImage ? `<meta property="og:image" content="${escapeHtml(ogImage)}">` : ""}
  <meta name="twitter:card" content="summary">
  <link rel="icon" href="/assets/favicon.ico" sizes="any">
  <link href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">
  ${jsonLd ? `<script type="application/ld+json">${JSON.stringify(jsonLd).replace(/</g, "\\u003c")}</script>` : ""}
  <style>
    :root{ --navy:#071E41; --royal:#1463FF; --teal:#12B8A6; --gray:#F5F7FA; --white:#FFFFFF; --muted:#5B6B85; --border:#E3E8F0; --radius:14px; --font-display:'Space Grotesk', sans-serif; --font-body:'Inter', sans-serif; }
    *{box-sizing:border-box; margin:0; padding:0;}
    body{font-family:var(--font-body); color:var(--navy); background:var(--gray); -webkit-font-smoothing:antialiased;}
    h1,h2,h3,h4{font-family:var(--font-display); letter-spacing:-0.01em;}
    a{color:inherit; text-decoration:none;}
    .btn{display:inline-flex; align-items:center; justify-content:center; gap:6px; padding:12px 22px; border-radius:999px; font-size:14px; font-weight:600; cursor:pointer; border:none;}
    .btn-primary{background:var(--royal); color:#fff;}
    .btn-outline{background:#fff; color:var(--navy); border:1px solid var(--border);}
    .topbar{background:var(--navy); padding:16px 32px; display:flex; align-items:center; justify-content:space-between;}
    .topbar .logo{font-family:var(--font-display); font-weight:700; font-size:18px; color:#fff; display:flex; align-items:center; gap:8px;}
    .container{max-width:720px; margin:0 auto; padding:40px 24px 60px;}
  </style>
</head>
<body>
  <div class="topbar">
    <a href="/" class="logo"><img src="/assets/rook-icon-192.png" alt="ROOK" style="height:22px; width:auto;">ROOK</a>
    <a href="/rook-login.html?return=${encodeURIComponent(canonicalUrl)}" class="btn btn-outline">Log In</a>
  </div>
  <div class="container">
    ${bodyHtml}
  </div>
  <script src="/rook-config.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/dist/umd/supabase.min.js"></script>
  ${jobId ? `<script>
  (async () => {
    try {
      const sb = window.supabase.createClient(
        window.ROOK_CONFIG.SUPABASE_URL,
        window.ROOK_CONFIG.SUPABASE_ANON_KEY
      );
      const { data: { session } } = await sb.auth.getSession();
      if (!session) return;
      const res = await fetch('/api/profile', {
        headers: { Authorization: 'Bearer ' + session.access_token }
      });
      if (!res.ok) return;
      const profile = await res.json();
      const status = profile.subscription_status;
      if (status === 'active' || status === 'trialing') {
        window.location.replace('/rook-job-analysis.html?job=${escapeHtml(jobId)}');
      }
    } catch (_) {}
  })();
  </script>` : ''}
</body>
</html>`;
}

// GET /jobs/:id — the partial-reveal public job page. Title, location,
// compensation, and a description preview are real and visible; company
// name and the real apply link stay gated behind sign-up, same fields
// withheld as the anonymous JSON API teaser in backend/routes/jobs.js.
router.get("/jobs/:id", async (req, res, next) => {
  if (!isConfigured) return next(); // falls through to the SPA catch-all if Supabase isn't set up yet

  const { data: job, error } = await supabaseAnon
    .from("jobs")
    .select("id, title_original, title_normalized, location_raw, compensation_text, salary_min, salary_max, description_text, date_posted, status, company_name, ai_analysis, remote_status, travel_percentage")
    .eq("id", req.params.id)
    .eq("status", "active")
    .maybeSingle();

  if (error || !job) {
    // Reported via audit: a nonexistent/expired job ID silently showed
    // the plain homepage with no indication anything was wrong - the
    // comment this replaces described falling through to "a normal
    // 404-ish experience" via the SPA catch-all, but that catch-all is
    // just index.html with no logic to recognize this was a failed job
    // lookup specifically. Rendering a real, dedicated response here
    // instead - properly 404-coded (good for crawlers too, not just
    // human visitors) and clear about what happened.
    return res.status(404).send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="robots" content="noindex">
<!-- Google tag (gtag.js) -->
<script async src="https://www.googletagmanager.com/gtag/js?id=G-LDG2CL5Z8R"></script>
<script>
  window.dataLayer = window.dataLayer || [];
  function gtag(){dataLayer.push(arguments);}
  gtag('js', new Date());
  gtag('config', 'G-LDG2CL5Z8R');
</script>
<title>Job Not Found | ROOK</title>
<style>
  body{font-family:-apple-system,'Segoe UI',sans-serif; background:#F5F7FA; color:#0B1D3A; margin:0; padding:0;}
  .wrap{max-width:560px; margin:0 auto; padding:100px 24px; text-align:center;}
  h1{font-size:26px; margin-bottom:12px;}
  p{color:#5B6B85; font-size:15px; line-height:1.6; margin-bottom:28px;}
  a{display:inline-block; background:#0B1D3A; color:#fff; text-decoration:none; padding:12px 24px; border-radius:8px; font-weight:600;}
</style>
</head>
<body>
  <div class="wrap">
    <h1>This job isn't available anymore</h1>
    <p>It may have been filled, closed by the employer, or the link may be outdated. Browse current openings instead.</p>
    <a href="/rook-browse.html">Browse Open Roles</a>
  </div>
</body>
</html>`);
  }

  const title = job.title_original || job.title_normalized || "Open role";
  const comp = job.compensation_text || (job.salary_min ? `$${job.salary_min}${job.salary_max ? "–$" + job.salary_max : "+"}` : "");
  const locShort = shortLocation(job.location_raw);
  const titleWithLoc = locShort ? `${title} in ${locShort}` : title;

  // Structured teaser built from the AI-extracted job attributes
  const ai = job.ai_analysis || {};
  const teaserFacts = [];
  if (Array.isArray(ai.required_industries) && ai.required_industries.length) teaserFacts.push(`Industry: ${ai.required_industries[0]}`);
  else if (Array.isArray(ai.preferred_industries) && ai.preferred_industries.length) teaserFacts.push(`Industry: ${ai.preferred_industries[0]}`);
  if (Array.isArray(ai.product_categories) && ai.product_categories.length) teaserFacts.push(`Focus: ${ai.product_categories[0]}`);
  if (ai.seniority_level) teaserFacts.push(`Level: ${ai.seniority_level}`);
  const travelPct = job.travel_percentage ?? ai.travel_percentage;
  if (travelPct != null) teaserFacts.push(`Travel: ${travelPct}%`);
  if (job.remote_status) teaserFacts.push(job.remote_status === "remote" ? "Remote-friendly" : "Field-based");

  const preview = teaserFacts.length > 0
    ? teaserFacts.join(" · ")
    : "Full role details — including responsibilities, requirements, and who's hiring — are visible after you sign up.";

  const canonicalUrl = `${APP_BASE_URL}/jobs/${job.id}`;
  const metaDescription = `${titleWithLoc}${comp ? " — " + comp : ""}. See the employer and apply on ROOK — medical & veterinary sales careers.`.slice(0, 300);

  // Fetch similar jobs for internal linking — same state, different job
  let similarJobsHtml = "";
  try {
    const stateGuess = (job.location_raw || "").split(",").map(s => s.trim()).filter(s => /^[A-Z]{2}$/.test(s))[0]
      || (job.location_raw || "").split(",")[1]?.trim() || null;
    const similarQuery = supabaseAnon
      .from("jobs")
      .select("id, title_original, location_raw, company_name")
      .eq("status", "active")
      .eq("moderation_status", "approved")
      .neq("id", job.id)
      .limit(4);
    const { data: similar } = stateGuess
      ? await similarQuery.ilike("location_raw", `%${stateGuess}%`)
      : await similarQuery;
    if (similar && similar.length > 0) {
      similarJobsHtml = `
      <div style="margin-top:32px;">
        <div style="font-size:12.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:12px;">Similar Roles</div>
        ${similar.map(s => `
          <a href="/jobs/${escapeHtml(s.id)}" style="display:block;background:#fff;border:1px solid var(--border);border-radius:10px;padding:14px 16px;margin-bottom:8px;">
            <div style="font-weight:600;font-size:14px;margin-bottom:3px;">${escapeHtml(s.title_original || "Open role")}</div>
            <div style="font-size:12.5px;color:var(--muted);">${escapeHtml(s.location_raw || "")}</div>
          </a>`).join("")}
      </div>`;
    }
  } catch (_) {}

  // JSON-LD JobPosting with complete fields for Google Jobs
  const jsonLd = {
    "@context": "https://schema.org/",
    "@type": "JobPosting",
    title: titleWithLoc,
    description: preview,
    datePosted: job.date_posted || undefined,
    validThrough: job.expires_at || undefined,
    hiringOrganization: { "@type": "Organization", name: "See employer on ROOK", sameAs: APP_BASE_URL },
    jobLocation: locShort ? { "@type": "Place", address: { "@type": "PostalAddress", addressLocality: locShort.split(",")[0]?.trim(), addressRegion: locShort.split(",")[1]?.trim(), addressCountry: "US" } } : undefined,
    employmentType: job.employment_type === "Contract" ? "CONTRACTOR" : "FULL_TIME",
    ...(job.salary_min ? { baseSalary: { "@type": "MonetaryAmount", currency: "USD", value: { "@type": "QuantitativeValue", minValue: job.salary_min, maxValue: job.salary_max || undefined, unitText: "YEAR" } } } : {}),
    directApply: false,
    url: `${APP_BASE_URL}/jobs/${job.id}`,
  };

  const trialDays = getTrialPeriodDays();
  const ctaBlock = trialDays > 0
    ? `<div style="color:#fff;font-size:15px;font-weight:700;margin-bottom:2px;">${trialDays} days free, then $29/month</div>
      <div style="color:#B9C4DB;font-size:13px;font-weight:600;margin-bottom:18px;">Cancel anytime.</div>
      <a href="/rook-onboarding-v4.html" class="btn btn-primary">Start Your ${trialDays}-Day Free Trial</a>
      <div style="color:#8B96AB;font-size:12px;margin-top:10px;">$0 today. Full ROOK access during your trial.</div>`
    : `<div style="color:#fff;font-size:15px;font-weight:700;margin-bottom:18px;">$29/month · Cancel anytime</div>
      <a href="/rook-onboarding-v4.html" class="btn btn-primary">Get Started</a>
      <div style="color:#8B96AB;font-size:12px;margin-top:10px;">One membership. Full ROOK access.</div>`;

  const bodyHtml = `
    <div style="background:rgba(20,99,255,0.08);color:var(--royal);display:inline-flex;align-items:center;gap:6px;font-size:12.5px;font-weight:600;padding:6px 12px;border-radius:999px;margin-bottom:16px;">🔒 Employer revealed with ROOK access</div>
    <h1 style="font-size:28px;margin-bottom:10px;">${escapeHtml(titleWithLoc)}</h1>
    <div style="font-size:14.5px;color:var(--muted);margin-bottom:24px;">${escapeHtml(job.location_raw || "")}${comp ? " · " + escapeHtml(comp) : ""}${job.date_posted ? " · Posted " + escapeHtml(job.date_posted) : ""}</div>
    <div style="background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin-bottom:24px;font-size:14.5px;line-height:1.7;color:var(--navy);">
      ${escapeHtml(preview)}
      <div style="margin-top:16px;padding-top:16px;border-top:1px dashed var(--border);color:var(--muted);font-style:italic;">ROOK members see the employer, full opportunity details, direct application link, and personalized match score.</div>
    </div>
    <div style="background:var(--navy);border-radius:var(--radius);padding:28px 24px;text-align:center;">
      <h3 style="color:#fff;font-size:19px;margin-bottom:8px;">Ready to see who's hiring?</h3>
      <p style="color:#B9C4DB;font-size:13.5px;margin-bottom:14px;">See the employer, apply directly, and get this job — and every other opportunity — scored against your experience.</p>
      ${ctaBlock}
    </div>
    ${similarJobsHtml}
    <div style="text-align:center;margin-top:24px;"><a href="/rook-browse.html" style="color:var(--royal);font-size:13px;font-weight:600;">← Browse all open roles</a></div>
  `;

  res.send(pageShell({ title: `${titleWithLoc} — ROOK`, description: metaDescription, canonicalUrl, bodyHtml, jsonLd, jobId: req.params.id }));
});

// Real, curated set of job categories for server-rendered landing
// pages — the actual SEO purpose of this whole route. Each one targets
// a specific, meaningfully-searched phrase with its own genuinely
// unique title, meta description, and real filtered job content —
// deliberately NOT the same shared page with a query-string filter,
// since a client-rendered page whose title/meta never change per
// filter would likely be seen by search engines as one page, not many,
// defeating the point. searchTerms are matched against title and
// description text (case-insensitive, OR'd together) to decide which
// real jobs appear on each category page.
// Category definitions — each category maps to a description and a list
// of company slugs pulled from the employers table. Companies grouped by
// the industry they primarily serve. Update companySlugs as new employers
// are added to the DB.
const CATEGORIES = {
  "medical-sales-jobs": { longContent: `<p>Medical sales is one of the most rewarding and well-compensated career paths in healthcare. Representatives work directly with physicians, hospital systems, surgical centers, and clinical labs to introduce products that improve patient outcomes — from surgical instruments and diagnostic equipment to specialty pharmaceuticals and biologics.</p>
<p><strong>Compensation:</strong> Medical sales roles typically offer a base salary of $60,000–$90,000 plus commission, with total compensation ranging from $90,000 to $180,000+ for experienced reps in competitive specialties like oncology, orthopedics, and cardiovascular. Device and capital equipment roles often carry the highest earning potential.</p>
<p><strong>What employers look for:</strong> Most hiring managers prioritize a track record of quota attainment, clinical selling experience, and the ability to build long-term relationships with decision-makers. A clinical background (nursing, lab science, or physical therapy) is a significant advantage for specialty roles. Territory management and CRM fluency are expected at most levels.</p>
<p>ROOK pulls these openings directly from employer career sites — so you see roles at Abbott, Stryker, Quest Diagnostics, Tempus, and hundreds of other companies before they saturate the job boards.</p>`,

    label: "Medical Sales Jobs",
    description: "ROOK sources medical sales jobs directly from employer career sites across medical device, diagnostics, pharmaceutical, and specialty healthcare companies.",
    companySlugs: [
      // Medical device
      "stryker","medtronic","abbott","boston-scientific","edwards-lifesciences",
      "becton-dickinson","zimmer-biomet","insulet","integra-lifesciences",
      "natus-medical","artivion","acutus-medical","agiliti",
      // Diagnostics & lab
      "quest-diagnostics","labcorp","biodesix","foundation-medicine",
      "guardant-health","neogenomics","exact-sciences","tempus","caris-life-sciences",
      "natera","somalogic","veracyte","genalyte","biocryst-pharmaceuticals",
      // Pharma / biotech
      "abbvie","pfizer","johnson-johnson","eli-lilly","astrazeneca","merck",
      "bristol-myers-squibb","amgen","gilead","regeneron","biogen","vertex",
      "novo-nordisk","boehringer-ingelheim","astellas-pharma","daiichi-sankyo",
      "lundbeck","chiesi-usa","leo-pharma","ipsen","moderna","argenx",
      "madrigal-pharmaceuticals","united-therapeutics","travere-therapeutics",
      "xeris-biopharma","exelixis","halozyme","almirall","axsome-therapeutics",
      "bridgebio-pharma","sobi","eisai","ionis-pharmaceuticals",
      "catalyst-pharmaceuticals","rhythm-pharmaceuticals","beone-medicines",
      // Specialty
      "hologic","invacare","cardinal-health","henry-schein","mckesson",
    ],
  },
  "pharmaceutical-sales-jobs": { longContent: `<p>Pharmaceutical sales representatives promote prescription medications to physicians, nurse practitioners, and other prescribers. The role requires deep product and disease-state knowledge, the ability to navigate complex healthcare relationships, and a consultative approach to changing prescribing behavior — particularly in specialty areas like oncology, neurology, immunology, and rare disease.</p>
<p><strong>Compensation:</strong> Entry-level pharma reps typically earn $55,000–$75,000 base, with total compensation of $80,000–$120,000 including bonus. Specialty and rare-disease roles at companies like argenx, Travere, or United Therapeutics often pay $120,000–$200,000+ in total comp given the complexity of the sale and small patient populations.</p>
<p><strong>What employers look for:</strong> A bachelor's degree is standard; science-related fields are preferred but not required. Demonstrated sales success — whether in pharma, device, or another industry — matters more than the degree itself. Companies like Pfizer, AbbVie, and Novo Nordisk often hire from device or diagnostics backgrounds.</p>
<p>ROOK sources these roles directly from pharma and biotech employer career sites, including many that post days before they appear on LinkedIn or Indeed.</p>`,

    label: "Pharmaceutical Sales Jobs",
    description: "ROOK pulls pharmaceutical sales jobs directly from top pharma and biotech employer career sites — no job board middlemen.",
    companySlugs: [
      "abbvie","pfizer","johnson-johnson","eli-lilly","astrazeneca","merck",
      "bristol-myers-squibb","amgen","gilead","regeneron","biogen","vertex",
      "novo-nordisk","boehringer-ingelheim","astellas-pharma","daiichi-sankyo",
      "lundbeck","chiesi-usa","leo-pharma","ipsen","moderna","argenx",
      "madrigal-pharmaceuticals","united-therapeutics","travere-therapeutics",
      "xeris-biopharma","exelixis","halozyme","almirall","axsome-therapeutics",
      "bridgebio-pharma","sobi","eisai","ionis-pharmaceuticals",
      "catalyst-pharmaceuticals","rhythm-pharmaceuticals","beone-medicines",
      "sun-pharma",
    ],
  },
  "medical-device-sales-jobs": { longContent: `<p>Medical device sales representatives sell physical products used in clinical and surgical settings — from orthopedic implants and surgical robotics to cardiovascular devices, wound care, and diagnostic equipment. The role is highly technical, often requiring operating room presence and the ability to support procedures in real time.</p>
<p><strong>Compensation:</strong> Device reps are among the highest-earning professionals in medical sales. Base salaries range from $65,000–$95,000, with total compensation of $120,000–$250,000+ for top performers in surgical specialties. Capital equipment roles (imaging, robotic surgery) often include additional commission on service contracts.</p>
<p><strong>What employers look for:</strong> OR experience, clinical credentialing (RepTrax, Vendormate), and a history of consistent quota performance are the primary differentiators. Stryker, Medtronic, Boston Scientific, and Zimmer Biomet are among the most active hirers and typically promote from within — making entry-level associate rep roles a strong path into the field.</p>
<p>ROOK pulls device openings directly from manufacturer career sites, giving you access to roles that match your territory and specialty before they reach the major job boards.</p>`,

    label: "Medical Device Sales Jobs",
    description: "ROOK sources medical device sales jobs directly from manufacturer career sites — capital equipment, surgical, implantables, diagnostics, and more.",
    companySlugs: [
      "stryker","medtronic","abbott","boston-scientific","edwards-lifesciences",
      "becton-dickinson","zimmer-biomet","insulet","integra-lifesciences",
      "natus-medical","artivion","agiliti","hologic","invacare",
    ],
  },
  "diagnostics-sales-jobs": { longContent: `<p>Diagnostics and laboratory sales roles involve selling testing platforms, reagents, molecular assays, and genomic analysis services to hospitals, independent labs, physician offices, and health systems. The category spans clinical chemistry, molecular diagnostics, pathology, point-of-care testing, and precision oncology.</p>
<p><strong>Compensation:</strong> Diagnostics reps typically earn $70,000–$95,000 base with total compensation of $100,000–$160,000. Precision oncology and genomics roles (Foundation Medicine, Guardant Health, Tempus, Exact Sciences) often carry higher upside given longer sales cycles and larger deal sizes.</p>
<p><strong>What employers look for:</strong> A science or clinical background is valued — medical technologists, lab scientists, and nurses transition well into diagnostics sales. For precision oncology specifically, oncology selling experience is highly sought. Quest Diagnostics, Labcorp, and major diagnostics manufacturers (Roche, Abbott, Beckman Coulter) hire continuously across all experience levels.</p>
<p>ROOK sources these roles directly from employer career sites, including emerging genomics companies that often don't post on traditional job boards.</p>`,

    label: "Diagnostics & Laboratory Sales Jobs",
    description: "ROOK pulls diagnostics and laboratory sales jobs directly from employer career sites — clinical, molecular, pathology, genomics, and point-of-care.",
    companySlugs: [
      "quest-diagnostics","labcorp","biodesix","foundation-medicine",
      "guardant-health","neogenomics","exact-sciences","tempus","caris-life-sciences",
      "natera","somalogic","veracyte","biocryst-pharmaceuticals","eisai",
    ],
  },
  "veterinary-sales-jobs": { longContent: `<p>Veterinary sales professionals sell pharmaceuticals, diagnostics, nutrition, and medical equipment to veterinary practices, animal hospitals, and production animal operations. The field includes companion animal, equine, and production/food animal segments — each with distinct customer relationships and product portfolios.</p>
<p><strong>Compensation:</strong> Veterinary sales roles typically range from $60,000–$85,000 base with total compensation of $85,000–$140,000. Senior roles at IDEXX, Zoetis, and Elanco often pay above this range given the complexity of the territory and the relationship-driven nature of the veterinary market.</p>
<p><strong>What employers look for:</strong> A veterinary or animal science background is a significant advantage, though not always required. IDEXX in particular recruits heavily from vet tech and clinical backgrounds. Demonstrated sales success, a passion for animal health, and the ability to build trust with DVMs are the consistent hiring criteria across the segment.</p>
<p>ROOK pulls veterinary sales openings directly from employer career sites at IDEXX, Zoetis, Elanco, Merck Animal Health, Hill's Pet Nutrition, Royal Canin, and others.</p>`,

    label: "Veterinary Sales Jobs",
    description: "ROOK sources veterinary and animal health sales jobs directly from employer career sites — diagnostics, pharmaceuticals, nutrition, and practice management.",
    companySlugs: [
      "idexx","zoetis","hills-pet-nutrition","royal-canin","purina-pro-plan",
      "elanco","merck-animal-health","boehringer-ingelheim","virbac","phibro",
      "dechra","patterson-companies","henry-schein-animal-health",
    ],
  },
  "animal-health-sales-jobs": { longContent: `<p>Animal health sales spans pharmaceuticals, biologics, parasiticides, diagnostics, and nutritional products sold to veterinarians, feed dealers, and production animal operations. The segment is growing rapidly, driven by increased pet ownership, humanization of companion animals, and biosecurity demands in food animal production.</p>
<p><strong>Compensation:</strong> Animal health reps typically earn $60,000–$90,000 base with total compensation of $85,000–$145,000. Production animal roles covering large territories often include vehicle allowances and higher commission rates given the volume-driven nature of the business.</p>
<p><strong>What employers look for:</strong> An agricultural, veterinary, or life science background is valued, particularly for production animal roles. For companion animal roles, clinic experience and relationship skills with DVMs matter most. Zoetis, Elanco, and Merck Animal Health are the largest employers and hire at all experience levels.</p>
<p>ROOK sources animal health openings directly from employer career sites — you'll see roles before they appear on Indeed or LinkedIn.</p>`,

    label: "Animal Health Sales Jobs",
    description: "ROOK sources animal health sales jobs directly from top employer career sites.",
    companySlugs: [
      "idexx","zoetis","elanco","merck-animal-health","boehringer-ingelheim",
      "virbac","phibro","dechra","hills-pet-nutrition","royal-canin",
    ],
  },
  "territory-sales-manager-jobs": { longContent: `<p>Territory sales manager roles exist across every segment of medical and veterinary sales — medical device, diagnostics, pharma, and animal health. The title indicates a geography-based book of business, typically covering multiple accounts within a defined region, and often reporting to a regional or district sales manager.</p>
<p><strong>Compensation:</strong> TSM compensation varies widely by industry and company. Device and specialty pharma TSMs typically earn $75,000–$110,000 base with total compensation of $110,000–$180,000. Diagnostics and primary care pharma roles tend toward the lower end of that range.</p>
<p><strong>What employers look for:</strong> Consistent quota attainment (typically 100%+ for 2+ years), the ability to manage a pipeline independently, and strong CRM discipline. Companies want reps who can work without daily supervision and have demonstrated growth within their existing accounts.</p>
<p>ROOK matches territory sales manager openings to your specific geography — so you only see roles that fit your location and background.</p>`,

    label: "Territory Sales Manager Jobs",
    description: "ROOK matches territory sales manager openings directly from employer career sites across medical, pharma, and veterinary companies.",
    companySlugs: [], // show all companies — no specific subset
  },
  "key-account-manager-jobs": { longContent: `<p>Key account manager roles in medical and veterinary sales involve managing strategic relationships with large health systems, GPOs, IDNs, or national accounts. Unlike territory reps, KAMs focus on contract negotiation, formulary positioning, and executive-level relationship management across multiple sites or divisions of a single account.</p>
<p><strong>Compensation:</strong> KAM roles are among the highest-paying in the industry, reflecting the complexity and revenue impact of the accounts managed. Base salaries typically range from $90,000–$130,000 with total compensation of $140,000–$220,000+. National account roles at large device or pharma companies often exceed this range.</p>
<p><strong>What employers look for:</strong> A track record of managing complex, multi-stakeholder accounts; experience with GPO contracting and IDN navigation; and the ability to build relationships at the C-suite and VP level. Most employers require 5+ years of field sales success before considering candidates for KAM roles.</p>
<p>ROOK sources KAM openings directly from employer career sites and scores them against your experience and location preferences.</p>`,

    label: "Key Account Manager Jobs",
    description: "ROOK sources key account manager jobs from employer career sites across the medical, pharma, and healthcare industry.",
    companySlugs: [],
  },
  "capital-equipment-sales-jobs": { longContent: `<p>Capital equipment sales involves selling large, high-value medical devices — imaging systems, surgical robots, laboratory analyzers, patient monitoring platforms, and similar equipment — to hospitals, surgery centers, and health systems. These are complex, consultative sales with long cycles (6–18 months) and multiple stakeholders including clinical, administrative, and finance decision-makers.</p>
<p><strong>Compensation:</strong> Capital equipment reps are among the highest earners in medical sales. Base salaries range from $80,000–$120,000 with total compensation of $150,000–$300,000+ for top performers selling high-ticket systems. Commission structures often include bonuses on service contracts and consumables in addition to equipment placements.</p>
<p><strong>What employers look for:</strong> Experience managing long sales cycles, hospital-level relationship skills, and the ability to build ROI-based business cases for C-suite buyers. Companies like Stryker, Hologic, Medtronic, and Boston Scientific are the primary hirers in this space and often prefer candidates with demonstrated device or capital sales backgrounds.</p>
<p>ROOK pulls capital equipment openings directly from manufacturer career sites, scored against your geography and experience.</p>`,

    label: "Capital Equipment Sales Jobs",
    description: "ROOK pulls capital equipment sales jobs directly from manufacturer career sites.",
    companySlugs: [
      "stryker","medtronic","boston-scientific","zimmer-biomet",
      "agiliti","hologic","invacare","integra-lifesciences",
    ],
  },
};

// GET /jobs/category/:slug — a real, server-rendered landing page per
// category, listing genuinely matching real jobs (title, location,
// compensation only — no description snippet here at all, since
// scrubbing a company name out of raw description text has already
// proven to miss abbreviated/shortened forms of a company's name once
// already; a plain list of real title/location/comp carries zero of
// that risk while still being genuinely useful).
router.get("/jobs/category/:slug", async (req, res, next) => {
  const category = CATEGORIES[req.params.slug];
  if (!category || !isConfigured) return next();

  // Query active employers matching this category's company slug list.
  // If the category has no specific slugs (e.g. territory-manager), show
  // all active employers sorted by name.
  let employerQuery = supabaseAnon
    .from("employers")
    .select("company_name, company_slug, active")
    .eq("active", true)
    .order("company_name", { ascending: true });

  if (category.companySlugs && category.companySlugs.length > 0) {
    employerQuery = employerQuery.in("company_slug", category.companySlugs);
  }

  const { data: employers } = await employerQuery;
  const companyList = employers || [];

  const canonicalUrl = `${APP_BASE_URL}/jobs/category/${req.params.slug}`;
  const metaDescription = `ROOK sources ${category.label.toLowerCase()} directly from ${companyList.length}+ employer career sites — scored against your real background. Sign up to see your matches.`.slice(0, 300);
  const otherCategories = Object.entries(CATEGORIES).filter(([slug]) => slug !== req.params.slug);

  const trialDays = getTrialPeriodDays();
  const ctaBlock = trialDays > 0
    ? `<div style="color:#fff;font-size:15px;font-weight:700;margin-bottom:2px;">${trialDays} days free, then $29/month</div>
      <div style="color:#B9C4DB;font-size:13px;font-weight:600;margin-bottom:18px;">Cancel anytime.</div>
      <a href="/rook-onboarding-v4.html" class="btn btn-primary">Start Your ${trialDays}-Day Free Trial</a>
      <div style="color:#8B96AB;font-size:12px;margin-top:10px;">$0 today. Full ROOK access during your trial.</div>`
    : `<div style="color:#fff;font-size:15px;font-weight:700;margin-bottom:18px;">$29/month · Cancel anytime</div>
      <a href="/rook-onboarding-v4.html" class="btn btn-primary">Get Started</a>
      <div style="color:#8B96AB;font-size:12px;margin-top:10px;">One membership. Full ROOK access.</div>`;

  const companyGrid = companyList.length > 0
    ? `<div style="display:flex;flex-wrap:wrap;gap:10px;margin-bottom:32px;">
        ${companyList.map(c => `<div style="background:#fff;border:1px solid var(--border);border-radius:10px;padding:12px 18px;font-size:14px;font-weight:600;color:var(--navy);">${escapeHtml(c.company_name)}</div>`).join("")}
      </div>`
    : `<p style="color:var(--muted);font-size:14px;margin-bottom:32px;">We're actively adding more employers in this category — check back soon.</p>`;

  const bodyHtml = `
    <h1 style="font-size:28px;margin-bottom:10px;">${escapeHtml(category.label)}</h1>
    <p style="color:var(--muted);font-size:14.5px;margin-bottom:24px;">${escapeHtml(category.description)}</p>

    ${category.longContent ? `<div style="background:#fff;border:1px solid var(--border);border-radius:var(--radius);padding:24px;margin-bottom:28px;font-size:14.5px;line-height:1.8;color:var(--navy);">${category.longContent}</div>` : ""}

    <div style="font-size:13px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.04em;margin-bottom:14px;">
      ${companyList.length} Companies We Source From
    </div>
    ${companyGrid}

    <div style="background:var(--navy);border-radius:var(--radius);padding:28px 24px;text-align:center;margin-bottom:36px;">
      <h3 style="color:#fff;font-size:19px;margin-bottom:8px;">See which roles match your background</h3>
      <p style="color:#B9C4DB;font-size:13.5px;margin-bottom:14px;">ROOK scores every open role at these companies against your experience, location, and preferences — so you see your best matches first.</p>
      ${ctaBlock}
    </div>

    <div>
      <div style="font-size:12.5px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:0.02em;margin-bottom:12px;">Browse other categories</div>
      <div style="display:flex;flex-wrap:wrap;gap:8px;">
        ${otherCategories.map(([slug, c]) => `<a href="/jobs/category/${slug}" style="font-size:13px;color:var(--royal);background:rgba(20,99,255,0.08);padding:7px 14px;border-radius:99px;font-weight:600;">${escapeHtml(c.label)}</a>`).join("")}
      </div>
    </div>
  `;

  res.send(pageShell({ title: `${category.label} — ROOK`, description: metaDescription, canonicalUrl, bodyHtml }));
});

// GET /sitemap.xml — lists the homepage, the public browse page, and
// every currently-active job's real crawlable URL. Regenerated on every
// request rather than cached as a static file, since the job list
// changes continuously via the scheduled ingestion job.
router.get("/sitemap.xml", async (req, res) => {
  const staticUrls = [
    `${APP_BASE_URL}/`,
    `${APP_BASE_URL}/rook-browse.html`,
    `${APP_BASE_URL}/rook-about.html`,
    `${APP_BASE_URL}/rook-pricing.html`,
    `${APP_BASE_URL}/rook-employers.html`,
    ...Object.keys(CATEGORIES).map((slug) => `${APP_BASE_URL}/jobs/category/${slug}`),
  ];

  let jobUrls = [];
  if (isConfigured) {
    const { data: jobs } = await supabaseAnon
      .from("jobs")
      .select("id, last_seen_at")
      .eq("status", "active")
      .limit(5000);
    jobUrls = (jobs || []).map((j) => ({ url: `${APP_BASE_URL}/jobs/${j.id}`, lastmod: j.last_seen_at }));
  }

  const urlEntries = [
    ...staticUrls.map((url, i) => {
      const priority = i === 0 ? "1.0" : url.includes("/jobs/category/") ? "0.8" : "0.6";
      return `<url><loc>${escapeHtml(url)}</loc><priority>${priority}</priority></url>`;
    }),
    ...jobUrls.map(
      (j) => `<url><loc>${escapeHtml(j.url)}</loc><priority>0.6</priority>${j.lastmod ? `<lastmod>${new Date(j.lastmod).toISOString().slice(0, 10)}</lastmod>` : ""}<changefreq>weekly</changefreq></url>`
    ),
  ].join("\n");

  res.set("Content-Type", "application/xml");
  res.send(`<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlEntries}\n</urlset>`);
});

module.exports = router;
