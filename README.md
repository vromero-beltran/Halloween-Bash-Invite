# Halloween-Bash-Invite

## RSVP setup

The RSVP form uses Supabase to save submissions and reserve potluck choices, and Resend to email the hosts and guests. Until these services are configured and deployed, the form will display a setup message and will not accept submissions.

### Configure Supabase and Resend

1. Create a Supabase project and a Resend account. Verify the sending domain in Resend and choose a sender address on that domain.
2. In the Supabase SQL Editor, run [`20261012000000_create_rsvp_storage.sql`](./supabase/migrations/20261012000000_create_rsvp_storage.sql). This creates the RSVP tables, initial potluck choices, and the server-only save procedure.
3. In `index.html`, replace `YOUR_PROJECT_REF` in `RSVP_API_URL` with the Supabase project reference, and replace `YOUR_SUPABASE_ANON_KEY` with the project's public anon key. Never put the Supabase service-role key or Resend API key in the HTML.
4. From the repository folder, link the Supabase CLI to the project and deploy the function:

   ```powershell
   supabase login
   supabase link --project-ref YOUR_PROJECT_REF
   supabase functions deploy rsvp
   ```

5. Set the server-side Resend and website settings:

   ```powershell
   supabase secrets set RESEND_API_KEY=YOUR_RESEND_API_KEY RSVP_FROM_EMAIL="Halloween Bash <rsvp@YOUR_VERIFIED_DOMAIN>" RSVP_SITE_URL=https://YOUR_PUBLIC_SITE_URL/
   ```

   `RSVP_SITE_URL` must be the public URL where `index.html` is hosted. The edit link in confirmation emails points there.
6. Open the deployed page and submit a test RSVP. Verify that both hosts receive the notification and that the guest receives the confirmation/edit link.

Edit tokens are generated in the browser, sent only to the RSVP function, and stored in the database as SHA-256 hashes. A guest's emailed edit link uses the URL fragment, so the token is not sent in normal page requests. Potluck reservations are enforced in the database, so two guests cannot claim the same option at the same time. For `Other`, each guest's normalized description is reserved, while the general `Other` category remains available for different proposed items that need host approval.

### Add or change potluck choices

Manage the list in Supabase's SQL Editor. Each option's `value` must be unique; `label` is what guests see. For example:

```sql
insert into public.potluck_options (value, label, sort_order)
values ('Pumpkin pie', 'Pumpkin pie', 15);
```

To temporarily hide an option, set `is_active` to `false`. Existing reservations are retained while an option is hidden.