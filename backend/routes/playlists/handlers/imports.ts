import { Hono } from "hono";
import type { AppEnv } from "../../../middleware/requestUser.ts";
import listenbrainzImport from "./listenbrainzImport.ts";
import spotifyImport from "./spotifyImport.ts";
import youtubeMusicImport from "./youtubeMusicImport.ts";

export default new Hono<AppEnv>()
  .basePath("/playlists")
  .route("/", spotifyImport)
  .route("/", listenbrainzImport)
  .route("/", youtubeMusicImport);
