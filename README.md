# Ad Radar: competitor ads for AI agents

Ask your agent what any company is running on Facebook, Instagram and Google,
and get the ads themselves back: headline, body, call to action, landing page,
which platforms each ad runs on, and how many days it has been live.

Ad Radar reads the Meta Ad Library and the Google Ads Transparency Center, so
it covers every advertiser running ads there, not only the ones you already
know. One row per ad. No Facebook, Google or Apify account: the server holds
that access, and you only bring your Ad Radar key.

## Connect

The hosted server is live at **https://ad-radar.mcpize.run/mcp** (streamable
HTTP). Get a key and a free tier of 100 calls a month at
https://mcpize.com/mcp/ad-radar, then point your client at it:

```json
{
  "mcpServers": {
    "ad-radar": {
      "type": "http",
      "url": "https://ad-radar.mcpize.run/mcp",
      "headers": { "Authorization": "Bearer YOUR_AD_RADAR_KEY" }
    }
  }
}
```

This repository is the source of that server. `npm ci && npm run build && npm start`
runs the same code locally with `APIFY_TOKEN` set; the MCPize gateway is only
needed for auth and billing.

## What you can ask

| Ask | Tool |
| --- | --- |
| "Who is advertising running shoes in the US right now?" | `search_ads` |
| "Which advertisers does Google show for nike.com?" | `search_google_ads` |
| "Show me every ad Nike is running, and their landing pages." | `advertiser_ads` |
| "Tell me when this competitor launches a new ad." | `watch_advertiser` |
| "What am I already tracking?" | `list_watches` |

## Tools

### `search_ads`

Find advertisers and ads by keyword.

- `query` (required): words as typed into the Ad Library search box, up to 200 characters.
- `country`: two-letter code such as `US`, `GB`, `VN`, or `ALL`. Default `ALL`.
- `limit`: 1 to 50 ads. Default 20.
- `active_only`: `true` (default) for ads running now, `false` to include stopped ads.
- `media`: `all`, `image`, `video`, `meme` or `none`.
- `sort`: `relevance` (default) or `most_recent`.
- `since_days`: only ads first shown within this many days, 1 to 365.
- `workspace`: your project name, keeps limits and watches separate.

Returns each ad with advertiser, page id, live status, first-shown date, days
running, platforms, format, headline, copy, call to action, landing page, media
type, the ad's Ad Library link, and spend or impressions for political ads. The
response also carries how many ads the library holds for that search in total.

### `search_google_ads`

Who Google shows ads for a website, a brand or an advertiser id.

- `query` (required): a website such as `nike.com`, a brand such as `Nike`, or an advertiser id such as `AR06365026152670560257`.
- `region`: two-letter code the ads were shown in, such as `US`, `GB` or `DE`.
- `limit`: 1 to 50 ads. Default 20.
- `format`: `all`, `text`, `image` or `video`.
- `platform`: `all`, `search`, `youtube`, `shopping`, `maps` or `play`.
- `since_days`: only ads shown within this many days.
- `workspace`: your project name.

Google publishes no ad text, so each row carries the advertiser, the format,
the platform, the first and last day the creative was shown, how many days it
ran, a preview link, and the Transparency Center link.

### `advertiser_ads`

Every ad one company runs. Takes a page name (`nike`, `@nike`), a page URL, a
`profile.php?id=...` URL, or an Ad Library `view_all_page_id`. Same filters as
`search_ads`, up to 100 ads.

### `watch_advertiser`

Saves a snapshot of an advertiser's live ads. Call it again later and you get
only what changed: ads launched since the last check, ads that stopped, and ads
whose copy was rewritten. The first call creates the baseline.

Watches are stored per workspace, so a project only ever sees its own list.

### `list_watches`

The watches in a workspace, with how many ads each tracks and when it was last
checked.

## Example

```
search_ads(query: "running shoes", country: "US", limit: 5)
```

```
Meta ad search: "running shoes" · US · running now
The Ad Library reports about 50,001 matching ads · 5 shown.

- KURU Footwear · 133d · facebook/instagram/audience_network · DCO · video
  card: You saw the apocalypse. The zombies were scary. Now meet the shoes that
  make foot pain the real casualty…
  cta: Shop now → kurufootwear.com
  https://www.facebook.com/ads/library/?id=1339489931715040
- SHEIN · 122d · facebook/instagram · DPA · image
  copy: Don't miss out. Shop SHEIN and find what you really want…
  cta: Shop now → m.shein.com
```

```
advertiser_ads(advertiser: "nike", country: "US", limit: 5)
```

```
Nike: 5 live ads, longest running 514 days
```

```
watch_advertiser(advertiser: "nike", country: "US")
```

```
Baseline saved for Nike: tracking 156 live ads.
Call watch_advertiser again tomorrow to get new launches, stopped ads and
rewritten copy.
```

Every tool also returns the same data as structured JSON, so an agent can sort,
count and compare without parsing the text.

## What it costs

| | Price | Includes |
| --- | --- | --- |
| Free | $0 | 100 tool calls a month, every tool |
| Pro | $9 / month | 2,000 tool calls a month, every tool |
| Business | $29 / month | 8,000 tool calls a month, every tool |

Cached results do not count against the limit: repeating the same search within
10 minutes is free. Saved watches stay available even after a lookup limit is
reached.

## What it does not do

- It reads the Meta Ad Library and the Google Ads Transparency Center. TikTok, LinkedIn and X ads are not covered.
- Spend and impressions are filled for political and issue ads, which is what Meta publishes. Commercial ads show run length and creative instead. Google publishes no spend at all.
- Creative is returned as text, landing page and ad link. Image and video files are not downloaded.
- A watch tracks up to 100 live ads per advertiser (about 15 seconds per check).
- Countries where the Ad Library has no data return no ads, not an error.

## Notes

- Ad copy is returned exactly as the advertiser wrote it, including the
  `{{product.brand}}` placeholders that dynamic ads use. For those, the card
  text is the real message.
- Run length is computed from the ad's first-shown date, so a long-running ad is
  a real signal that the creative is still working.
- `workspace` is a name you choose. Use one per client or project; the same name
  must be passed to `watch_advertiser`, `list_watches` and the search tools for
  watches and limits to line up.

## Support

Open an issue from the server page and it is picked up the same day.
