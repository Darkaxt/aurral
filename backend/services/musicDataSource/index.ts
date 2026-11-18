import { dbOps } from "../../db/helpers/index.ts";
import { getLastfmApiKey } from "../apiClients/index.ts";
import { isLastfmUnavailable, lastfmAvailability, lastfmSource } from "./lastfm.ts";
import { listenbrainzSource } from "./listenbrainz.ts";

export const MUSIC_DATA_SOURCE_LASTFM = lastfmSource.name;
export const MUSIC_DATA_SOURCE_LISTENBRAINZ = listenbrainzSource.name;

export type MusicArtistRef = { name?: string | null; mbid?: string | number | null };

export type MusicTrendingArtist = {
  id: string | null;
  name: string;
  image: string | null;
  type: string;
  popularityLabel: string;
  listeners: number;
  playcount: number;
  popularityRank: number | null;
};

type LastfmSource = typeof lastfmSource;
type SourceMethod = Exclude<keyof LastfmSource, "name">;
type SourceArg<M extends SourceMethod, I extends number> = LastfmSource[M] extends (
  ...args: infer A extends unknown[]
) => unknown
  ? A[I]
  : never;

/**
 * "listenbrainz" uses only keyless providers (ListenBrainz + Deezer +
 * MusicBrainz) even when a Last.fm key is configured; "lastfm" uses Last.fm
 * whenever a key exists; "auto" (default) prefers Last.fm but answers from the
 * keyless providers while Last.fm is failing. AURRAL_MUSIC_DATA_SOURCE sets the
 * default; integrations.lastfm.musicDataSource overrides it.
 */
export type MusicDataSourcePreference = "auto" | "lastfm" | "listenbrainz";

const normalizePreference = (value: unknown): MusicDataSourcePreference | null => {
  const raw = String(value ?? "")
    .trim()
    .toLowerCase();
  if (raw === "auto" || raw === "lastfm" || raw === "listenbrainz") return raw;
  if (raw === "open" || raw === "keyless") return "listenbrainz";
  return null;
};

export const getMusicDataSourcePreference = (): MusicDataSourcePreference =>
  normalizePreference(dbOps.getSettings().integrations?.lastfm?.musicDataSource) ||
  normalizePreference(process.env.AURRAL_MUSIC_DATA_SOURCE) ||
  "auto";

// The configured source decides the reported provider name, which keys the
// discovery cache. It deliberately ignores transient Last.fm failures so an
// outage does not trigger refresh storms.
const configuredSource = () =>
  getMusicDataSourcePreference() !== "listenbrainz" && getLastfmApiKey()
    ? lastfmSource
    : listenbrainzSource;

const isEmptyResult = (value: unknown): boolean => {
  if (Array.isArray(value))
    return value.every((entry) => Array.isArray(entry) && entry.length === 0);
  if (value && typeof value === "object" && "artists" in value) {
    return isEmptyResult((value as { artists: unknown }).artists);
  }
  return value == null;
};

// R is each wrapper's whole return type (a union of both sources' promises), so
// inference never has to unify the two result shapes.
async function fromSource<R>(
  run: (source: LastfmSource | typeof listenbrainzSource) => R,
): Promise<Awaited<R>> {
  const source = configuredSource();
  const canFallBack = source === lastfmSource && getMusicDataSourcePreference() === "auto";
  if (!canFallBack) return await run(source);
  if (isLastfmUnavailable()) return await run(listenbrainzSource);
  const failuresBefore = lastfmAvailability.failures;
  try {
    const result = await run(source);
    if (!isEmptyResult(result) || lastfmAvailability.failures === failuresBefore) return result;
  } catch (error) {
    if (lastfmAvailability.failures === failuresBefore) throw error;
  }
  return await run(listenbrainzSource);
}

export const getMusicDataSourceName = () => configuredSource().name;

export const getSimilarArtists = (
  artist: MusicArtistRef,
  options: SourceArg<"getSimilarArtists", 1>,
) => fromSource((source) => source.getSimilarArtists(artist, options));

export const getArtistTagLists = (
  artists: MusicArtistRef[],
  options?: SourceArg<"getArtistTagLists", 1>,
) => fromSource((source) => source.getArtistTagLists(artists, options));

export const getArtistTopTracks = (
  artist: MusicArtistRef,
  options: SourceArg<"getArtistTopTracks", 1>,
) => fromSource((source) => source.getArtistTopTracks(artist, options));

export const getTagArtists = (tag: string, options: SourceArg<"getTagArtists", 1>) =>
  fromSource((source) => source.getTagArtists(tag, options));

export const getTrendingArtists = (options: SourceArg<"getTrendingArtists", 0>) =>
  fromSource((source) => source.getTrendingArtists(options));

export const getTrendingTracks = (options: SourceArg<"getTrendingTracks", 0>) =>
  fromSource((source) => source.getTrendingTracks(options));

export const getPopularTags = () => fromSource((source) => source.getPopularTags());
