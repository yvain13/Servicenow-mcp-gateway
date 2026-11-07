import { authHeader } from "./servicenow.js";
import type { SNCredentials } from "./servicenow.js";

export class SNError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    message: string
  ) {
    super(message);
  }
}

export interface RequestOptions {
  query?: Record<string, string | number | boolean | undefined>;
  body?: unknown;
}

// Thin ServiceNow REST client used by code-backed handlers. Credentials are read through a
// getter on every request so updates from the management UI apply to running servers.
export class SNClient {
  constructor(private readonly getCreds: () => SNCredentials) {}

  get instanceUrl(): string {
    return this.getCreds().instanceUrl.replace(/\/$/, "");
  }

  async request<T = any>(method: string, path: string, opts: RequestOptions = {}): Promise<T> {
    const creds = this.getCreds();
    if (!creds.instanceUrl) throw new SNError(0, null, "No ServiceNow instance configured");
    let url = creds.instanceUrl.replace(/\/$/, "") + path;
    if (opts.query) {
      const qs = new URLSearchParams();
      for (const [k, v] of Object.entries(opts.query)) {
        if (v !== undefined) qs.set(k, String(v));
      }
      const s = qs.toString();
      if (s) url += (url.includes("?") ? "&" : "?") + s;
    }
    const headers: Record<string, string> = {
      Authorization: authHeader(creds),
      Accept: "application/json",
    };
    let body: string | undefined;
    if (opts.body !== undefined) {
      body = JSON.stringify(opts.body);
      headers["Content-Type"] = "application/json";
    }
    const res = await fetch(url, { method, headers, body, signal: AbortSignal.timeout(30_000) });
    const text = await res.text();
    let data: unknown = text;
    try {
      data = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!res.ok) {
      const msg =
        (data as any)?.error?.message ??
        (data as any)?.error?.detail ??
        (typeof data === "string" ? data.slice(0, 300) : JSON.stringify(data));
      throw new SNError(res.status, data, `ServiceNow returned ${res.status}: ${msg}`);
    }
    return data as T;
  }

  // Table API helpers. Return `result` unwrapped.
  async list(
    table: string,
    query: string,
    opts: { fields?: string[]; limit?: number; displayValue?: boolean | "all" } = {}
  ): Promise<any[]> {
    const data = await this.request("GET", `/api/now/table/${table}`, {
      query: {
        sysparm_query: query,
        sysparm_fields: opts.fields?.join(","),
        sysparm_limit: opts.limit ?? 100,
        sysparm_display_value: opts.displayValue === undefined ? undefined : String(opts.displayValue),
        sysparm_exclude_reference_link: true,
      },
    });
    return (data?.result ?? []) as any[];
  }

  async get(
    table: string,
    sysId: string,
    opts: { fields?: string[]; displayValue?: boolean | "all" } = {}
  ): Promise<any | null> {
    try {
      const data = await this.request("GET", `/api/now/table/${table}/${encodeURIComponent(sysId)}`, {
        query: {
          sysparm_fields: opts.fields?.join(","),
          sysparm_display_value: opts.displayValue === undefined ? undefined : String(opts.displayValue),
          sysparm_exclude_reference_link: true,
        },
      });
      return data?.result ?? null;
    } catch (err) {
      if (err instanceof SNError && err.status === 404) return null;
      throw err;
    }
  }

  async patch(table: string, sysId: string, body: Record<string, unknown>): Promise<any> {
    const data = await this.request("PATCH", `/api/now/table/${table}/${encodeURIComponent(sysId)}`, {
      body,
      query: { sysparm_exclude_reference_link: true },
    });
    return data?.result;
  }
}
