// The package's import surface, used by the InstaHost service's own tests and scripts. It is not
// a supported SDK: anything here may change in any release. Run the CLI through its bin instead.
export { main, HELP, OPTIONS } from "./main.ts";
export { EXIT, exitCodeForApiError } from "./errors.ts";
export { VERSION, DEFAULT_API_URL } from "./config.ts";
export { redact } from "./redact.ts";
