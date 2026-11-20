import { listenbrainzSource } from "./listenbrainz.ts";

// Last.fm was removed (Dec 1 2026: its API requires Pro). Music data comes only
// from the keyless providers: ListenBrainz + Deezer + MusicBrainz.
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

type Source = typeof listenbrainzSource;
type SourceMethod = Exclude<keyof Source, "name">;
type SourceArg<M extends SourceMethod, I extends number> = Source[M] extends (
  ...args: infer A extends unknown[]
) => unknown
  ? A[I]
  : never;

export const getMusicDataSourceName = () => listenbrainzSource.name;

// `signal` is accepted for callers' sake; the keyless providers do not use it.
export const getSimilarArtists = (
  artist: MusicArtistRef,
  {
    signal: _signal,
    ...options
  }: SourceArg<"getSimilarArtists", 1> & { signal?: AbortSignal } = {},
) => listenbrainzSource.getSimilarArtists(artist, options);

export const getArtistTagLists = (
  artists: MusicArtistRef[],
  options?: SourceArg<"getArtistTagLists", 1>,
) => listenbrainzSource.getArtistTagLists(artists, options);

export const getArtistTopTracks = (
  artist: MusicArtistRef,
  options: SourceArg<"getArtistTopTracks", 1>,
) => listenbrainzSource.getArtistTopTracks(artist, options);

export const getTagArtists = (tag: string, options: SourceArg<"getTagArtists", 1>) =>
  listenbrainzSource.getTagArtists(tag, options);

export const getTrendingArtists = (options: SourceArg<"getTrendingArtists", 0>) =>
  listenbrainzSource.getTrendingArtists(options);

export const getTrendingTracks = (_options: { limit?: number } = {}) =>
  listenbrainzSource.getTrendingTracks();

export const getPopularTags = () => listenbrainzSource.getPopularTags();
