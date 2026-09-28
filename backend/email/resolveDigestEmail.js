async function resolveDigestEmail(supabase, profile) {
  if (profile.email || !profile.user_id) return profile;
  // Earlier V8 claims did not copy the verified auth email to the profile.
  const { data, error } = await supabase.auth.admin.getUserById(profile.user_id);
  if (error) throw new Error(`Could not resolve account email: ${error.message}`);
  const user = data?.user;
  if (!user?.email || !user.email_confirmed_at) return profile;
  return { ...profile, email: user.email };
}
module.exports = { resolveDigestEmail };
