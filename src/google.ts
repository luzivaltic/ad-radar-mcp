/**
 * Google Ads Transparency: who runs ads for a domain, an advertiser name or an
 * advertiser id, and for how long each creative has been shown.
 *
 * Google publishes no ad text, so a row is the advertiser, the format, the
 * run length and links to the creative.
 */

export type GoogleAd = {
  id: string;
  advertiser: string;
  advertiser_id: string | null;
  domain: string | null;
  format: string | null;
  platform: string | null;
  first_shown: string | null;
  last_shown: string | null;
  days_shown: number | null;
  preview_url: string | null;
  image_url: string | null;
  ad_url: string | null;
};

function str(v: unknown): string | null {
  return typeof v === "string" && v.trim() ? v.trim() : null;
}

export function toGoogleAd(row: Record<string, unknown>): GoogleAd {
  const days = row.days_shown;
  return {
    id: String(row.creative_id ?? row.id ?? ""),
    advertiser: str(row.advertiser_name) ?? "Unknown advertiser",
    advertiser_id: str(row.advertiser_id),
    domain: str(row.domain),
    format: str(row.format),
    platform: str(row.search_platform),
    first_shown: str(row.first_shown),
    last_shown: str(row.last_shown),
    days_shown: typeof days === "number" ? days : null,
    preview_url: str(row.preview_url),
    image_url: str(row.image_url),
    ad_url: str(row.ad_url),
  };
}

export type GoogleQuery = { field: "advertiserIds" | "advertiserNames" | "domains"; value: string };

/** Routes a free-form query to the field the Transparency Center expects. */
export function classifyQuery(query: string): GoogleQuery {
  const q = query.trim();
  if (/^AR\d{10,25}$/i.test(q)) return { field: "advertiserIds", value: q.toUpperCase() };
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/.*)?$/i.test(q)) {
    const host = q.replace(/^https?:\/\//i, "").replace(/^www\./i, "").split("/")[0];
    return { field: "domains", value: host };
  }
  return { field: "advertiserNames", value: q };
}

export function renderGoogleAds(
  ads: GoogleAd[],
  opts: { heading: string; note?: string; maxDetail?: number },
): string {
  const lines: string[] = [opts.heading];
  if (opts.note) lines.push(opts.note);

  if (!ads.length) {
    lines.push("");
    lines.push(
      "No ads matched. The Transparency Center usually needs a domain (nike.com), an advertiser name as it appears there, or the region where the ads ran.",
    );
    return lines.join("\n");
  }

  const advertisers = new Map<string, number>();
  for (const ad of ads) advertisers.set(ad.advertiser, (advertisers.get(ad.advertiser) ?? 0) + 1);

  lines.push("");
  for (const ad of ads.slice(0, opts.maxDetail ?? 40)) {
    const meta = [
      `${ad.days_shown !== null ? `${ad.days_shown}d` : "unknown run"}`,
      ad.format,
      ad.platform,
      ad.domain,
    ].filter(Boolean);
    lines.push(`- ${ad.advertiser} · ${meta.join(" · ")}`);
    if (ad.first_shown) {
      lines.push(`  first shown ${ad.first_shown.slice(0, 10)}${ad.last_shown ? `, last shown ${ad.last_shown.slice(0, 10)}` : ""}`);
    }
    if (ad.ad_url) lines.push(`  ${ad.ad_url}`);
  }
  if (ads.length > (opts.maxDetail ?? 40)) {
    lines.push(`- …${ads.length - (opts.maxDetail ?? 40)} more in structured_content`);
  }
  lines.push("");
  lines.push(
    `Advertisers: ${[...advertisers.entries()]
      .slice(0, 12)
      .map(([name, count]) => `${name} (${count})`)
      .join(", ")}`,
  );
  return lines.join("\n");
}
