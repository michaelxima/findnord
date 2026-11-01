// Synchronous-startup bridge for Sharp. The main server API uses Sharp's
// asynchronous interface directly; database migrations invoke this worker
// with spawnSync so legacy inline/local images receive the same guarantees
// before openDatabase() returns.
const sharp = require("sharp");

const MAX_IMAGE_BYTES = 1_000_000;
const FORMAT_MIME = {
  jpeg: "image/jpeg",
  png: "image/png",
  webp: "image/webp",
  gif: "image/gif"
};

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", async () => {
  try {
    const input = Buffer.concat(chunks);
    const metadata = await sharp(input, { animated: true, limitInputPixels: 80_000_000 }).metadata();
    const detectedMimeType = FORMAT_MIME[metadata.format];
    if (!detectedMimeType || !metadata.width || !metadata.height) throw new Error("INVALID_IMAGE");

    let output = input;
    let mimeType = detectedMimeType;
    if (input.length >= MAX_IMAGE_BYTES) {
      for (const quality of [90, 82, 74, 66, 58, 50, 42, 34, 26, 20, 15, 10]) {
        const candidate = await sharp(input, { animated: true, limitInputPixels: 80_000_000 })
          .webp({ quality, effort: 6 })
          .toBuffer();
        if (candidate.length < MAX_IMAGE_BYTES) {
          output = candidate;
          mimeType = "image/webp";
          break;
        }
      }
    }
    if (output.length >= MAX_IMAGE_BYTES) throw new Error("IMAGE_TOO_LARGE");
    const finalMetadata = await sharp(output, { animated: true }).metadata();
    if (finalMetadata.width !== metadata.width || finalMetadata.height !== metadata.height) {
      throw new Error("IMAGE_DIMENSIONS_CHANGED");
    }
    process.stdout.write(JSON.stringify({
      mimeType,
      width: finalMetadata.width,
      height: finalMetadata.height,
      bufferBase64: output.toString("base64")
    }));
  } catch (error) {
    process.stderr.write(error && error.message ? error.message : "INVALID_IMAGE");
    process.exitCode = 1;
  }
});
