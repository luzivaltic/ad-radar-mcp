/**
 * Thin Apify client: run an Actor synchronously, and read/write a named
 * key-value store that holds watch state and budget counters.
 *
 * The token is the publisher's (MCPize secret APIFY_TOKEN). Subscribers never
 * need an Apify account.
 */

const API = "https://api.apify.com/v2";
const TOKEN = process.env.APIFY_TOKEN ?? "";
const STORE_NAME = process.env.STATE_STORE_NAME ?? "ad-radar-state";

export const ACTOR_ID = process.env.AD_RADAR_ACTOR_ID ?? "yN20Vn1OunHiR4Wgj";
export const GOOGLE_ACTOR_ID = process.env.GOOGLE_ADS_ACTOR_ID ?? "BuX7lGJefISfL360b";

export function hasApifyToken(): boolean {
  return TOKEN.length > 0;
}

function authUrl(path: string, params: Record<string, string> = {}): string {
  const url = new URL(API + path);
  url.searchParams.set("token", TOKEN);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return url.toString();
}

async function checked(res: Response, label: string): Promise<Response> {
  if (res.ok) return res;
  const body = await res.text().catch(() => "");
  throw new Error(`${label} failed (${res.status}): ${body.slice(0, 400)}`);
}

export type RunOptions = {
  timeoutSecs?: number;
  memoryMbytes?: number;
};

/**
 * Runs the Actor and returns its dataset items in one request.
 * Apify caps this endpoint at 300 s; we stay well below that.
 */
export async function runActorSync<T = unknown>(
  actorId: string,
  input: Record<string, unknown>,
  opts: RunOptions = {},
): Promise<{ items: T[]; runId: string | null; costUsd: number | null }> {
  if (!TOKEN) throw new Error("APIFY_TOKEN is not configured on the server.");
  const timeoutSecs = Math.min(opts.timeoutSecs ?? 120, 300);
  const url = authUrl(`/acts/${actorId}/run-sync-get-dataset-items`, {
    timeout: String(timeoutSecs),
    memory: String(opts.memoryMbytes ?? 1024),
    format: "json",
    clean: "true",
  });
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(timeoutSecs * 1000 + 20_000),
  });
  await checked(res, "Actor run");
  const raw = await res.text();
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`Actor returned non-JSON output: ${raw.slice(0, 300)}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Actor returned an unexpected payload: ${raw.slice(0, 300)}`);
  }
  return {
    items: parsed as T[],
    runId: res.headers.get("x-apify-run-id"),
    costUsd: Number(res.headers.get("x-apify-run-usage-total-usd") ?? "") || null,
  };
}

let storeIdPromise: Promise<string> | null = null;

/** Finds the named state store, creating it on first use. */
export function stateStoreId(): Promise<string> {
  if (!storeIdPromise) storeIdPromise = resolveStore();
  return storeIdPromise;
}

async function resolveStore(): Promise<string> {
  const res = await fetch(
    authUrl("/key-value-stores", { unnamed: "false", limit: "1000" }),
  );
  await checked(res, "Store lookup");
  const body = (await res.json()) as { data?: { items?: { id: string; name?: string }[] } };
  const found = body.data?.items?.find((s) => s.name === STORE_NAME);
  if (found) return found.id;

  const create = await fetch(authUrl("/key-value-stores"), {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: STORE_NAME }),
  });
  await checked(create, "Store creation");
  const created = (await create.json()) as { data?: { id?: string } };
  const id = created.data?.id;
  if (!id) throw new Error("Apify did not return a store id.");
  return id;
}

export async function getRecord<T>(key: string): Promise<T | null> {
  const id = await stateStoreId();
  const res = await fetch(
    authUrl(`/key-value-stores/${id}/records/${encodeURIComponent(key)}`),
  );
  if (res.status === 404) return null;
  await checked(res, `Read ${key}`);
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

export async function putRecord(key: string, value: unknown): Promise<void> {
  const id = await stateStoreId();
  const res = await fetch(
    authUrl(`/key-value-stores/${id}/records/${encodeURIComponent(key)}`),
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(value),
    },
  );
  await checked(res, `Write ${key}`);
}
