/**
 * Turns raw Ad Library rows (80+ fields, CDN URLs, base64 image blobs) into a
 * compact ad an agent can reason about: who runs it, what it says, where it
 * points, how long it has been live.
 */

export type Ad = {
  id: string;
  advertiser: string;
  page_id: string | null;
  active: boolean;
  started: string | null;
  days_running: number | null;
  platforms: string[];
  format: string | null;
  media: string;
  headline: string | null;
  copy: string | null;
  cta: string | null;
  landing_page: string | null;
  cards: { headline: string | null; copy: string | null; link: string | null }[];
  spend: string | null;
  impressions: string | null;
  reach: string | null;
  paid_for_by: string | null;
  url: string | null;
};

const DAY = 86_400_000;

function str(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const t = v.trim();
  return t ? t : null;
}

/** DCO ads carry "{{product.brand}}" style placeholders instead of copy. */
function realCopy(v: unknown): string | null {
  const t = str(v);
  if (!t) return null;
  if (/^\{\{[^}]*\}\}$/.test(t)) return null;
  return t;
}

function days(from: string | null, to: string | null, now: number): number | null {
  if (!from) return null;
  const start = Date.parse(from);
  if (Number.isNaN(start)) return null;
  const end = to ? Date.parse(to) : now;
  if (Number.isNaN(end)) return null;
  return Math.max(0, Math.round((end - start) / DAY));
}

function mediaKind(row: Record<string, unknown>): string {
  const videos = Array.isArray(row.videos) ? row.videos.length : 0;
  const images = Array.isArray(row.images) ? row.images.length : 0;
  const cards = Array.isArray(row.cards) ? (row.cards as Record<string, unknown>[]) : [];
  const cardVideos = cards.some((c) => typeof c.video_hd_url === "string");
  const cardImages = cards.some(
    (c) => typeof c.original_image_url === "string" || typeof c.resized_image_url === "string",
  );
  if (videos || cardVideos) return "video";
  if (images || cardImages) return "image";
  if (cards.length) return "card";
  return "text";
}

export function toAd(row: Record<string, unknown>, now = Date.now()): Ad {
  const cards = Array.isArray(row.cards) ? (row.cards as Record<string, unknown>[]) : [];
  const started = str(row.start_date);
  const ended = str(row.end_date);
  const active = row.is_active !== false;
  return {
    id: String(row.ad_archive_id ?? row.ad_id ?? ""),
    advertiser: str(row.page_name) ?? "Unknown advertiser",
    page_id: str(row.page_id),
    active,
    started,
    days_running: days(started, active ? null : ended, now),
    platforms: (Array.isArray(row.publisher_platforms) ? row.publisher_platforms : [])
      .map((p) => String(p).toLowerCase())
      .filter(Boolean),
    format: str(row.display_format),
    media: mediaKind(row),
    headline: realCopy(row.title),
    copy: realCopy(row.body_text),
    cta: str(row.cta_text),
    landing_page: str(row.link_url),
    cards: cards.slice(0, 3).map((c) => ({
      headline: realCopy(c.title),
      copy: realCopy(c.body),
      link: str(c.link_url),
    })),
    spend: str(row.spend),
    impressions: str(row.impressions_text),
    reach: str(row.reach_estimate),
    paid_for_by: str(row.paid_for_by),
    url: str(row.ad_library_url),
  };
}

export function dedupe(ads: Ad[]): Ad[] {
  const seen = new Set<string>();
  const out: Ad[] = [];
  for (const ad of ads) {
    const key = ad.id || `${ad.advertiser}:${ad.copy ?? ""}:${ad.landing_page ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ad);
  }
  return out;
}

export type AdvertiserSummary = {
  name: string;
  page_id: string | null;
  ads: number;
  longest_running_days: number | null;
  active_ads: number;
};

export function summarise(ads: Ad[]): AdvertiserSummary[] {
  const map = new Map<string, AdvertiserSummary>();
  for (const ad of ads) {
    const key = ad.page_id ?? ad.advertiser;
    const entry = map.get(key) ?? {
      name: ad.advertiser,
      page_id: ad.page_id,
      ads: 0,
      longest_running_days: null,
      active_ads: 0,
    };
    entry.ads += 1;
    if (ad.active) entry.active_ads += 1;
    if (ad.days_running !== null) {
      entry.longest_running_days = Math.max(entry.longest_running_days ?? 0, ad.days_running);
    }
    map.set(key, entry);
  }
  return [...map.values()].sort((a, b) => b.ads - a.ads);
}

function shorten(v: string | null, max: number): string | null {
  if (!v) return null;
  const oneLine = v.replace(/\s+/g, " ").trim();
  if (oneLine.length <= max) return oneLine;
  return `${oneLine.slice(0, max - 1).trimEnd()}…`;
}

function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}

/** Compact, token-frugal rendering for the text content block. */
export function renderAds(ads: Ad[], opts: { heading: string; note?: string; maxDetail?: number }): string {
  const advertisers = summarise(ads);
  const lines: string[] = [];
  lines.push(opts.heading);
  if (opts.note) lines.push(opts.note);
  lines.push("");

  if (!ads.length) {
    lines.push("No ads matched. Try a broader keyword, activeStatus=all, or a different country.");
    return lines.join("\n");
  }

  const maxDetail = opts.maxDetail ?? 40;
  for (const ad of ads.slice(0, maxDetail)) {
    const parts = [
      `${ad.active ? "" : "[stopped] "}${ad.advertiser}`,
      ad.days_running !== null ? `${ad.days_running}d` : null,
      ad.platforms.length ? ad.platforms.join("/") : null,
      ad.format,
      ad.media,
    ].filter(Boolean);
    lines.push(`- ${parts.join(" · ")}`);
    if (ad.headline) lines.push(`  headline: ${shorten(ad.headline, 100)}`);
    const copy = shorten(ad.copy, 160);
    if (copy) lines.push(`  copy: ${copy}`);
    if (!copy && ad.cards.length) {
      const card = shorten(ad.cards[0].copy ?? ad.cards[0].headline, 160);
      if (card) lines.push(`  card: ${card}`);
    }
    const dest = hostOf(ad.landing_page);
    if (ad.cta || dest) lines.push(`  cta: ${[ad.cta, dest].filter(Boolean).join(" → ")}`);
    if (ad.spend) lines.push(`  spend: ${ad.spend}`);
    if (ad.impressions) lines.push(`  impressions: ${ad.impressions}`);
    if (ad.url) lines.push(`  ${ad.url}`);
  }
  if (ads.length > maxDetail) {
    lines.push(`- …${ads.length - maxDetail} more in structured_content`);
  }
  lines.push("");
  lines.push(
    `Advertisers: ${advertisers
      .slice(0, 12)
      .map((a) => `${a.name} (${a.ads})`)
      .join(", ")}${advertisers.length > 12 ? `, +${advertisers.length - 12} more` : ""}`,
  );
  return lines.join("\n");
}
