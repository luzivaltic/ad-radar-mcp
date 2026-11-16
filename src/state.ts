/**
 * Watch state and run budget.
 *
 * State lives in a named Apify key-value store so any instance can serve any
 * request: snapshots survive restarts and scale-outs. Watches are scoped by a
 * workspace name the caller picks, so one subscriber's competitors never mix
 * with another's.
 */

import { createHash } from "node:crypto";
import { getRecord, putRecord } from "./apify.js";
import type { Ad } from "./format.js";

export type StoredAd = {
  first_seen: string;
  last_seen: string;
  started: string | null;
  headline: string | null;
  copy: string | null;
  hash: string;
};

export type Watch = {
  advertiser: string;
  page_id: string | null;
  workspace: string;
  country: string;
  created_at: string;
  checked_at: string;
  ads: Record<string, StoredAd>;
};

export type WatchIndexEntry = {
  slug: string;
  advertiser: string;
  checked_at: string;
  tracked_ads: number;
};

export type WatchDiff = {
  new_ads: Ad[];
  stopped_ads: Ad[];
  refreshed_ads: Ad[];
  unchanged: number;
};

export function slug(input: string): string {
  return (
    input
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "")
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "advertiser"
  );
}

function adHash(ad: Ad): string {
  return createHash("sha1")
    .update([ad.headline ?? "", ad.copy ?? "", ad.landing_page ?? "", ad.cards[0]?.copy ?? ""].join("\u0000"))
    .digest("hex")
    .slice(0, 16);
}

// Apify record keys allow only a-zA-Z0-9!-_.'() — no slashes.
function watchKey(workspace: string, slugName: string): string {
  return `watch.${slug(workspace)}.${slugName}`;
}

function indexKey(workspace: string): string {
  return `watch-index.${slug(workspace)}`;
}

export async function loadWatch(workspace: string, slugName: string): Promise<Watch | null> {
  return getRecord<Watch>(watchKey(workspace, slugName));
}

export function diff(previous: Watch | null, current: Ad[], now = new Date()): WatchDiff {
  const nowIso = now.toISOString();
  const currentById = new Map(current.map((ad) => [ad.id, ad]));
  const seen = new Set<string>();
  const newAds: Ad[] = [];
  const refreshed: Ad[] = [];

  for (const ad of current) {
    seen.add(ad.id);
    const before = previous?.ads[ad.id];
    if (!before) {
      newAds.push(ad);
    } else if (before.hash !== adHash(ad)) {
      refreshed.push(ad);
    }
  }

  const stopped: Ad[] = [];
  if (previous) {
    for (const [id, stored] of Object.entries(previous.ads)) {
      if (seen.has(id)) continue;
      if (!stored.last_seen) continue;
      stopped.push({
        id,
        advertiser: previous.advertiser,
        page_id: previous.page_id,
        active: false,
        started: stored.started,
        days_running: null,
        platforms: [],
        format: null,
        media: "text",
        headline: stored.headline,
        copy: stored.copy,
        cta: null,
        landing_page: null,
        cards: [],
        spend: null,
        impressions: null,
        reach: null,
        paid_for_by: null,
        url: `https://www.facebook.com/ads/library/?id=${id}`,
      } satisfies Ad);
    }
    // A watch only reports the stop once: the new snapshot no longer has it.
  }

  const unchanged =
    current.length - newAds.length - refreshed.length + (previous ? 0 : 0);

  void nowIso;
  return {
    new_ads: newAds,
    stopped_ads: stopped,
    refreshed_ads: refreshed,
    unchanged: Math.max(0, unchanged),
  };
}

export function nextWatch(previous: Watch | null, ads: Ad[], meta: { advertiser: string; workspace: string; country: string }): Watch {
  const now = new Date().toISOString();
  const stored: Record<string, StoredAd> = {};
  for (const ad of ads) {
    const before = previous?.ads[ad.id];
    stored[ad.id] = {
      first_seen: before?.first_seen ?? now,
      last_seen: now,
      started: ad.started,
      headline: ad.headline,
      copy: ad.copy,
      hash: adHash(ad),
    };
  }
  return {
    advertiser: meta.advertiser,
    page_id: ads.find((a) => a.page_id)?.page_id ?? previous?.page_id ?? null,
    workspace: meta.workspace,
    country: meta.country,
    created_at: previous?.created_at ?? now,
    checked_at: now,
    ads: stored,
  };
}

export async function saveWatch(watch: Watch, slugName: string): Promise<void> {
  await putRecord(watchKey(watch.workspace, slugName), watch);
  const index = (await getRecord<WatchIndexEntry[]>(indexKey(watch.workspace))) ?? [];
  const entry: WatchIndexEntry = {
    slug: slugName,
    advertiser: watch.advertiser,
    checked_at: watch.checked_at,
    tracked_ads: Object.keys(watch.ads).length,
  };
  const next = [entry, ...index.filter((i) => i.slug !== slugName)].slice(0, 200);
  await putRecord(indexKey(watch.workspace), next);
}

export async function listIndex(workspace: string): Promise<WatchIndexEntry[]> {
  return (await getRecord<WatchIndexEntry[]>(indexKey(workspace))) ?? [];
}

/* ------------------------------------------------------------------ budget */

const DAILY_RUN_CAP = Number(process.env.DAILY_RUN_CAP ?? "400");
const WORKSPACE_DAILY_CAP = Number(process.env.WORKSPACE_DAILY_CAP ?? "40");

const counters = new Map<string, number>();
let counterDay = new Date().toISOString().slice(0, 10);
let globalLoaded = false;

function rollDay(): void {
  const today = new Date().toISOString().slice(0, 10);
  if (today !== counterDay) {
    counterDay = today;
    counters.clear();
    globalLoaded = false;
  }
}

async function ensureLoaded(): Promise<void> {
  rollDay();
  if (globalLoaded) return;
  globalLoaded = true;
  try {
    const stored = await getRecord<{ runs: number }>(`budget.${counterDay}`);
    counters.set("__global__", stored?.runs ?? 0);
  } catch {
    counters.set("__global__", counters.get("__global__") ?? 0);
  }
}

export class BudgetError extends Error {}

/**
 * Reserves one Actor run. Throws BudgetError when the workspace or the whole
 * server is over its daily allowance.
 */
export async function reserveRun(workspace: string): Promise<void> {
  await ensureLoaded();
  const wsKey = `ws:${slug(workspace)}`;
  const global = counters.get("__global__") ?? 0;
  const ws = counters.get(wsKey) ?? 0;

  if (global >= DAILY_RUN_CAP) {
    throw new BudgetError(
      "The server has hit its daily scraping capacity. Try again tomorrow, or reduce the number of searches.",
    );
  }
  if (ws >= WORKSPACE_DAILY_CAP) {
    throw new BudgetError(
      `This workspace has used its ${WORKSPACE_DAILY_CAP} live lookups for today. Cached results and saved watches still work; new lookups reset tomorrow.`,
    );
  }

  counters.set("__global__", global + 1);
  counters.set(wsKey, ws + 1);
  void putRecord(`budget.${counterDay}`, { runs: global + 1 }).catch(() => undefined);
}

export function budgetSnapshot(workspace: string): { used: number; limit: number; global_used: number; global_limit: number } {
  rollDay();
  return {
    used: counters.get(`ws:${slug(workspace)}`) ?? 0,
    limit: WORKSPACE_DAILY_CAP,
    global_used: counters.get("__global__") ?? 0,
    global_limit: DAILY_RUN_CAP,
  };
}
