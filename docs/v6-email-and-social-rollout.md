# V6 email verification and third daily social post

Deploy these together only after the production settings below are ready. The new v6 signup requires an email code; a link-only email template or disabled Confirm email setting will prevent new users from finishing signup.

1. In the ROOK Supabase project's Authentication settings, enable **Confirm email** for Email signups. In Authentication > Email Templates > Confirm signup, include `{{ .Token }}` in the message body (for example: `Your ROOK verification code is {{ .Token }}`). Keep the existing branding and from address. Test delivery to an address you control before deploying the new signup.
2. In the same production Supabase project, run `backend/db/enable-midday-social-post.sql` in the SQL editor. This allows the worker's `mid` slot in `social_post_history`. Apply this before deploying the new worker.
3. Confirm DigitalOcean's existing Scheduled Job calls `npm run social:scheduled-dispatch` every 15 minutes, `SOCIAL_AUTOMATION_ENABLED` is enabled, and Buffer Facebook and LinkedIn channel configuration is present. The worker queues posts at **9 AM, 1 PM, and 5 PM Eastern**, selecting them at about 8:30 AM, 12:30 PM, and 4:30 PM. It does not bulk fill several days of the Buffer queue.
4. Deploy the code. From v4, follow the redirect to v6, finish the four questions, choose **Create my free account**, and sign up with an email address you control. Check that an invalid code cannot reach the dashboard, the complete delivered code does, and the resulting dashboard shows masked jobs. Check that the first upcoming midday worker run creates history with slot `mid` and posts in both Buffer channels.

If the template or email delivery is not ready, hold this deployment: the old signup needs the existing backend until the replacement flow is available. No matching, scoring, paid ad budgets, or existing Buffer posts are changed by this patch.
