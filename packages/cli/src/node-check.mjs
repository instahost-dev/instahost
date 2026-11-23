// Node version gate for bin/instahost.mjs. Plain JavaScript that every Node version can parse,
// typed with JSDoc, so the check runs before the compiled CLI is imported.

/** The oldest supported Node.js release: the compiled CLI needs nothing newer than Node 20. */
export const MIN_NODE = /** @type {const} */ ([20, 0]);

/**
 * True when the version string (process.versions.node) is older than MIN_NODE or not a version.
 * @param {string} version
 * @returns {boolean}
 */
export function nodeTooOld(version) {
  const match = /^(\d+)\.(\d+)\.\d+/.exec(String(version));
  if (!match) return true;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return major < MIN_NODE[0] || (major === MIN_NODE[0] && minor < MIN_NODE[1]);
}

/**
 * The single --json document printed when Node is too old (usage error, exit code 2).
 * @param {string} version
 */
export function tooOldDocument(version) {
  return {
    ok: false,
    error: {
      code: "node_too_old",
      message: `Node.js >= ${MIN_NODE[0]} is required (this is ${version}).`,
      details: { required: `>=${MIN_NODE.join(".")}.0`, found: String(version) },
      exit_code: 2,
    },
  };
}
