import type {
  GrafanaClient,
  GrafanaAnnotationPayload,
  GrafanaAnnotationResponse,
} from "./types.js";

export interface GrafanaClientOptions {
  url?: string;
  apiKey?: string;
  timeoutMs?: number;
  fetchFn?: typeof fetch;
}

/**
 * Default implementation of GrafanaClient using native fetch and AbortController.
 *
 * Implements ARCHITECTURE §11.4 & ROADMAP §5 Phase 6 PR 26:
 * - Emits annotations to Grafana POST /api/annotations.
 * - Handles timeouts gracefully via AbortController.
 */
export class DefaultGrafanaClient implements GrafanaClient {
  private readonly url: string;
  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly fetchFn: typeof fetch;

  constructor(options: GrafanaClientOptions = {}) {
    this.url = (
      options.url ??
      process.env.GRAFANA_URL ??
      "http://localhost:3000"
    ).replace(/\/$/, "");
    this.apiKey =
      options.apiKey ??
      process.env.GRAFANA_API_KEY ??
      process.env.GRAFANA_TOKEN ??
      "";
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.fetchFn = options.fetchFn ?? fetch;
  }

  async createAnnotation(
    payload: GrafanaAnnotationPayload,
  ): Promise<GrafanaAnnotationResponse> {
    if (!this.apiKey) {
      throw new Error("Grafana API key/token is not configured");
    }

    const endpoint = `${this.url}/api/annotations`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);

    try {
      const res = await this.fetchFn(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (!res.ok) {
        throw new Error(
          `Grafana API returned HTTP ${res.status}: ${res.statusText}`,
        );
      }

      return (await res.json()) as GrafanaAnnotationResponse;
    } finally {
      clearTimeout(timer);
    }
  }
}

export function createGrafanaClient(
  options: GrafanaClientOptions = {},
): GrafanaClient {
  return new DefaultGrafanaClient(options);
}
