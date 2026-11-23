import type { ApiClient } from "../api-client.ts";

export interface CommandContext {
  client: ApiClient;
  /** API key (flag or INSTAHOST_API_KEY), sent only to the API origin. */
  apiKey: string | null;
  onProgress?: (done: number, total: number) => void;
  /** Injected in tests for the presigned PUTs. */
  fetch?: typeof fetch;
}
