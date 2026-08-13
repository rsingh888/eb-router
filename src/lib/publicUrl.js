/** Public origin used for emailed links, OIDC redirects, and org dashboard URLs. */
export function getConfiguredPublicUrl() {
  return String(
    process.env.APP_URL ||
    process.env.BASE_URL ||
    process.env.NEXT_PUBLIC_BASE_URL ||
    "",
  ).trim().replace(/\/+$/, "");
}
