// GET /api/career-intelligence — surfaces what's already been extracted
// from the candidate's résumé (backend/ai/resumeAnalysis.js), plus a
// genuinely computed "gaps" signal: industries and specialties that show
// up often across currently-listed jobs' AI analysis but aren't present
// on this candidate's résumé. No new AI calls here — everything is
// derived from data that already exists in the database.

const express = require("express");
const { createClient } = require("@supabase/supabase-js");

const router = express.Router();

const isConfigured = Boolean(
  process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY && process.env.SUPABASE_SERVICE_ROLE_KEY
);
const supabaseAnon = (process.env.SUPABASE_URL && process.env.SUPABASE_ANON_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY)
  : null;
const supabaseAdmin = (process.env.SUPABASE_URL && process.env.SUPABASE_SERVICE_ROLE_KEY)
  ? createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY)
  : null;

function requireConfig(req, res, next) {
  if (!isConfigured) {
    return res.status(503).json({ error: "Supabase isn't configured on this server yet. See ROOK-Setup-Guide.pdf." });
  }
  next();
}

async function requireAuth(req, res, next) {
  const token = (req.headers.authorization || "").replace("Bearer ", "");
  if (!token) return res.status(401).json({ error: "Missing Authorization header" });
  const { data, error } = await supabaseAnon.auth.getUser(token);
  if (error || !data.user) return res.status(401).json({ error: "Invalid or expired token" });
  req.user = data.user;
  next();
}

router.get("/career-intelligence", requireConfig, requireAuth, async (req, res) => {
  const { data: profile } = await supabaseAdmin
    .from("candidate_profiles")
    .select("resume_structured")
    .eq("user_id", req.user.id)
    .maybeSingle();

  if (!profile || !profile.resume_structured) {
    return res.json({ has_resume: false });
  }
  const resume = profile.resume_structured;

  // Aggregate required_industries and specialty_requirements across every
  // AI-analyzed active job, to find what's commonly required but not on
  // this résumé — a real, computed gap signal, not a fabricated one.
  const { data: jobs } = await supabaseAdmin
    .from("jobs")
    .select("ai_analysis")
    .eq("status", "active")
    .not("ai_analysis", "is", null)
    .limit(500);

  const industryCounts = {};
  const specialtyCounts = {};
  for (const job of jobs || []) {
    for (const ind of job.ai_analysis?.required_industries || []) {
      industryCounts[ind] = (industryCounts[ind] || 0) + 1;
    }
    for (const spec of job.ai_analysis?.specialty_requirements || []) {
      specialtyCounts[spec] = (specialtyCounts[spec] || 0) + 1;
    }
  }

  const resumeIndustries = new Set((resume.industries_experience || []).map((i) => String(i.industry).toLowerCase()));
  const resumeSpecialties = new Set((resume.specialties || []).map((s) => String(s).toLowerCase()));

  const gaps = [
    ...Object.entries(industryCounts)
      .filter(([ind]) => !resumeIndustries.has(ind.toLowerCase()))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 3)
      .map(([ind, count]) => `${ind} experience — required by ${count} currently-listed job(s), not shown on your résumé`),
    ...Object.entries(specialtyCounts)
      .filter(([spec]) => !resumeSpecialties.has(spec.toLowerCase()))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 2)
      .map(([spec, count]) => `${spec} specialty experience — required by ${count} currently-listed job(s)`),
  ];
  if (resume.management_experience === false) {
    gaps.push("No formal people-management experience shown on your résumé");
  }

  // Rough proficiency tag from years_estimate — a simple, explainable
  // heuristic, not a scientific assessment.
  const industries = (resume.industries_experience || []).map((i) => {
    const years = i.years_estimate || 0;
    let tag = "Developing", pct = Math.min(30 + years * 5, 45);
    if (years >= 8) { tag = "Expert"; pct = Math.min(80 + years, 100); }
    else if (years >= 4) { tag = "Strong"; pct = Math.min(55 + years * 3, 79); }
    return { industry: i.industry, years_estimate: i.years_estimate, tag, pct };
  });

  const suggestedRoles = new Set();
  if (resume.seniority_level) {
    for (const ind of resume.industries_experience || []) {
      suggestedRoles.add(`${resume.seniority_level} — ${ind.industry}`);
    }
  }

  res.json({
    has_resume: true,
    industries,
    suggested_roles: Array.from(suggestedRoles).slice(0, 6),
    strengths: resume.performance_highlights || [],
    gaps,
  });
});

module.exports = router;
