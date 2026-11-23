// Masks credentials and signatures in diagnostics. Applied to every line
// written to stderr and to error messages; the result document itself carries the tokens the user
// asked for (delete token, access token and URL) and is not masked.

const TOKEN = /\bih([dak])_[A-Za-z0-9_-]+/g;
const SIGNED_PARAM = /\b(X-Amz-(?:Signature|Credential|Security-Token))=[^&\s"']+/gi;
const TOKEN_PARAM = /([?&]token=)[^&\s"']+/gi;
const BEARER = /\b(Bearer\s+)[^\s"']+/gi;

export function redact(text: string): string {
  return text
    .replace(TOKEN, (_m, kind: string) => `ih${kind}_***`)
    .replace(SIGNED_PARAM, "$1=***")
    .replace(TOKEN_PARAM, "$1***")
    .replace(BEARER, "$1***");
}

/** A URL safe for diagnostics: origin and path only (no query string, which may hold a signature). */
export function describeUrl(url: string): string {
  try {
    const u = new URL(url);
    return redact(`${u.origin}${u.pathname}`);
  } catch {
    return "<invalid url>";
  }
}
