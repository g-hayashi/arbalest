import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { packageTeamsApp } from "../../scripts/package-teams.js";

const appId = "22222222-2222-4222-8222-222222222222";
describe("Teamsアプリのパッケージ", () => {
  it("manifestと規定サイズのアイコンをZIP直下へ作る", async () => {
    const dir = await mkdtemp(join(tmpdir(), "arbalest-teams-"));
    const path = join(dir, "app.zip");
    await packageTeamsApp({
      appId,
      websiteUrl: "https://app.example.test",
      privacyUrl: "https://app.example.test/privacy",
      termsUrl: "https://app.example.test/terms",
      output: path,
    });
    const files = unzipSync(await readFile(path));
    expect(Object.keys(files).sort()).toEqual(["color.png", "manifest.json", "outline.png"]);
    const manifest = JSON.parse(new TextDecoder().decode(files["manifest.json"]));
    expect(manifest.id).toBe(appId);
    expect(manifest.bots[0]).toMatchObject({ botId: appId, scopes: ["team"] });
    expect(manifest.authorization.permissions.resourceSpecific).toEqual([
      { name: "ChannelMessage.Read.Group", type: "Application" },
      { name: "ChannelSettings.Read.Group", type: "Application" },
    ]);
    expect(JSON.stringify(manifest)).not.toMatch(/\{\{/);
    for (const [file, size] of [
      ["outline.png", 32],
      ["color.png", 192],
    ] as const) {
      const png = Buffer.from(files[file] ?? []);
      expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
      expect(png.readUInt32BE(16)).toBe(size);
      expect(png.readUInt32BE(20)).toBe(size);
      expect(png[25]).toBe(6); // RGBA、outlineの背景は透明。
    }
  });
  it("不正なIDやhttpの公開URLをパッケージ化しない", async () => {
    const options = {
      appId,
      websiteUrl: "https://app.example.test",
      privacyUrl: "https://app.example.test/privacy",
      termsUrl: "https://app.example.test/terms",
      output: ".tmp/unused.zip",
    };
    await expect(packageTeamsApp({ ...options, appId: "bad" })).rejects.toThrow();
    await expect(
      packageTeamsApp({ ...options, websiteUrl: "http://app.example.test" }),
    ).rejects.toThrow();
  });
});
