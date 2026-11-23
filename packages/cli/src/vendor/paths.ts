// A verbatim copy of the path rules the InstaHost API enforces on the server. Do not edit it
// here: changes start in the service, whose tests fail when this copy differs from its source.

// Path rules shared by the InstaHost API and the CLI: path normalisation, invisible and
// control characters, sensitive file names and the directory-walk exclusions.
//
// This file must stay self-contained and runtime-neutral (no imports, no Node or Workers
// APIs). The CLI ships a verbatim copy, with a header naming where it came from, and the
// service's tests fail if that copy drifts from the rules the API enforces.
//
// Paths are only ever D1 lookup keys. They never become part of an R2 key or a filesystem
// path, so these rules exist for clarity and anti-spoofing, not to prevent traversal.

export const MAX_PATH_BYTES = 512;
export const MAX_SEGMENT_BYTES = 255;

export type PathProblem =
  | "empty"
  | "ill_formed_unicode"
  | "too_long"
  | "not_nfc"
  | "control_character"
  | "line_separator"
  | "invisible_character"
  | "backslash"
  | "leading_slash"
  | "trailing_slash"
  | "empty_segment"
  | "dot_segment"
  | "segment_too_long";

export type PathCheck = { ok: true } | { ok: false; reason: PathProblem };

/** UTF-8 length in bytes. Lone surrogates count as 3 bytes (they encode as U+FFFD). */
export function utf8ByteLength(s: string): number {
  let bytes = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c < 0x80) bytes += 1;
    else if (c < 0x800) bytes += 2;
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) {
        bytes += 4;
        i++;
      } else bytes += 3;
    } else bytes += 3;
  }
  return bytes;
}

// C0 controls, DEL and C1 controls.
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;
// Line and paragraph separators.
const LINE_SEPARATOR = /[\u2028\u2029]/u;
// Invisible by definition: Unicode format characters (Cf: bidi controls, zero-width space, soft
// hyphen, word joiner, BOM, tag characters, ...) and default-ignorable code points (Hangul fillers,
// combining grapheme joiner, variation selectors, unassigned ignorables, ...).
const INVISIBLE = /[\p{Cf}\p{Default_Ignorable_Code_Point}]/u;
const ZWNJ = 0x200c;
const ZWJ = 0x200d;
const VS15 = 0xfe0e;
const VS16 = 0xfe0f;
const KEYCAP = 0x20e3;
const JOINER_NEIGHBOUR = /[\p{L}\p{M}\p{Extended_Pictographic}\p{Emoji_Modifier}]/u;
const EMOJI = /\p{Emoji}/u;
const LETTER_OR_SYMBOL = /[\p{L}\p{S}]/u;

const isVariationSelector = (c: number) => (c >= 0xfe00 && c <= 0xfe0f) || (c >= 0xe0100 && c <= 0xe01ef);
const isVisible = (c: number | undefined): c is number => c !== undefined && !INVISIBLE.test(String.fromCodePoint(c)) && !CONTROL.test(String.fromCodePoint(c));
const isAsciiKeycapBase = (c: number) => (c >= 0x30 && c <= 0x39) || c === 0x23 || c === 0x2a;

/**
 * True when the path contains an invisible character outside the few contexts where text needs
 * one. ZWNJ/ZWJ (emoji sequences, Persian and Indic scripts) are allowed only between two visible
 * non-ASCII letters, marks or emoji (VS16 may precede a ZWJ, as in heart-on-fire); so
 * "index" + ZWJ + ".html" or runs of joiners are rejected. VS15/VS16 are allowed only after an
 * emoji, or in an ASCII keycap (digit, # or * + VS16 + U+20E3). Other variation selectors
 * (standardised and ideographic variants) are allowed only after a visible non-ASCII letter or
 * symbol. Everything else in INVISIBLE is rejected.
 */
function hasInvisibleCharacter(path: string): boolean {
  if (!INVISIBLE.test(path)) return false;
  const cps = Array.from(path, (ch) => ch.codePointAt(0) as number);
  for (let i = 0; i < cps.length; i++) {
    const c = cps[i] as number;
    if (!INVISIBLE.test(String.fromCodePoint(c))) continue;
    const prev = cps[i - 1];
    const next = cps[i + 1];
    if (c === ZWNJ || c === ZWJ) {
      const prevOk = prev === VS16 || (isVisible(prev) && prev > 0x7f && JOINER_NEIGHBOUR.test(String.fromCodePoint(prev)));
      const nextOk = isVisible(next) && next > 0x7f && JOINER_NEIGHBOUR.test(String.fromCodePoint(next));
      if (prevOk && nextOk) continue;
      return true;
    }
    if (isVariationSelector(c) && isVisible(prev)) {
      if (c === VS15 || c === VS16) {
        if (prev > 0x7f ? EMOJI.test(String.fromCodePoint(prev)) : isAsciiKeycapBase(prev) && c === VS16 && next === KEYCAP) continue;
      } else if (prev > 0x7f && LETTER_OR_SYMBOL.test(String.fromCodePoint(prev))) continue;
    }
    return true;
  }
  return false;
}

/**
 * Validates a relative path as stored in a manifest. Accepts only well-formed NFC strings of
 * 1 to 512 UTF-8 bytes with `/` separators, no leading or trailing `/`, no empty, `.` or `..`
 * segment, segments of at most 255 bytes, no backslash, no control or line-separator character,
 * and no invisible character outside the contexts hasInvisibleCharacter allows. The server
 * rejects non-NFC input; the CLI normalises first.
 */
export function validatePath(path: string): PathCheck {
  if (typeof path !== "string" || path.length === 0) return { ok: false, reason: "empty" };
  // Every UTF-16 code unit is at least one UTF-8 byte: reject huge inputs before scanning them.
  if (path.length > MAX_PATH_BYTES) return { ok: false, reason: "too_long" };
  if (!path.isWellFormed()) return { ok: false, reason: "ill_formed_unicode" };
  if (utf8ByteLength(path) > MAX_PATH_BYTES) return { ok: false, reason: "too_long" };
  if (path.normalize("NFC") !== path) return { ok: false, reason: "not_nfc" };
  if (CONTROL.test(path)) return { ok: false, reason: "control_character" };
  if (LINE_SEPARATOR.test(path)) return { ok: false, reason: "line_separator" };
  if (hasInvisibleCharacter(path)) return { ok: false, reason: "invisible_character" };
  if (path.includes("\\")) return { ok: false, reason: "backslash" };
  if (path.startsWith("/")) return { ok: false, reason: "leading_slash" };
  if (path.endsWith("/")) return { ok: false, reason: "trailing_slash" };
  for (const segment of path.split("/")) {
    if (segment === "") return { ok: false, reason: "empty_segment" };
    if (segment === "." || segment === "..") return { ok: false, reason: "dot_segment" };
    if (utf8ByteLength(segment) > MAX_SEGMENT_BYTES) return { ok: false, reason: "segment_too_long" };
  }
  return { ok: true };
}

// Sensitive names, matched case-insensitively.
const SENSITIVE_DIRECTORIES = new Set([".git", ".svn", ".hg", ".ssh", ".aws", ".gnupg", ".kube", ".docker"]);
const SENSITIVE_BASENAMES = new Set([
  ".env",
  ".envrc", // direnv: exported secrets
  ".dev.vars",
  ".npmrc",
  ".netrc",
  ".pypirc",
  ".htpasswd",
  ".git-credentials",
  ".pgpass",
  "_netrc", // the name curl and git read on Windows
  "id_rsa",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_ecdsa_sk", // OpenSSH FIDO keys (ssh-keygen -t ecdsa-sk / ed25519-sk)
  "id_ed25519_sk",
]);
const SENSITIVE_BASENAME_PREFIXES = [".env.", ".dev.vars."];
// Terraform also writes terraform.tfstate.backup and accepts *.tfvars.json; both carry the
// same secrets as *.tfstate and *.tfvars.
const SENSITIVE_SUFFIXES = [
  ".pem",
  ".key",
  ".p12",
  ".pfx",
  ".jks",
  ".keystore",
  ".ppk",
  ".tfstate",
  ".tfstate.backup",
  ".tfvars",
  ".tfvars.json",
];

// Editor and manual backup copies of a listed file are as sensitive as the file itself.
const BACKUP_SUFFIXES = ["~", ".bak", ".old", ".orig"];

/** The basename plus its backup-stripped forms ("id_rsa.bak" -> "id_rsa", "#.env#" -> ".env"). */
function basenameForms(base: string): string[] {
  const forms = [base];
  if (base.length > 2 && base.startsWith("#") && base.endsWith("#")) forms.push(base.slice(1, -1));
  for (const suffix of BACKUP_SUFFIXES) {
    if (base.endsWith(suffix) && base.length > suffix.length) forms.push(base.slice(0, -suffix.length));
  }
  return forms;
}

/**
 * Returns the rule a path breaks if it looks like a credential or VCS metadata, else null.
 * Name-based only: there is no content scanning.
 */
export function sensitiveRule(path: string): string | null {
  const segments = path.toLowerCase().split("/");
  for (const segment of segments.slice(0, -1)) {
    if (SENSITIVE_DIRECTORIES.has(segment)) return `directory ${segment}`;
  }
  const last = segments[segments.length - 1] ?? "";
  if (SENSITIVE_DIRECTORIES.has(last)) return `directory ${last}`;
  for (const base of basenameForms(last)) {
    if (SENSITIVE_BASENAMES.has(base)) return `file ${base}`;
    for (const prefix of SENSITIVE_BASENAME_PREFIXES) if (base.startsWith(prefix)) return `file ${prefix}*`;
    for (const suffix of SENSITIVE_SUFFIXES) if (base.endsWith(suffix)) return `extension ${suffix}`;
  }
  return null;
}

export function isSensitivePath(path: string): boolean {
  return sensitiveRule(path) !== null;
}

// Directory-walk exclusions for the CLI: .DS_Store, Thumbs.db, Windows desktop.ini, the macOS
// custom-icon file "Icon\r" (its name fails validatePath, so it would otherwise abort a publish),
// AppleDouble "._*" files and the __MACOSX folder (they carry extended attributes such as
// quarantine data and download URLs).
const OS_METADATA_BASENAMES = new Set([".ds_store", "thumbs.db", "desktop.ini", `icon${String.fromCharCode(13)}`]);
const DOTFILE_ALLOWED_SEGMENTS = new Set([".well-known"]);

export type WalkExclusion = "sensitive" | "os_metadata" | "dotfile";

/**
 * Why `publish` leaves a walked path out, or null to include it. Sensitive paths and OS
 * metadata are always excluded; dot-prefixed segments are excluded unless includeDotfiles,
 * except `.well-known`.
 */
export function walkExclusion(path: string, includeDotfiles = false): WalkExclusion | null {
  if (isSensitivePath(path)) return "sensitive";
  const segments = path.split("/");
  const base = (segments[segments.length - 1] ?? "").toLowerCase();
  if (OS_METADATA_BASENAMES.has(base) || base.startsWith("._") || segments.includes("__MACOSX")) return "os_metadata";
  if (!includeDotfiles) {
    for (const segment of segments) {
      if (segment.startsWith(".") && !DOTFILE_ALLOWED_SEGMENTS.has(segment.toLowerCase())) return "dotfile";
    }
  }
  return null;
}

export interface DuplicatePath {
  path: string;
  /** The earlier path it collides with (equal after NFC normalisation). */
  duplicateOf: string;
}

/**
 * Paths that collide with an earlier one after NFC normalisation, in input order. On the server,
 * where validatePath already requires NFC, these are exact duplicates; in the CLI walk they also
 * catch two on-disk names (NFC and NFD) that would become the same manifest path.
 */
export function findDuplicatePaths(paths: readonly string[]): DuplicatePath[] {
  const seen = new Map<string, string>();
  const duplicates: DuplicatePath[] = [];
  for (const path of paths) {
    const key = path.normalize("NFC");
    const first = seen.get(key);
    if (first === undefined) seen.set(key, path);
    else duplicates.push({ path, duplicateOf: first });
  }
  return duplicates;
}
