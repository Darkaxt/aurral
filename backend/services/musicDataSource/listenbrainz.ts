import { UUID_REGEX } from "../../../lib/uuid.ts";
import { LISTENBRAINZ_LABS_API } from "../../config/constants.ts";
import {
  deezerGetArtistTopTrackList,
  deezerGetRelatedArtists,
  getDeezerArtist,
  listenbrainzRequest,
  musicbrainzSearchArtistsByTag,
} from "../apiClients/index.ts";
import { guessArtistMbid } from "../artistMatch.ts";
import { mapWithConcurrency } from "../discovery/helpers.ts";
import { getArtistByMbid } from "../providers/brainzmashProvider.ts";
import { getLinkedDeezerArtistId } from "../providers/brainzmashMappers.ts";
import { listMusicbrainzGenres } from "../musicGenres.ts";
import type { SourceHealth } from "../discovery/tasteProfile.ts";
import type { MusicArtistRef, MusicTrendingArtist } from "./index.ts";

const LISTENBRAINZ_EXPLORER_SIMILARITY_ALGORITHM =
  "session_based_days_7500_session_300_contribution_5_threshold_10_limit_100_filter_True_skip_30";
const ARTIST_METADATA_BATCH_SIZE = 50;
const TAG_SEARCH_PAGE_SIZE = 100;
const RESOLVE_CONCURRENCY = 4;
const TRENDING_ARTIST_COUNT = 100;
const TRENDING_RECORDING_COUNT = 500;
const SITEWIDE_STATS_TIMEOUT_MS = 20000;
const DEEZER_RELATED_LIMIT = 25;

type ListenbrainzTag = { tag?: string; count?: number };
type ListenbrainzSimilarArtist = { artist_mbid?: string | null; name?: string; score?: number };
type ListenbrainzArtistTags = {
  artist_mbid?: string;
  mbid?: string;
  tag?: { artist?: ListenbrainzTag[] };
};
type ListenbrainzTopArtist = {
  artist_name?: string;
  artist_mbid?: string;
  artist_mbids?: string[];
  listen_count?: number;
};
type ListenbrainzTopRecording = {
  artist_name?: string;
  artist_mbids?: string[];
  track_name?: string;
  release_name?: string | null;
};
type ListenbrainzTopArtists = { payload?: { artists?: ListenbrainzTopArtist[] } };
type ListenbrainzTopRecordings = { payload?: { recordings?: ListenbrainzTopRecording[] } };

type TagSearchArtist = Awaited<ReturnType<typeof musicbrainzSearchArtistsByTag>>["artists"][number];

const text = (value: unknown) => String(value ?? "").trim();
const normalizeMbid = (value: unknown) => {
  const mbid = text(value).toLowerCase();
  return UUID_REGEX.test(mbid) ? mbid : null;
};
const firstMbid = (values: unknown) =>
  (Array.isArray(values) ? values.map(normalizeMbid).find(Boolean) : null) || null;

const recordHealth = (health: SourceHealth | undefined, ok: boolean) => {
  if (!health) return;
  if (ok) health.success += 1;
  else health.failure += 1;
};

const resolveArtistMbid = async (artist: MusicArtistRef) => {
  const mbid = normalizeMbid(artist?.mbid);
  if (mbid) return mbid;
  const name = text(artist?.name);
  if (!name) return null;
  return guessArtistMbid(name);
};

const toTagList = (tags: ListenbrainzTag[] | null | undefined) => {
  const entries = (Array.isArray(tags) ? tags : []).filter((tag) => text(tag?.tag));
  const topCount = Math.max(1, ...entries.map((tag) => Number(tag.count) || 0));
  return entries
    .sort((left, right) => (Number(right.count) || 0) - (Number(left.count) || 0))
    .map((tag) => ({
      name: text(tag.tag),
      count: Math.max(1, Math.round(((Number(tag.count) || 0) / topCount) * 100)),
    }));
};

const searchTagArtists = async (
  tag: string,
  { limit = 50, offset = 0 }: { limit?: number; offset?: number } = {},
) => {
  const artists = [];
  let nextOffset = offset;
  let total = Infinity;
  while (artists.length < limit && nextOffset < total) {
    const page = await musicbrainzSearchArtistsByTag(tag, {
      limit: Math.min(TAG_SEARCH_PAGE_SIZE, limit - artists.length),
      offset: nextOffset,
    });
    total = page.total;
    if (page.nextOffset <= nextOffset) break;
    nextOffset = page.nextOffset;
    artists.push(...page.artists.map((artist: TagSearchArtist) => ({ ...artist, image: null })));
  }
  return { artists: artists.slice(0, limit), hasMore: nextOffset < total };
};

const getTagArtists = (tag: string, options?: Parameters<typeof searchTagArtists>[1]) =>
  searchTagArtists(tag, options).catch(() => ({ artists: [], hasMore: false }));

type SimilarCandidate = { mbid: string | null; name: string; image: string | null; score: number };
export type SimilarArtist = Omit<SimilarCandidate, "score"> & { match: number };

const artistNameKey = (name: string) =>
  name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/^the\s+/, "")
    .replace(/[^\p{L}\p{N}]+/gu, "");

/**
 * Merges similar-artist lists from independent providers. Each candidate
 * carries its provider's own 0..1 score; an artist several providers name sums
 * their scores, so agreement outranks any single provider's opinion while a
 * single-provider list keeps its original proportions. ListenBrainz leans
 * towards widely played artists and Deezer towards catalogue neighbours.
 * Pure and deterministic: ties keep first-seen order.
 */
export const fuseSimilarArtists = (
  lists: SimilarCandidate[][],
  { limit = 50, exclude = [] }: { limit?: number; exclude?: (string | null | undefined)[] } = {},
): SimilarArtist[] => {
  const excludedMbids = new Set(exclude.map(normalizeMbid).filter(Boolean));
  const excludedNames = new Set(
    exclude
      .filter((value) => value && !normalizeMbid(value))
      .map((value) => artistNameKey(text(value))),
  );
  const merged = new Map<string, SimilarCandidate & { score: number; order: number }>();
  const keyByMbid = new Map<string, string>();
  let order = 0;
  for (const list of lists) {
    for (const candidate of list) {
      const name = text(candidate?.name);
      const nameKey = name ? artistNameKey(name) : "";
      if (!nameKey) continue;
      const mbid = normalizeMbid(candidate.mbid);
      if ((mbid && excludedMbids.has(mbid)) || excludedNames.has(nameKey)) continue;
      const key = (mbid && keyByMbid.get(mbid)) || nameKey;
      const score = Math.max(0, Number(candidate.score) || 0);
      const existing = merged.get(key);
      if (existing) {
        existing.score += score;
        existing.mbid ||= mbid;
        existing.image ||= candidate.image || null;
      } else {
        merged.set(key, { mbid, name, image: candidate.image || null, score, order: order++ });
      }
      if (mbid) keyByMbid.set(mbid, key);
    }
  }
  const ranked = [...merged.values()].sort((a, b) => b.score - a.score || a.order - b.order);
  const top = ranked[0]?.score || 1;
  return ranked.slice(0, limit).map(({ mbid, name, image, score }) => ({
    mbid,
    name,
    image,
    match: score / top,
  }));
};

const getListenbrainzSimilarArtists = async (
  mbid: string,
  health: SourceHealth | undefined,
): Promise<SimilarCandidate[]> => {
  try {
    const rows: ListenbrainzSimilarArtist[] | undefined = await listenbrainzRequest(
      "/similar-artists/json",
      { artist_mbids: mbid, algorithm: LISTENBRAINZ_EXPLORER_SIMILARITY_ALGORITHM },
      { baseUrl: LISTENBRAINZ_LABS_API },
    );
    recordHealth(health, true);
    const similar = (Array.isArray(rows) ? rows : []).filter((row) => {
      const similarMbid = normalizeMbid(row?.artist_mbid);
      return similarMbid && similarMbid !== mbid && text(row?.name);
    });
    const topScore = Math.max(0, ...similar.map((row) => Number(row.score) || 0));
    return similar.map((row) => ({
      mbid: normalizeMbid(row.artist_mbid),
      name: text(row.name),
      image: null,
      score: topScore > 0 ? (Number(row.score) || 0) / topScore : 0,
    }));
  } catch {
    recordHealth(health, false);
    return [];
  }
};

const getDeezerRelatedArtists = async (
  artist: MusicArtistRef,
  mbid: string | null,
  limit: number,
): Promise<SimilarCandidate[]> => {
  try {
    const metadata = mbid ? await getArtistByMbid(mbid).catch(() => null) : null;
    const deezerId =
      getLinkedDeezerArtistId(metadata?.links) ||
      (await getDeezerArtist(text(artist?.name) || text(metadata?.name)))?.id;
    const related = await deezerGetRelatedArtists(deezerId ?? null, { limit });
    return related.map((entry, index) => ({
      mbid: null,
      name: entry.name,
      image: entry.image,
      score: 1 - index / related.length,
    }));
  } catch {
    return [];
  }
};

export const listenbrainzSource = {
  name: "listenbrainz",

  async getSimilarArtists(
    artist: MusicArtistRef,
    { limit = 50, health }: { limit?: number; health?: SourceHealth } = {},
  ) {
    const mbid = await resolveArtistMbid(artist);
    const [listenbrainz, deezer] = await Promise.all([
      mbid ? getListenbrainzSimilarArtists(mbid, health) : Promise.resolve([]),
      getDeezerRelatedArtists(artist, mbid, Math.min(limit, DEEZER_RELATED_LIMIT)),
    ]);
    const fused = fuseSimilarArtists([listenbrainz, deezer], {
      limit,
      exclude: [mbid, text(artist?.name)],
    });
    // Only Deezer-only artists lack an MBID; resolution is cached per name.
    return mapWithConcurrency(fused, RESOLVE_CONCURRENCY, async (entry) =>
      entry.mbid ? entry : { ...entry, mbid: await guessArtistMbid(entry.name) },
    );
  },

  async getArtistTagLists(artists: MusicArtistRef[], { health }: { health?: SourceHealth } = {}) {
    const mbids = await mapWithConcurrency(artists, RESOLVE_CONCURRENCY, resolveArtistMbid);
    const unique = [...new Set(mbids.filter(Boolean))];
    const tagsByMbid = new Map<string, ReturnType<typeof toTagList>>();
    for (let index = 0; index < unique.length; index += ARTIST_METADATA_BATCH_SIZE) {
      try {
        const rows: ListenbrainzArtistTags[] | undefined = await listenbrainzRequest(
          "/1/metadata/artist/",
          {
            artist_mbids: unique.slice(index, index + ARTIST_METADATA_BATCH_SIZE).join(","),
            inc: "tag",
          },
        );
        recordHealth(health, true);
        for (const row of Array.isArray(rows) ? rows : []) {
          const mbid = normalizeMbid(row?.artist_mbid || row?.mbid);
          if (mbid) tagsByMbid.set(mbid, toTagList(row?.tag?.artist));
        }
      } catch {
        recordHealth(health, false);
      }
    }
    return mbids.map((mbid) => (mbid && tagsByMbid.get(mbid)) || []);
  },

  async getArtistTopTracks(artist: MusicArtistRef, { limit = 25 }: { limit?: number } = {}) {
    const name = text(artist?.name);
    return name ? deezerGetArtistTopTrackList(name, { limit }).catch(() => []) : [];
  },

  getTagArtists,

  async getTrendingArtists({ limit = 100 } = {}) {
    const data: ListenbrainzTopArtists = await listenbrainzRequest(
      "/1/stats/sitewide/artists",
      { count: TRENDING_ARTIST_COUNT, range: "week" },
      { timeoutMs: SITEWIDE_STATS_TIMEOUT_MS },
    );
    return (Array.isArray(data?.payload?.artists) ? data.payload.artists : [])
      .slice(0, limit)
      .map((artist, index): MusicTrendingArtist | null => {
        const name = text(artist?.artist_name);
        if (!name) return null;
        const mbid = normalizeMbid(artist?.artist_mbid) || firstMbid(artist?.artist_mbids);
        return {
          id: mbid,
          name,
          image: null,
          type: "Artist",
          popularityLabel: "Trending on ListenBrainz",
          listeners: 0,
          playcount: Number.parseInt(String(artist?.listen_count || 0), 10) || 0,
          popularityRank: index + 1,
        };
      })
      .filter((artist): artist is MusicTrendingArtist => artist !== null);
  },

  async getTrendingTracks() {
    const data: ListenbrainzTopRecordings | null = await listenbrainzRequest(
      "/1/stats/sitewide/recordings",
      { count: TRENDING_RECORDING_COUNT, range: "week" },
      { timeoutMs: SITEWIDE_STATS_TIMEOUT_MS },
    ).catch(() => null);
    return (Array.isArray(data?.payload?.recordings) ? data.payload.recordings : [])
      .map((recording) => ({
        artistName: text(recording?.artist_name),
        artistMbid: firstMbid(recording?.artist_mbids),
        name: text(recording?.track_name),
        albumName: text(recording?.release_name) || null,
      }))
      .filter((track) => track.artistName && track.name);
  },

  async getPopularTags() {
    return listMusicbrainzGenres();
  },
};
