// KKOKDAM fork: limit self-service email sign-up to allowed domains.
// SIGNUP_ALLOWED_DOMAINS = comma-separated list (e.g. "kkokdam.com"). Unset or empty = upstream behaviour (open sign-up).
export function signupAllowed(body: unknown, allowed: string | undefined): boolean {
  const domains = (allowed ?? "")
    .split(",")
    .map((d) => d.trim().toLowerCase())
    .filter(Boolean);
  if (domains.length === 0) return true;
  const email = (body as { email?: unknown } | null)?.email;
  if (typeof email !== "string") return false;
  const at = email.lastIndexOf("@");
  return at > 0 && domains.includes(email.slice(at + 1).trim().toLowerCase());
}
