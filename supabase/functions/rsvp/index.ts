import { createClient } from "npm:@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

const hostEmails = [
  "vromero.beltran2016@gmail.com",
  "mariclua.claudia@gmail.com",
];

const supabaseUrl = Deno.env.get("SUPABASE_URL");
const serviceRoleKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const resendApiKey = Deno.env.get("RESEND_API_KEY");
const fromEmail = Deno.env.get("RSVP_FROM_EMAIL");
const siteUrl = Deno.env.get("RSVP_SITE_URL");

class HttpError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

const respond = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function requiredConfig() {
  if (!supabaseUrl || !serviceRoleKey || !resendApiKey || !fromEmail || !siteUrl) {
    throw new Error("The RSVP service is not fully configured. Please contact the hosts.");
  }
  return { supabaseUrl, serviceRoleKey, resendApiKey, fromEmail, siteUrl };
}

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character]!);
}

async function hashToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function validateText(value: unknown, field: string, maxLength: number, required: boolean) {
  if (typeof value !== "string") {
    if (required) throw new HttpError(`${field} is required.`, 400);
    return "";
  }
  const trimmed = value.trim();
  if (required && !trimmed) throw new HttpError(`${field} is required.`, 400);
  if (trimmed.length > maxLength) {
    throw new HttpError(`${field} must be ${maxLength} characters or fewer.`, 400);
  }
  return trimmed;
}

function editLink(siteUrl: string, token: string) {
  const url = new URL(siteUrl);
  url.hash = `edit=${encodeURIComponent(token)}`;
  return url.toString();
}

async function sendEmail(
  config: ReturnType<typeof requiredConfig>,
  to: string[],
  subject: string,
  html: string,
) {
  try {
    const response = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${config.resendApiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ from: config.fromEmail, to, subject, html }),
    });
    if (!response.ok) {
      console.error("Email provider rejected a message:", response.status, await response.text());
      throw new Error("provider rejected email");
    }
  } catch (error) {
    console.error("Email delivery failed:", error);
    throw new HttpError(
      "The RSVP was saved, but an email could not be sent. Please try saving again.",
      502,
    );
  }
}

function rsvpDetails(rsvp: Record<string, string>) {
  const potluck = rsvp.potluck === "Other"
    ? `Other — ${rsvp.customPotluck}`
    : rsvp.potluck;
  return `<ul>
    <li><strong>Name:</strong> ${escapeHtml(rsvp.name)}</li>
    <li><strong>Email:</strong> ${escapeHtml(rsvp.email)}</li>
    <li><strong>Attendance:</strong> ${escapeHtml(rsvp.status)}</li>
    <li><strong>Potluck:</strong> ${escapeHtml(potluck)}</li>
    <li><strong>Costume:</strong> ${escapeHtml(rsvp.costume || "Not specified")}</li>
  </ul>`;
}

Deno.serve(async (request: Request) => {
  if (request.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (request.method !== "POST") return respond({ error: "Method not allowed." }, 405);

  try {
    const config = requiredConfig();
    let body: Record<string, unknown>;
    try {
      body = await request.json();
    } catch {
      throw new HttpError("Invalid request body.", 400);
    }
    const supabase = createClient(config.supabaseUrl, config.serviceRoleKey, {
      auth: { autoRefreshToken: false, persistSession: false },
    });

    if (body.action === "options") {
      let ownRsvpId: string | null = null;
      if (body.editToken) {
        if (typeof body.editToken !== "string" || !/^[a-f0-9]{64}$/i.test(body.editToken)) {
          return respond({ error: "This RSVP edit link is invalid." }, 400);
        }
        const { data: ownRsvp, error } = await supabase
          .from("event_rsvps")
          .select("id, name, email, status, potluck, custom_potluck, costume")
          .eq("edit_token_hash", await hashToken(body.editToken))
          .maybeSingle();
        if (error) throw error;
        if (!ownRsvp) return respond({ error: "This RSVP edit link is invalid or expired." }, 404);
        ownRsvpId = ownRsvp.id;
        body.rsvp = {
          id: ownRsvp.id,
          name: ownRsvp.name,
          email: ownRsvp.email,
          status: ownRsvp.status,
          potluck: ownRsvp.potluck,
          customPotluck: ownRsvp.custom_potluck,
          costume: ownRsvp.costume,
        };
      }

      const [{ data: options, error: optionsError }, { data: reservations, error: reservationsError }] =
        await Promise.all([
          supabase.from("potluck_options")
            .select("value, label")
            .eq("is_active", true)
            .order("sort_order"),
          supabase.from("potluck_reservations").select("reservation_key, rsvp_id"),
        ]);
      if (optionsError) throw optionsError;
      if (reservationsError) throw reservationsError;
      const reservedBy = new Map(
        reservations.map((reservation) => [reservation.reservation_key, reservation.rsvp_id]),
      );
      return respond({
        options: options.map((option) => ({
          ...option,
          available: option.value === "Other"
            || !reservedBy.has(option.value)
            || reservedBy.get(option.value) === ownRsvpId,
        })),
        rsvp: body.rsvp || null,
      });
    }

    if (body.action !== "save") return respond({ error: "Unknown RSVP action." }, 400);

    const token = validateText(body.editToken, "Edit token", 64, true);
    if (!/^[a-f0-9]{64}$/i.test(token)) throw new HttpError("Invalid edit token.", 400);
    const name = validateText(body.name, "Name", 120, true);
    const email = validateText(body.email, "Email", 254, true);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      throw new HttpError("Enter a valid email address.", 400);
    }
    const status = validateText(body.status, "Attendance", 20, true);
    if (!["attending", "maybe", "declined"].includes(status)) {
      throw new HttpError("Invalid RSVP status.", 400);
    }
    const potluck = validateText(body.potluck, "Potluck choice", 120, true);
    const customPotluck = validateText(body.customPotluck, "Custom potluck choice", 200, potluck === "Other");
    const costume = validateText(body.costume, "Costume", 160, false);

    const { data: saved, error: saveError } = await supabase.rpc("save_event_rsvp", {
      p_edit_token_hash: await hashToken(token),
      p_name: name,
      p_email: email,
      p_status: status,
      p_potluck: potluck,
      p_custom_potluck: customPotluck,
      p_costume: costume,
    });
    if (saveError) throw saveError;
    if (!saved.ok) return respond({ error: saved.error }, 409);

    const rsvp = saved.rsvp as Record<string, string>;
    const previous = saved.previous as Record<string, string> | null;
    const changedFields = previous
      ? ([
        ["name", "Name"],
        ["email", "Email"],
        ["status", "Attendance"],
        ["potluck", "Potluck choice"],
        ["customPotluck", "Custom potluck details"],
        ["costume", "Costume"],
      ] as const)
        .filter(([key]) => previous[key] !== rsvp[key])
        .map(([, label]) => label)
      : [];
    const subject = saved.updated
      ? "Halloween Bash RSVP updated"
      : "New Halloween Bash RSVP";
    const hostHtml = saved.updated
      ? `<p>An RSVP was updated.</p><p><strong>Changed:</strong> ${escapeHtml(changedFields.join(", ") || "No details changed")}</p><h3>Previous RSVP</h3>${rsvpDetails(previous!)}<h3>Current RSVP</h3>${rsvpDetails(rsvp)}`
      : `<p>A new RSVP was received.</p>${rsvpDetails(rsvp)}`;
    const link = editLink(config.siteUrl, token);

    await sendEmail(config, hostEmails, subject, hostHtml);
    await sendEmail(
      config,
      [rsvp.email],
      saved.updated ? "Your Halloween Bash RSVP changes were received" : "Your Halloween Bash RSVP was received",
      saved.updated
        ? `<p>Red Riding Hood and the Wolf have been notified of your changes.</p><p>If you want to make any more changes to your RSVP, <a href="${escapeHtml(link)}">edit it here</a>.</p>`
        : `<p>Your RSVP was successful, and Red Riding Hood has received it.</p><p>If you want to change your name, potluck choice, costume, or other RSVP details, <a href="${escapeHtml(link)}">make changes here</a>.</p>`,
    );

    const [{ data: options, error: optionsError }, { data: reservations, error: reservationsError }] =
      await Promise.all([
        supabase.from("potluck_options")
          .select("value, label")
          .eq("is_active", true)
          .order("sort_order"),
        supabase.from("potluck_reservations").select("reservation_key, rsvp_id"),
      ]);
    if (optionsError) throw optionsError;
    if (reservationsError) throw reservationsError;
    const reservedBy = new Map(
      reservations.map((reservation) => [reservation.reservation_key, reservation.rsvp_id]),
    );
    return respond({
      updated: saved.updated,
      rsvp,
      options: options.map((option) => ({
        ...option,
        available: option.value === "Other"
          || !reservedBy.has(option.value)
          || reservedBy.get(option.value) === rsvp.id,
      })),
    });
  } catch (error) {
    console.error("RSVP function failed:", error);
    const message = error instanceof HttpError
      ? error.message
      : "Unexpected RSVP service error. Please try again later.";
    return respond({ error: message }, error instanceof HttpError ? error.status : 500);
  }
});
