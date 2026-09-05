// Wrapper around Buffer's CURRENT GraphQL API (https://api.buffer.com)
// — the legacy REST API (api.bufferapp.com/1/) no longer accepts
// personal API keys and is not used anywhere in this file. Every
// shape here (query/mutation text, field names, error handling) is
// taken directly from Buffer's own current developer documentation
// (developers.buffer.com), not guessed:
//   - account.organizations: developers.buffer.com/guides/data-model.md
//   - channels(input: {organizationId}): developers.buffer.com/guides/your-first-post.md
//   - createPost + assets: developers.buffer.com/guides/hosting-media.md
//   - mode: shareNow for immediate posting: developers.buffer.com/guides/rest-migration.md
//   - posts() query for retrieval: developers.buffer.com/guides/posts-and-scheduling.md
//
// Single POST endpoint, single Content-Type, single auth header — no
// per-resource URLs, unlike the old REST API. Dependency-injectable
// httpFetch so this is fully testable without any real network call.

const BUFFER_API_ENDPOINT = "https://api.buffer.com";

async function bufferGraphQLRequest(accessToken, query, variables, { httpFetch = fetch } = {}) {
  if (!accessToken) {
    throw new Error("BUFFER_ACCESS_TOKEN is not configured — refusing to call the Buffer API without it");
  }
  const res = await httpFetch(BUFFER_API_ENDPOINT, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      Accept: "application/json",
    },
    body: JSON.stringify({ query, variables: variables || {} }),
  });

  const text = await res.text();
  let payload;
  try {
    payload = text ? JSON.parse(text) : {};
  } catch {
    throw new Error(`Buffer API returned a non-JSON response (HTTP ${res.status})`);
  }

  if (!res.ok) {
    throw new Error(`Buffer API error (HTTP ${res.status}): ${payload?.errors?.[0]?.message || text || "unknown error"}`);
  }
  // Top-level GraphQL errors (bad query, auth failure, etc.) — distinct
  // from a MutationError, which is a normal, successful HTTP 200
  // response representing a business-logic failure (see createPost
  // below for that case).
  if (Array.isArray(payload.errors) && payload.errors.length > 0) {
    throw new Error(payload.errors.map((e) => e.message).join("; "));
  }
  return payload.data;
}

/**
 * Retrieves every organization on this account. Required first step —
 * channels can't be listed without an organizationId.
 */
async function getOrganizations(accessToken, opts) {
  const query = `
    query GetOrganizations {
      account {
        organizations {
          id
          name
        }
      }
    }`;
  const data = await bufferGraphQLRequest(accessToken, query, {}, opts);
  return data?.account?.organizations || [];
}

/**
 * Lists every channel (connected social profile) for one organization.
 */
async function listChannelsForOrganization(accessToken, organizationId, opts) {
  const query = `
    query GetChannels($organizationId: OrganizationId!) {
      channels(input: { organizationId: $organizationId }) {
        id
        name
        service
      }
    }`;
  const data = await bufferGraphQLRequest(accessToken, query, { organizationId }, opts);
  return (data?.channels || []).map((c) => ({ ...c, organizationId }));
}

/**
 * Convenience: every channel across every organization on this
 * account — the actual channel-discovery primitive the worker uses,
 * since most accounts have exactly one organization but this handles
 * more than one correctly too.
 */
async function listAllChannels(accessToken, opts) {
  const organizations = await getOrganizations(accessToken, opts);
  const allChannels = [];
  for (const org of organizations) {
    const channels = await listChannelsForOrganization(accessToken, org.id, opts);
    allChannels.push(...channels);
  }
  return allChannels;
}

/**
 * Creates and immediately publishes a post to a single channel.
 * mode: "shareNow" is the documented GraphQL equivalent of the old
 * REST API's `now: true` parameter. One call per channel — the
 * GraphQL API takes a single channelId, not an array of profile IDs
 * like the old REST API did.
 */
async function createPost(accessToken, { channelId, text, photoUrl, mode = "shareNow", dueAt }, opts) {
  if (!channelId) throw new Error("createPost requires a channelId");
  const query = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess {
          post {
            id
            text
            status
            dueAt
          }
        }
        ... on MutationError {
          message
        }
      }
    }`;
  const input = { text, channelId, schedulingType: "automatic", mode };
  if (photoUrl) input.assets = [{ image: { url: photoUrl } }];
  if (mode === "customScheduled" && dueAt) input.dueAt = dueAt;

  const data = await bufferGraphQLRequest(accessToken, query, { input }, opts);
  const result = data?.createPost;

  // MutationError is a NORMAL, successful HTTP 200 response
  // representing a business-logic failure (invalid channel, queue
  // full, media fetch failure, etc.) — distinct from the top-level
  // GraphQL errors already handled in bufferGraphQLRequest above.
  if (result?.message && !result.post) {
    const err = new Error(result.message);
    err.isMutationError = true;
    throw err;
  }
  return result?.post;
}

/**
 * Looks up posts for an organization, optionally filtered by channel
 * — used to check a specific post's current status. Buffer's GraphQL
 * API does not expose a single-post-by-ID query in its documented
 * examples; this queries the list and finds the matching id, which is
 * the same approach Buffer's own docs show for "sent posts" lookups.
 */
async function findPostById(accessToken, organizationId, postId, opts) {
  const query = `
    query GetPosts($organizationId: OrganizationId!) {
      posts(first: 50, input: { organizationId: $organizationId }) {
        edges {
          node {
            id
            text
            status
            dueAt
            channelId
          }
        }
      }
    }`;
  const data = await bufferGraphQLRequest(accessToken, query, { organizationId }, opts);
  const edges = data?.posts?.edges || [];
  return edges.map((e) => e.node).find((p) => p.id === postId) || null;
}

module.exports = {
  BUFFER_API_ENDPOINT,
  getOrganizations,
  listChannelsForOrganization,
  listAllChannels,
  createPost,
  findPostById,
};
