/** 公開IDと公開URLだけを使い、Teamsへアップロードするmanifest/アイコンをZIP化する。 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { deflateSync } from "node:zlib";
import { strToU8, zipSync } from "fflate";
import { z } from "zod";

const httpsUrl = z.url().refine((value) => {
  const url = new URL(value);
  return url.protocol === "https:" && !url.username && !url.password;
});
const optionsSchema = z.object({
  appId: z.string().uuid(),
  websiteUrl: httpsUrl,
  privacyUrl: httpsUrl,
  termsUrl: httpsUrl,
  output: z.string().min(1),
});
type PackageOptions = z.infer<typeof optionsSchema>;

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
function chunk(name: string, data: Buffer): Buffer {
  const type = Buffer.from(name);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([type, data])));
  return Buffer.concat([size, type, data, crc]);
}
function icon(size: number, outline: boolean): Uint8Array {
  const pixels = Buffer.alloc(size * (size * 4 + 1));
  const glyph = ["0011100", "0110110", "1100011", "1100011", "1111111", "1100011", "1100011"];
  const margin = Math.floor(size / 5);
  const span = size - margin * 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const gx = Math.floor(((x - margin) * 7) / span);
      const gy = Math.floor(((y - margin) * 7) / span);
      const ink = gx >= 0 && gx < 7 && gy >= 0 && gy < 7 && glyph[gy]?.[gx] === "1";
      const i = y * (size * 4 + 1) + x * 4 + 1;
      pixels.set(ink ? [255, 255, 255, 255] : outline ? [0, 0, 0, 0] : [36, 79, 105, 255], i);
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(size, 0);
  header.writeUInt32BE(size, 4);
  header[8] = 8;
  header[9] = 6;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", header),
    chunk("IDAT", deflateSync(pixels)),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export async function packageTeamsApp(input: PackageOptions): Promise<void> {
  const options = optionsSchema.parse(input);
  const template = JSON.parse(
    await readFile(new URL("../teams/manifest.template.json", import.meta.url), "utf8"),
  );
  const values: Record<string, string> = {
    APP_ID: options.appId,
    WEBSITE_URL: options.websiteUrl,
    PRIVACY_URL: options.privacyUrl,
    TERMS_URL: options.termsUrl,
  };
  // JSON文字列の直接置換ではなく値ごとに置換し、引用符等も正しくエンコードする。
  const manifest = JSON.parse(JSON.stringify(template), (_key, value: unknown) =>
    typeof value === "string"
      ? value.replace(/\{\{([A-Z_]+)\}\}/g, (_match, name: string) => {
          const replacement = values[name];
          if (replacement === undefined) throw new Error("未知のmanifestプレースホルダーです");
          return replacement;
        })
      : value,
  );
  const zip = zipSync({
    "manifest.json": strToU8(`${JSON.stringify(manifest, null, 2)}\n`),
    "outline.png": icon(32, true),
    "color.png": icon(192, false),
  });
  await mkdir(dirname(resolve(options.output)), { recursive: true });
  await writeFile(options.output, zip);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({
    options: {
      "app-id": { type: "string" },
      "website-url": { type: "string" },
      "privacy-url": { type: "string" },
      "terms-url": { type: "string" },
      output: { type: "string", default: ".tmp/teams-app.zip" },
    },
  });
  packageTeamsApp({
    appId: values["app-id"] ?? "",
    websiteUrl: values["website-url"] ?? "",
    privacyUrl: values["privacy-url"] ?? "",
    termsUrl: values["terms-url"] ?? "",
    output: values.output,
  })
    .then(() => console.log(`Teamsパッケージを作成しました: ${values.output}`))
    .catch(() => {
      console.error(
        "作成失敗。--app-id (UUID)、--website-url、--privacy-url、--terms-url (HTTPS) を確認してください。",
      );
      process.exitCode = 1;
    });
}
