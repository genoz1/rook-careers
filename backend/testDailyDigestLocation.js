const assert = require("node:assert/strict");

const sent = [];
const resendPath = require.resolve("./email/resend");
require.cache[resendPath] = {
  id: resendPath, filename: resendPath, loaded: true,
  exports: { sendEmail: async (message) => { sent.push(message); } },
};
const { sendDigestForCandidate, isDigestLocationMatch } = require("./email/dailyDigest");

const profile = {
  id: "candidate-fl", email: "test@example.com", name: "Test",
  home_lat: 28.92, home_lng: -81.92, home_state: "Florida",
  subscription_status: "active",
};
const job = (id, location_raw, state, job_lat, job_lng) => ({
  id, title_original: id, company_name: "Example", location_raw,
  state, job_lat, job_lng, first_seen_at: new Date().toISOString(),
});
const jacksonville = job("Jacksonville", "Jacksonville | Florida | Tallahassee", "Florida", 30.33, -81.66);
const national = job("US nationwide", "Remote, United States", null, null, null);
const california = job("California", "Remote - California | San Jose, CA", "California", 37.34, -121.89);
const northCarolina = job("North Carolina", "RTP NC | Remote_United States", "North Carolina", 35.9, -78.85);
const puertoRico = job("Puerto Rico", "US PR Remote", "Puerto Rico", 18.46, -66.11);
const floridaStatewide = job("Florida statewide", "United States Remote Office | Florida, USA", "Florida", null, null);

async function run() {
  assert(isDigestLocationMatch(jacksonville, profile));
  assert(isDigestLocationMatch(national, profile));
  assert(isDigestLocationMatch(floridaStatewide, profile));
  for (const far of [california, northCarolina, puertoRico]) {
    assert(!isDigestLocationMatch(far, profile), `${far.id} is outside the candidate's territory`);
  }
  assert(!isDigestLocationMatch(job("restricted remote", "US PR Remote", null, null, null), profile));

  // The first 25 high-scoring results are outside Florida. The digest must
  // search past the old 20-row cutoff to find a genuine local match.
  const newRows = Array.from({ length: 25 }, (_, n) => ({
    overall_score: 95, jobs: { ...california, id: `California ${n}` },
  })).concat([
    { overall_score: 82, jobs: jacksonville },
    { overall_score: 77, jobs: national },
    { overall_score: 91, jobs: puertoRico },
  ]);
  const recentRows = [
    { overall_score: 75, jobs: floridaStatewide },
    { overall_score: 90, jobs: northCarolina },
  ];
  let requests = 0;
  const supabase = {
    from(table) {
      assert.equal(table, "candidate_job_matches");
      const query = {
        select() { return query; }, eq() { return query; }, gte() { return query; },
        order() { return query; },
        limit(n) {
          requests++;
          assert(n > 25, "read enough scored rows to find local jobs after distant matches");
          return Promise.resolve({ data: requests === 1 ? newRows : recentRows, error: null });
        },
      };
      return query;
    },
  };

  const result = await sendDigestForCandidate(supabase, profile, "https://rookcareers.com");
  assert.equal(result.jobCount, 3);
  assert.equal(sent.length, 1);
  assert.match(sent[0].subject, /matching your location/);
  for (const allowed of ["Jacksonville", "US nationwide", "Florida statewide"]) {
    assert(sent[0].html.includes(allowed), `${allowed} should be in the digest`);
  }
  for (const excluded of ["California", "North Carolina", "Puerto Rico"]) {
    assert(!sent[0].html.includes(excluded), `${excluded} should be absent from the digest`);
  }
  console.log("Daily digest location filter: passed");
}

// routes/jobs installs maintenance timers when imported by dailyDigest;
// finish this standalone test once its assertions are complete.
run().then(() => process.exit(0)).catch(err => { console.error(err); process.exit(1); });
