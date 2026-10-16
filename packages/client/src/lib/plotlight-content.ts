// ──────────────────────────────────────────────
// PlotLight public content API (Card Browser source)
// https://plotlightstudios.com/docs/api/public-content
// ──────────────────────────────────────────────
//
// The API is guest, read-only and CORS-enabled, so the browser calls it
// directly with credentials omitted. Everything it returns is untrusted:
// items are reduced to plain strings, links must stay on PlotLight, and
// preview images must be https.

import { readCharacterCardData } from "./character-import";
import { parsePngCharacterCard } from "./png-parser";

export const PLOTLIGHT_ORIGIN = "https://plotlightstudios.com";
export const PLOTLIGHT_PAGE_SIZE = 48;

export type PlotLightContentType = "cards" | "personas";
export type PlotLightSort = "recent" | "popular" | "rating";
export type PlotLightFormat = "png3" | "png" | "json3" | "json";

const FORMATS: readonly PlotLightFormat[] = ["png3", "png", "json3", "json"];
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const MAX_QUERY_LENGTH = 200;
const MAX_TAG_FILTERS = 10;
const MAX_TAG_LENGTH = 50;
const MAX_OFFSET = 10_000;
// Discovery can drop items after fetching a page, so an empty page isn't the end.
const MAX_EMPTY_PAGE_SKIPS = 2;
const TAG_PAGE_SIZE = 100;
// The tag catalog is about 12 pages; a few at a time keeps the first search quick.
const TAG_PAGES_AT_ONCE = 4;
const DEFAULT_RETRY_AFTER_SECONDS = 30;
const MAX_RETRY_AFTER_SECONDS = 600;
const SEARCH_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 60_000;

export interface PlotLightItem {
  id: string;
  name: string;
  description: string;
  imageUrl: string;
  creator: string;
  tags: Array<{ name: string; slug: string }>;
  detailUrl: string;
  downloads: Partial<Record<PlotLightFormat, string>>;
  /** Carries a tag PlotLight labels as adult ("After Dark"). Set by `searchPage`. */
  adult: boolean;
}

export interface PlotLightSearch {
  type: PlotLightContentType;
  query: string;
  sort: PlotLightSort;
  /** Tag names (or slugs), sent as the slugs PlotLight's tag catalog lists for them. */
  includeTags: string[];
  excludeTags: string[];
}

/** A PlotLight response that wasn't usable. `retryAfterSeconds` is set for rate limits. */
export class PlotLightError extends Error {
  constructor(
    readonly status: number,
    readonly retryAfterSeconds: number | null = null,
  ) {
    super(`PlotLight request failed (${status})`);
    this.name = "PlotLightError";
  }
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Resolves a PlotLight link, keeping it only when it stays on PlotLight. */
function plotLightUrl(value: unknown, base: URL): string {
  const raw = text(value);
  if (!raw) return "";
  try {
    const url = new URL(raw, base);
    return url.origin === base.origin ? url.href : "";
  } catch {
    return "";
  }
}

function httpsUrl(value: unknown): string {
  try {
    const url = new URL(text(value));
    return url.protocol === "https:" ? url.href : "";
  } catch {
    return "";
  }
}

export function mapPlotLightItem(raw: unknown, base: URL): PlotLightItem | null {
  const item = record(raw);
  const id = text(item.id);
  const name = text(item.name);
  if (!UUID_PATTERN.test(id) || !name) return null;
  const creator = record(item.creator);
  const links = record(item.downloads);
  const downloads: PlotLightItem["downloads"] = {};
  for (const format of FORMATS) {
    const url = plotLightUrl(links[format], base);
    if (url) downloads[format] = url;
  }
  return {
    id,
    name,
    description: text(item.description),
    imageUrl: httpsUrl(item.image_url),
    creator: text(creator.name) || text(creator.username),
    tags: (Array.isArray(item.tags) ? item.tags : []).flatMap((tag) => {
      const name = text(record(tag).name);
      const slug = text(record(tag).slug);
      return name && slug ? [{ name, slug }] : [];
    }),
    detailUrl: plotLightUrl(item.detail_url, base) || base.origin,
    downloads,
    adult: false,
  };
}

/** `pagination.next_offset` when it moves forward and stays in range; null ends paging. */
function nextOffsetOf(body: Record<string, unknown>, offset: number): number | null {
  const next = record(body.pagination).next_offset;
  return Number.isInteger(next) && (next as number) > offset && (next as number) <= MAX_OFFSET
    ? (next as number)
    : null;
}

interface TagCatalog {
  /** Lowercased tag name or slug → PlotLight slugs. A few names belong to two slugs. */
  slugs: Map<string, string[]>;
  /** Slugs PlotLight labels as adult ("After Dark"). */
  adult: Set<string>;
}

function retryAfterSeconds(response: Response, nowMs: number): number {
  const header = response.headers.get("Retry-After")?.trim() ?? "";
  const seconds = /^\d+$/u.test(header) ? Number(header) : Math.ceil((Date.parse(header) - nowMs) / 1000);
  return Number.isFinite(seconds) && seconds > 0
    ? Math.min(seconds, MAX_RETRY_AFTER_SECONDS)
    : DEFAULT_RETRY_AFTER_SECONDS;
}

export interface PlotLightClientOptions {
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

export function createPlotLightClient(options: PlotLightClientOptions = {}) {
  const base = new URL(options.baseUrl ?? PLOTLIGHT_ORIGIN);
  const fetchImpl = options.fetchImpl ?? ((input: RequestInfo | URL, init?: RequestInit) => fetch(input, init));
  const now = options.now ?? Date.now;
  const tagCatalogs = new Map<PlotLightContentType, Promise<TagCatalog>>();
  const pageOffsets = new Map<number, number>();
  let cursorKey = "";
  // PlotLight limits searching and exporting separately.
  const blockedUntil = { search: 0, export: 0 };

  async function request(
    url: URL,
    accept: string,
    timeoutMs: number,
    limit: keyof typeof blockedUntil,
  ): Promise<Response> {
    const waitMs = blockedUntil[limit] - now();
    if (waitMs > 0) throw new PlotLightError(429, Math.ceil(waitMs / 1000));
    const response = await fetchImpl(url, {
      credentials: "omit",
      headers: { Accept: accept },
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (response.status === 429) {
      const seconds = retryAfterSeconds(response, now());
      blockedUntil[limit] = now() + seconds * 1000;
      throw new PlotLightError(429, seconds);
    }
    // An exhausted allowance waits for its reset instead of spending a request on a 429.
    const reset = Number(response.headers.get("X-RateLimit-Reset"));
    if (response.headers.get("X-RateLimit-Remaining")?.trim() === "0" && reset > 0) {
      blockedUntil[limit] = Math.min(reset * 1000, now() + MAX_RETRY_AFTER_SECONDS * 1000);
    }
    if (!response.ok) throw new PlotLightError(response.status);
    return response;
  }

  async function searchJson(url: URL): Promise<Record<string, unknown>> {
    return record(await (await request(url, "application/json", SEARCH_TIMEOUT_MS, "search")).json());
  }

  async function loadTagCatalog(type: PlotLightContentType): Promise<TagCatalog> {
    const catalog: TagCatalog = { slugs: new Map(), adult: new Set() };
    for (let start = 0, more = true; more && start <= MAX_OFFSET; start += TAG_PAGE_SIZE * TAG_PAGES_AT_ONCE) {
      const offsets = Array.from({ length: TAG_PAGES_AT_ONCE }, (_, i) => start + i * TAG_PAGE_SIZE).filter(
        (offset) => offset <= MAX_OFFSET,
      );
      const pages = await Promise.all(
        offsets.map((offset) => {
          const url = new URL("/api/v1/content/tags", base);
          url.searchParams.set("type", type);
          // Lists adult tag labels too, so adult-tagged results can be marked. It grants no access.
          url.searchParams.set("include_after_dark", "true");
          url.searchParams.set("limit", String(TAG_PAGE_SIZE));
          url.searchParams.set("offset", String(offset));
          return searchJson(url);
        }),
      );
      for (const body of pages) {
        for (const raw of Array.isArray(body.data) ? body.data : []) {
          const tag = record(raw);
          const slug = text(tag.slug);
          if (!slug || slug.length > MAX_TAG_LENGTH) continue;
          for (const key of [text(tag.name).toLowerCase(), slug.toLowerCase()]) {
            const slugs = catalog.slugs.get(key) ?? [];
            if (key && !slugs.includes(slug)) catalog.slugs.set(key, [...slugs, slug]);
          }
          if (tag.requires_after_dark === true || tag.rating === "after_dark") catalog.adult.add(slug);
        }
      }
      more = pages.every((body, i) => nextOffsetOf(body, offsets[i]!) !== null);
    }
    return catalog;
  }

  /** Loaded once per content type; a failed load is tried again by the next search. */
  function tagCatalog(type: PlotLightContentType): Promise<TagCatalog> {
    let catalog = tagCatalogs.get(type);
    if (!catalog) {
      catalog = loadTagCatalog(type);
      tagCatalogs.set(type, catalog);
      catalog.catch(() => tagCatalogs.delete(type));
    }
    return catalog;
  }

  /**
   * Tag names (or slugs) as PlotLight's catalog slugs, never derived from names. A name the
   * catalog doesn't know is sent as typed: no result carries it, so it matches nothing.
   */
  function tagFilter(names: string[], slugs: Map<string, string[]>, include: boolean): string {
    return names
      .flatMap((name) => {
        const known = slugs.get(name.trim().toLowerCase());
        // ponytail: PlotLight has no "any of" filter, so an included name shared by two slugs
        // uses the first. Listing each slug separately in the tag panel would lift this.
        return known ? (include ? known.slice(0, 1) : known) : [name.trim()];
      })
      .filter((slug) => slug && slug.length <= MAX_TAG_LENGTH)
      .slice(0, MAX_TAG_FILTERS)
      .join(",");
  }

  async function fetchPage(search: PlotLightSearch, offset: number, tags: string, excludeTags: string) {
    const url = new URL(`/api/v1/content/${search.type}`, base);
    const query = search.query.trim().slice(0, MAX_QUERY_LENGTH);
    if (query) url.searchParams.set("q", query);
    if (tags) url.searchParams.set("tags", tags);
    if (excludeTags) url.searchParams.set("exclude_tags", excludeTags);
    url.searchParams.set("sort", search.sort);
    url.searchParams.set("limit", String(PLOTLIGHT_PAGE_SIZE));
    url.searchParams.set("offset", String(offset));
    const body = await searchJson(url);
    const items = (Array.isArray(body.data) ? body.data : [])
      .map((raw) => mapPlotLightItem(raw, base))
      .filter((item): item is PlotLightItem => item !== null);
    return { items, nextOffset: nextOffsetOf(body, offset) };
  }

  /** One results page. PlotLight has no total, so pages follow `next_offset` until it is null. */
  async function searchPage(search: PlotLightSearch, page: number) {
    const key = JSON.stringify([search.type, search.query.trim(), search.sort, search.includeTags, search.excludeTags]);
    if (key !== cursorKey) {
      cursorKey = key;
      pageOffsets.clear();
    }
    const offset = page <= 1 ? 0 : (pageOffsets.get(page) ?? (page - 1) * PLOTLIGHT_PAGE_SIZE);
    // Tag filters need the catalog first; otherwise it loads alongside the page.
    const catalog = tagCatalog(search.type);
    const slugs =
      search.includeTags.length > 0 || search.excludeTags.length > 0
        ? (await catalog).slugs
        : new Map<string, string[]>();
    const tags = tagFilter(search.includeTags, slugs, true);
    const excludeTags = tagFilter(search.excludeTags, slugs, false);
    let result = await fetchPage(search, offset, tags, excludeTags);
    for (
      let skips = 0;
      result.items.length === 0 && result.nextOffset !== null && skips < MAX_EMPTY_PAGE_SKIPS;
      skips++
    ) {
      result = await fetchPage(search, result.nextOffset, tags, excludeTags);
    }
    const { adult } = await catalog;
    for (const item of result.items) item.adult = item.tags.some((tag) => adult.has(tag.slug));
    // A slower, older search must not set the newer search's next page.
    if (key === cursorKey && result.nextOffset !== null) pageOffsets.set(page + 1, result.nextOffset);
    return { items: result.items, hasMore: result.nextOffset !== null };
  }

  /**
   * Downloads the first available format, one at a time. A missing format falls
   * through to the next; a rate limit or a refused export stops the attempt.
   * Missing creator and tags are filled from the listing so attribution survives.
   */
  async function downloadCard(item: PlotLightItem, formats: readonly PlotLightFormat[]) {
    let lastError = new PlotLightError(404);
    for (const format of formats) {
      const url = item.downloads[format];
      if (!url) continue;
      let response: Response;
      try {
        const isPng = format.startsWith("png");
        response = await request(new URL(url), isPng ? "image/png" : "application/json", DOWNLOAD_TIMEOUT_MS, "export");
      } catch (error) {
        if (!(error instanceof PlotLightError) || (error.status !== 400 && error.status !== 404)) throw error;
        lastError = error;
        continue;
      }
      const card = format.startsWith("png")
        ? await parsePngCharacterCard(new File([await response.blob()], "character.png", { type: "image/png" }))
        : { json: record(await response.json()), imageDataUrl: undefined };
      const data = readCharacterCardData(card.json);
      if (!text(data.name) && !text(data.description)) throw new Error("PlotLight sent an empty card");
      if (!text(data.creator) && item.creator) data.creator = item.creator;
      if (!(Array.isArray(data.tags) && data.tags.length > 0) && item.tags.length > 0) {
        data.tags = item.tags.map((tag) => tag.name);
      }
      return card;
    }
    throw lastError;
  }

  return { searchPage, downloadCard };
}
