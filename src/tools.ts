import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { ACTOR_ID, GOOGLE_ACTOR_ID, hasApifyToken, runActorSync } from "./apify.js";
import { cacheKey, TtlCache } from "./cache.js";
import { dedupe, renderAds, summarise, toAd, type Ad } from "./format.js";
import { classifyQuery, renderGoogleAds, toGoogleAd, type GoogleAd } from "./google.js";
import { scopedWorkspace, type Tenant } from "./tenant.js";
import {
  BudgetError,
  budgetSnapshot,
  diff,
  listIndex,
  loadWatch,
  nextWatch,
  reserveRun,
  saveWatch,
  slug,
} from "./state.js";

type RawRow = Record<string, unknown>;

type ToolResult = {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};

const cache = new TtlCache(Number(process.env.CACHE_TTL_SECONDS ?? "600") * 1000);

/**
 * Ads tracked per watch check. 100 keeps a check near 15 seconds, inside the
 * timeout every MCP client and proxy allows; 200 doubles both the wall time
 * and the compute for coverage a daily diff does not need.
 */
const WATCH_ADS = Number(process.env.WATCH_ADS ?? "100");

function ok(text: string, structured: Record<string, unknown>): ToolResult {
  return { content: [{ type: "text", text }], structuredContent: structured };
}

function fail(error: unknown): ToolResult {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof BudgetError) {
    return { content: [{ type: "text", text: message }], isError: true };
  }
  return {
    content: [{ type: "text", text: `Ad Radar could not finish that lookup: ${message}` }],
    isError: true,
  };
}

function yearsAgo(ad: Ad): string | null {
  return ad.started ? ad.started.slice(0, 10) : null;
}

async function fetchAds(
  input: Record<string, unknown>,
  cacheToken: Record<string, unknown>,
  workspace: string,
): Promise<{ ads: Ad[]; libraryTotal: number | null; cached: boolean }> {
  if (!hasApifyToken()) {
    throw new Error("APIFY_TOKEN is not configured on this server.");
  }
  const key = cacheKey(cacheToken);
  const hit = cache.get<{ ads: Ad[]; libraryTotal: number | null }>(key);
  if (hit) return { ...hit, cached: true };

  await reserveRun(workspace);
  const { items } = await runActorSync<RawRow>(ACTOR_ID, input, { timeoutSecs: 180 });
  const now = Date.now();
  const ads = dedupe(items.map((row) => toAd(row, now)));
  const total = items[0]?.search_total_count;
  const libraryTotal = typeof total === "number" && total > 0 ? total : null;
  const value = { ads, libraryTotal };
  cache.set(key, value);
  return { ...value, cached: false };
}

async function fetchGoogleAds(
  input: Record<string, unknown>,
  cacheToken: Record<string, unknown>,
  workspace: string,
): Promise<{ ads: GoogleAd[]; cached: boolean }> {
  if (!hasApifyToken()) {
    throw new Error("APIFY_TOKEN is not configured on this server.");
  }
  const key = cacheKey(cacheToken);
  const hit = cache.get<{ ads: GoogleAd[] }>(key);
  if (hit) return { ads: hit.ads, cached: true };

  await reserveRun(workspace);
  const { items } = await runActorSync<RawRow>(GOOGLE_ACTOR_ID, input, { timeoutSecs: 180 });
  const seen = new Set<string>();
  const ads: GoogleAd[] = [];
  for (const row of items) {
    const ad = toGoogleAd(row);
    const dedupeKey = ad.id || `${ad.advertiser}:${ad.domain ?? ""}:${ad.first_shown ?? ""}`;
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    ads.push(ad);
  }
  cache.set(key, { ads });
  return { ads, cached: false };
}

function statusNote(cached: boolean, libraryTotal: number | null, ads: Ad[]): string {
  const bits: string[] = [];
  if (libraryTotal) bits.push(`The Ad Library reports about ${libraryTotal.toLocaleString("en-US")} matching ads`);
  if (cached) bits.push("served from cache");
  bits.push(`${ads.length} shown`);
  return `${bits.join(" · ")}.`;
}

export function registerTools(server: McpServer, tenant: Tenant): void {
  server.registerTool(
    "search_ads",
    {
      title: "Search live Facebook and Instagram ads",
      description:
        "Find which advertisers are running Facebook and Instagram ads for a keyword, and read the actual ad copy, headline, call to action, landing page and how many days each ad has been live. The ad library covers every advertiser, not only ones you name. Use this for competitor research, creative inspiration, category and trend checks, and to see who is spending in a market.",
      inputSchema: {
        query: z
          .string()
          .min(2)
          .max(200)
          .describe('Words as typed into the Meta Ad Library search box, e.g. "running shoes" or "meal kit".'),
        country: z
          .string()
          .max(3)
          .optional()
          .describe('Two-letter country code such as US, GB, VN, or ALL for every country. Default ALL.'),
        limit: z
          .number()
          .int()
          .min(1)
          .max(50)
          .optional()
          .describe("Maximum ads to return, 1-50. Default 20. Each ad beyond the limit is not fetched."),
        active_only: z
          .boolean()
          .optional()
          .describe("True (default) returns ads running now; false includes ads that have stopped."),
        media: z
          .enum(["all", "image", "video", "meme", "none"])
          .optional()
          .describe("Keep only ads with this creative type. Default all."),
        sort: z
          .enum(["relevance", "most_recent"])
          .optional()
          .describe("Ad Library order. relevance (default) matches the search best; most_recent shows the newest launches first."),
        since_days: z
          .number()
          .int()
          .min(1)
          .max(365)
          .optional()
          .describe("Only ads first shown within this many days, e.g. 7 for launches in the last week."),
        workspace: z
          .string()
          .max(64)
          .optional()
          .describe("Your project name, used to keep usage limits and watches separate. Default default."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const workspace = scopedWorkspace(tenant, args.workspace);
        const country = (args.country ?? "ALL").toUpperCase();
        const limit = args.limit ?? 20;
        const activeOnly = args.active_only ?? true;
        const input: Record<string, unknown> = {
          searchQueries: [args.query],
          maxAdsPerSearch: limit,
          country,
          activeStatus: activeOnly ? "active" : "all",
          mediaType: args.media ?? "all",
          sortBy: args.sort ?? "relevance",
        };
        if (args.since_days) input.startDate = `${args.since_days} days`;

        const { ads, libraryTotal, cached } = await fetchAds(
          input,
          { kind: "search", query: args.query, country, limit, activeOnly, media: args.media ?? "all", sort: args.sort ?? "relevance", since: args.since_days ?? 0 },
          workspace,
        );

        const heading = `Meta ad search: "${args.query}" · ${country} · ${activeOnly ? "running now" : "running or stopped"}`;
        const text = renderAds(ads, { heading, note: statusNote(cached, libraryTotal, ads) });
        return ok(text, {
          query: args.query,
          country,
          active_only: activeOnly,
          cached,
          library_total_matching_ads: libraryTotal,
          returned: ads.length,
          advertisers: summarise(ads),
          ads,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "search_google_ads",
    {
      title: "Search Google ads by website, brand or advertiser id",
      description:
        "See which advertisers Google shows ads for a website or brand, and how long each creative has been running. Google publishes no ad text, so each row is the advertiser, format, platform, first and last day shown, days shown, a creative preview link and the Transparency Center link. Use it for B2B and SaaS competitor checks, and to see whether a brand buys Search, YouTube, Shopping, Maps or Play ads.",
      inputSchema: {
        query: z
          .string()
          .min(2)
          .max(200)
          .describe('A website such as nike.com, a brand name such as "Nike", or an advertiser id such as AR06365026152670560257.'),
        region: z
          .string()
          .max(2)
          .optional()
          .describe("Two-letter region the ads were shown in, such as US, GB or DE. Default any region."),
        limit: z.number().int().min(1).max(50).optional().describe("Maximum ads to return, 1-50. Default 20."),
        format: z.enum(["all", "text", "image", "video"]).optional().describe("Keep only this creative format."),
        platform: z
          .enum(["all", "search", "youtube", "shopping", "maps", "play"])
          .optional()
          .describe("Keep only ads shown on this Google platform. Default all."),
        since_days: z
          .number()
          .int()
          .min(1)
          .max(3650)
          .optional()
          .describe("Only ads shown within this many days."),
        workspace: z.string().max(64).optional().describe("Project name for limits. Default default."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const workspace = scopedWorkspace(tenant, args.workspace);
        const region = args.region && args.region.toUpperCase() !== "ANY" ? args.region.toUpperCase() : null;
        const limit = args.limit ?? 20;
        const routed = classifyQuery(args.query);

        const input: Record<string, unknown> = {
          resultType: "ads",
          maxAdsPerSearch: limit,
          [routed.field]: [routed.value],
        };
        if (region) input.region = region;
        if (args.format && args.format !== "all") input.adFormat = args.format.toUpperCase();
        if (args.platform && args.platform !== "all") input.platforms = [args.platform.toUpperCase()];
        if (args.since_days) {
          input.startDate = new Date(Date.now() - args.since_days * 86_400_000).toISOString().slice(0, 10);
        }

        const { ads, cached } = await fetchGoogleAds(
          input,
          { kind: "google", query: routed.value, field: routed.field, region: region ?? "any", limit, format: args.format ?? "all", platform: args.platform ?? "all", since: args.since_days ?? 0 },
          workspace,
        );

        const advertisers = [...new Set(ads.map((ad) => ad.advertiser))];
        const heading = `Google ads: ${routed.value} · ${region ?? "any region"}${args.format && args.format !== "all" ? ` · ${args.format}` : ""}`;
        const note = cached ? "served from cache." : `${ads.length} shown, ${advertisers.length} advertiser${advertisers.length === 1 ? "" : "s"}.`;
        return ok(renderGoogleAds(ads, { heading, note }), {
          query: routed.value,
          matched_field: routed.field,
          region,
          cached,
          returned: ads.length,
          advertisers,
          ads,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "advertiser_ads",
    {
      title: "List every ad a company runs",
      description:
        "Given a company's Facebook page name, @handle, page URL or page id, return the ads that company is running right now: copy, headline, CTA, landing page, platforms, and how long each ad has been live. Use this to audit one competitor's creative, see how long they keep winning ads running, and spot their landing pages.",
      inputSchema: {
        advertiser: z
          .string()
          .min(2)
          .max(300)
          .describe('Page name as in its link (nike or @nike), page URL, profile.php?id=..., or Ad Library view_all_page_id.'),
        country: z
          .string()
          .max(3)
          .optional()
          .describe("Two-letter country code or ALL. Default ALL."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .describe("Maximum ads to return, 1-100. Default 30."),
        active_only: z
          .boolean()
          .optional()
          .describe("True (default) returns ads running now; false includes stopped ads too."),
        sort: z
          .enum(["relevance", "most_recent"])
          .optional()
          .describe("Ad Library order. most_recent puts the newest launches first."),
        workspace: z.string().max(64).optional().describe("Project name for limits and watches. Default default."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const workspace = scopedWorkspace(tenant, args.workspace);
        const country = (args.country ?? "ALL").toUpperCase();
        const limit = args.limit ?? 30;
        const activeOnly = args.active_only ?? true;
        const input: Record<string, unknown> = {
          startUrls: [args.advertiser],
          maxAdsPerSearch: limit,
          country,
          activeStatus: activeOnly ? "active" : "all",
          sortBy: args.sort ?? "relevance",
        };
        const { ads, cached } = await fetchAds(
          input,
          { kind: "advertiser", advertiser: args.advertiser, country, limit, activeOnly, sort: args.sort ?? "relevance" },
          workspace,
        );

        const name = ads[0]?.advertiser ?? args.advertiser;
        const longest = ads.reduce<number | null>((max, ad) => (ad.days_running === null ? max : Math.max(max ?? 0, ad.days_running)), null);
        const heading = `${name}: ${ads.length} ${activeOnly ? "live" : "known"} ads${longest !== null ? `, longest running ${longest} days` : ""}`;
        const note = cached ? "served from cache." : "";
        const text = renderAds(ads, { heading, note });
        return ok(text, {
          advertiser: name,
          country,
          active_only: activeOnly,
          cached,
          returned: ads.length,
          longest_running_days: longest,
          ads,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "watch_advertiser",
    {
      title: "Watch a competitor for new and stopped ads",
      description:
        "Save a snapshot of the newest 100 ads a company is running, then call it again later to get a diff: which ads launched since the last check, which stopped, and which changed their copy. This is how you track a competitor over time without re-reading their whole library. The first call only creates the baseline.",
      inputSchema: {
        advertiser: z
          .string()
          .min(2)
          .max(300)
          .describe("Page name, @handle, page URL or page id to watch."),
        workspace: z
          .string()
          .max(64)
          .optional()
          .describe("Project name; watches with the same name are grouped and private to it. Default default."),
        country: z
          .string()
          .max(3)
          .optional()
          .describe("Two-letter country code or ALL. Default ALL."),
      },
      annotations: { readOnlyHint: false, openWorldHint: true, destructiveHint: false },
    },
    async (args) => {
      try {
        const shown = (args.workspace ?? "default").trim() || "default";
        const workspace = scopedWorkspace(tenant, args.workspace);
        const country = (args.country ?? "ALL").toUpperCase();
        const slugName = slug(args.advertiser);
        const previous = await loadWatch(workspace, slugName);

        const { ads } = await fetchAds(
          { startUrls: [args.advertiser], maxAdsPerSearch: WATCH_ADS, country, activeStatus: "active" },
          { kind: "watch", advertiser: args.advertiser, country },
          workspace,
        );

        const changes = diff(previous, ads);
        const watch = nextWatch(previous, ads, { advertiser: ads[0]?.advertiser ?? args.advertiser, workspace, country });
        await saveWatch(watch, slugName);

        const name = watch.advertiser;
        let text: string;
        if (!previous) {
          text = [
            `Baseline saved for ${name}: tracking ${ads.length} live ads.`,
            "",
            "Call watch_advertiser again tomorrow (or any time later) to get new launches, stopped ads and rewritten copy.",
            "",
            renderAds(ads.slice(0, 10), { heading: "Longest-running ads in the baseline", maxDetail: 10 }),
          ].join("\n");
        } else {
          const since = previous.checked_at.slice(0, 16).replace("T", " ") + " UTC";
          text = [
            `${name}: ${changes.new_ads.length} new, ${changes.stopped_ads.length} stopped, ${changes.refreshed_ads.length} refreshed since ${since}. ${ads.length} live ads tracked.`,
          ].join("\n");
          if (changes.new_ads.length) {
            text += `\n\n${renderAds(changes.new_ads.slice(0, 10), { heading: `New since ${since}`, maxDetail: 10 })}`;
          }
          if (changes.stopped_ads.length) {
            const lines = changes.stopped_ads.slice(0, 10).map((ad) => `- ${ad.headline ?? ad.copy?.slice(0, 80) ?? ad.id} (${ad.url})`);
            text += `\n\nStopped since ${since}:\n${lines.join("\n")}`;
          }
          if (changes.refreshed_ads.length) {
            text += `\n\nRewritten copy on ${changes.refreshed_ads.length} ad(s): ${changes.refreshed_ads
              .slice(0, 5)
              .map((ad) => ad.headline ?? ad.id)
              .join(", ")}`;
          }
          if (!changes.new_ads.length && !changes.stopped_ads.length && !changes.refreshed_ads.length) {
            text += "\n\nNo changes: the same ads are still running with the same copy.";
          }
        }

        return ok(text, {
          advertiser: name,
          workspace: shown,
          baseline: !previous,
          checked_at: watch.checked_at,
          previous_check: previous?.checked_at ?? null,
          live_ads: ads.length,
          new_ads: changes.new_ads,
          stopped_ads: changes.stopped_ads,
          refreshed_ads: changes.refreshed_ads,
          budget: budgetSnapshot(workspace),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  server.registerTool(
    "list_watches",
    {
      title: "List watched competitors",
      description:
        "List the advertisers saved in a workspace with how many ads each has tracked and when it was last checked. Use it to decide which watch to refresh, or to remind the user what is being monitored.",
      inputSchema: {
        workspace: z.string().max(64).optional().describe("Project name. Default default."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (args) => {
      try {
        const shown = (args.workspace ?? "default").trim() || "default";
        const workspace = scopedWorkspace(tenant, args.workspace);
        const entries = await listIndex(workspace);
        if (!entries.length) {
          return ok(
            `No watches in workspace "${shown}" yet. Call watch_advertiser with a company page to create the first one.`,
            { workspace: shown, watches: [] },
          );
        }
        const lines = entries.map(
          (e) => `- ${e.advertiser}: ${e.tracked_ads} ads tracked, last checked ${e.checked_at.slice(0, 16).replace("T", " ")} UTC`,
        );
        return ok(`Watches in "${shown}":\n${lines.join("\n")}`, {
          workspace: shown,
          watches: entries,
          budget: budgetSnapshot(workspace),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
