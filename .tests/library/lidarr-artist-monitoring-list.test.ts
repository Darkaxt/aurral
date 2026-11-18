import { signedInAs } from "../helpers/honoApp.ts";
import assert from "node:assert/strict";
import { test, vi } from "vite-plus/test";

import { db } from "../../backend/config/db-sqlite.ts";
import { upsertLibraryArtist } from "../../backend/services/libraryMediaStore.ts";
import { libraryManager } from "../../backend/services/libraryManager.ts";
import { lidarrClient } from "../../backend/services/lidarrClient.ts";
import { setLibraryManagement } from "../../backend/services/libraryManagementStore.ts";
import { getLibraryArtistProjection } from "../../backend/services/libraryQueryService.ts";
import { api } from "../../backend/routes/api.ts";

const app = signedInAs(undefined).route("/", api);

const mbid = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`;

test("library artist list reports Lidarr monitoring for scanned artists", async () => {
  const key = `lidarr-monitoring-list-${process.pid}-${Date.now()}`;
  const monitored = upsertLibraryArtist({
    identityKey: `mbid:${mbid(1)}`,
    mbid: mbid(1),
    name: `${key} Monitored`,
  });
  const unmonitored = upsertLibraryArtist({
    identityKey: `mbid:${mbid(2)}`,
    mbid: mbid(2),
    name: `${key} Unmonitored`,
  });
  const aurralOwned = upsertLibraryArtist({
    identityKey: `mbid:${mbid(3)}`,
    mbid: mbid(3),
    name: `${key} Aurral`,
  });
  setLibraryManagement({ entityKind: "artist", entityId: aurralOwned.id, managedBy: "aurral" });

  const lidarrArtists = [
    {
      id: 501,
      foreignArtistId: mbid(1),
      artistName: `${key} Monitored`,
      monitored: true,
      monitorNewItems: "all",
    },
    {
      id: 502,
      foreignArtistId: mbid(2),
      artistName: `${key} Unmonitored`,
      monitored: false,
      monitorNewItems: "none",
    },
    { id: 503, foreignArtistId: mbid(3), artistName: `${key} Aurral`, monitored: true },
  ];
  const originalConfigured = lidarrClient.isConfigured;
  lidarrClient.isConfigured = () => true;
  const getArtists = vi
    .spyOn(lidarrClient, "getArtists")
    .mockImplementation(async () => lidarrArtists as never);

  try {
    // Before any Lidarr refresh the scanned rows carry no monitoring (the reported bug).
    assert.equal(getLibraryArtistProjection({ reference: mbid(1) })[0]?.monitored, false);

    await libraryManager.refreshLidarrArtistState({ force: true });

    const first = getLibraryArtistProjection({ reference: mbid(1) })[0];
    assert.equal(first?.monitored, true);
    assert.equal(first?.monitorNewItems, "all");
    // Ownership is not inferred from the mirror.
    assert.equal(first?.managedBy, null);
    assert.equal(first?.lidarrManaged, false);
    assert.equal(getLibraryArtistProjection({ reference: mbid(2) })[0]?.monitored, false);
    assert.equal(getLibraryArtistProjection({ reference: mbid(3) })[0]?.monitored, false);

    // The list route reports the mirrored state without blocking on Lidarr.
    const response = await app.request("/library/artists?limit=10000");
    assert.equal(response.status, 200);
    const body = (await response.json()) as { mbid?: string; monitored?: boolean }[];
    assert.equal(body.find((artist) => artist.mbid === mbid(1))?.monitored, true);
    assert.equal(body.find((artist) => artist.mbid === mbid(2))?.monitored, false);

    // An artist Lidarr no longer knows loses its mirrored monitoring.
    getArtists.mockImplementation(async () => [lidarrArtists[1]] as never);
    await libraryManager.refreshLidarrArtistState({ force: true });
    assert.equal(getLibraryArtistProjection({ reference: mbid(1) })[0]?.monitored, false);

    // A Lidarr failure keeps the last known state.
    getArtists.mockImplementation(async () => {
      throw new Error("Lidarr offline");
    });
    await libraryManager.refreshLidarrArtistState({ force: true });
    assert.equal(getLibraryArtistProjection({ reference: mbid(2) })[0]?.monitored, false);
  } finally {
    lidarrClient.isConfigured = originalConfigured;
    getArtists.mockRestore();
    db.prepare("DELETE FROM library_management WHERE entity_kind = 'artist' AND entity_id = ?").run(
      aurralOwned.id,
    );
    for (const artist of [monitored, unmonitored, aurralOwned]) {
      db.prepare("DELETE FROM library_artists WHERE id = ?").run(artist.id);
    }
  }
});
