import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import net from "node:net";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { importFromRepo } from "../helpers/backendTestHarness.js";

const require = createRequire(import.meta.url);

class FakeSocket extends EventEmitter {
  constructor() {
    super();
    this.destroyed = false;
    this.writes = [];
  }

  write(chunk) {
    this.writes.push(chunk);
    return true;
  }

  end() {
    this.destroy();
  }

  destroy(error) {
    if (this.destroyed) return this;
    this.destroyed = true;
    queueMicrotask(() => {
      if (error) this.emit("error", error);
      this.emit("close");
    });
    return this;
  }

  pause() {}

  resume() {}
}

test("queued peer download timeout destroys the pending Soulseek socket", async () => {
  const sockets = [];
  const originalCreateConnection = net.createConnection;
  net.createConnection = (...args) => {
    const socket = new FakeSocket();
    sockets.push(socket);
    return socket;
  };

  const tempDir = await mkdtemp(path.join(os.tmpdir(), "aurral-slsk-timeout-"));
  try {
    delete globalThis.__aurralSlskDownloadPatchApplied;
    const peerModulePath = require.resolve(
      "slsk-client/lib/peer/download-peer-file.js",
    );
    delete require.cache[peerModulePath];

    const slskStack = require("slsk-client/lib/stack");
    slskStack.downloadTokens = {};
    slskStack.download = {};
    slskStack.currentLogin = "test-user";

    const { SimpleSoulseekClient } = await importFromRepo(
      "backend/services/simpleSoulseekClient.js",
    );
    const downloadPeerFile = require(
      "slsk-client/lib/peer/download-peer-file.js",
    );

    const client = new SimpleSoulseekClient();
    client.acquireConnection = async () => {};
    client.releaseConnection = () => {};
    client.client = {
      download({ file, path: destinationPath }, cb, stream) {
        const token = "queued-token";
        slskStack.downloadTokens[token] = {
          user: file.user,
          file: file.file,
          size: file.size,
        };
        slskStack.download[`${file.user}_${file.file}`] = {
          cb,
          path: destinationPath,
          stream,
        };
        downloadPeerFile("198.51.100.10", 50300, token, file.user, true);
      },
    };

    const result = {
      user: "queued-user",
      file: "Artist\\Album\\01 - Song.flac",
      size: 1024,
    };
    const destinationPath = path.join(tempDir, "queued.flac");

    await assert.rejects(
      client.download(result, destinationPath, null, { queuedTimeoutMs: 2500 }),
      /Download queued/,
    );

    assert.equal(sockets.length, 1);
    assert.equal(sockets[0].destroyed, true);
    assert.deepEqual(slskStack.downloadTokens, {});
    assert.deepEqual(slskStack.download, {});
  } finally {
    net.createConnection = originalCreateConnection;
    await rm(tempDir, { recursive: true, force: true });
  }
});
