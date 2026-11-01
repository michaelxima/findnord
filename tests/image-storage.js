const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const sharp = require("sharp");
const { createImageStorage, MAX_IMAGE_BYTES } = require("../scripts/image-storage");
const { openDatabase } = require("../scripts/db");
const { productionCatalogListings } = require("../db/seed-data");

async function main() {
  for (const listing of productionCatalogListings) {
    assert.ok(listing.images.length >= 3 && listing.images.length <= 6, `${listing.id} must ship with 3–6 images`);
    assert.match(listing.images[1].css, /^url\("https:\/\/cdn\.shopify\.com\//, `${listing.id} must retain its external original in the gallery`);
    for (const image of [listing.images[0], listing.images[2]]) {
      const match = /^url\("(\/assets\/product-images\/generated\/[^"?]+)"\)$/.exec(image.css);
      assert.ok(match, `${listing.id} generated gallery image must use a bundled asset`);
      const assetPath = path.join(__dirname, "..", match[1]);
      assert.ok(fs.existsSync(assetPath), `${match[1]} must exist`);
      assert.ok(fs.statSync(assetPath).size < MAX_IMAGE_BYTES, `${match[1]} must be smaller than 1 MB`);
    }
  }

  const uploadsDir = fs.mkdtempSync(path.join(os.tmpdir(), "findnord-image-test-"));
  try {
    const storage = createImageStorage(uploadsDir);

    // Deterministic high-entropy pixels make a PNG comfortably exceed 1 MB,
    // forcing the real server optimizer rather than testing a no-op path.
    const width = 1600;
    const height = 1200;
    const pixels = Buffer.alloc(width * height * 3);
    let state = 0x12345678;
    for (let i = 0; i < pixels.length; i += 1) {
      state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
      pixels[i] = state >>> 24;
    }
    const largePng = await sharp(pixels, { raw: { width, height, channels: 3 } })
      .png({ compressionLevel: 0 })
      .toBuffer();
    assert.ok(largePng.length > MAX_IMAGE_BYTES, "fixture must exercise the oversized path");

    const largeRecord = await storage.saveImageRecord(
      `url(data:image/png;base64,${largePng.toString("base64")}) center/cover no-repeat`,
      "large-product",
      { sourceType: "upload", uploadedBy: "user-1" }
    );
    assert.ok(largeRecord.byteSize < MAX_IMAGE_BYTES, "optimized file must be strictly below 1 MB");
    assert.equal(largeRecord.mimeType, "image/webp");
    assert.equal(largeRecord.width, width, "pixel width must not change");
    assert.equal(largeRecord.height, height, "pixel height must not change");
    assert.equal(largeRecord.uploadedBy, "user-1");
    assert.match(largeRecord.sha256, /^[a-f0-9]{64}$/);
    assert.equal(fs.statSync(path.join(uploadsDir, largeRecord.storageKey)).size, largeRecord.byteSize);

    const smallPng = await sharp({
      create: { width: 320, height: 180, channels: 3, background: { r: 21, g: 86, b: 120 } }
    }).png().toBuffer();
    const smallRecord = await storage.saveImageRecord(
      `url(data:image/png;base64,${smallPng.toString("base64")}) center/cover no-repeat`,
      "small-product",
      { sourceType: "upload", uploadedBy: "user-2" }
    );
    assert.equal(smallRecord.mimeType, "image/png", "already-small files must retain their encoding");
    assert.equal(smallRecord.byteSize, smallPng.length, "already-small files must retain their exact bytes");
    assert.equal(smallRecord.width, 320);
    assert.equal(smallRecord.height, 180);

    const mismatchedRecord = await storage.saveImageRecord(
      `url(data:image/jpeg;base64,${smallPng.toString("base64")}) center/cover no-repeat`,
      "mismatched-product",
      { sourceType: "upload", uploadedBy: "user-3" }
    );
    assert.equal(mismatchedRecord.mimeType, "image/png", "decoded bytes, not a client-declared MIME, must determine storage metadata");
    assert.match(mismatchedRecord.storageKey, /\.png$/, "the storage extension must match the decoded format");

    const legacyCss = storage.saveImageIfInlineSync(
      `url(data:image/png;base64,${largePng.toString("base64")}) center/cover no-repeat`,
      "legacy-large"
    );
    const legacyKey = /^url\(\/uploads\/([^)]+)\)/.exec(legacyCss)[1];
    assert.ok(fs.statSync(path.join(uploadsDir, legacyKey)).size < MAX_IMAGE_BYTES, "legacy inline migration must also enforce the sub-1 MB ceiling");
    assert.match(legacyKey, /\.webp$/, "an oversized legacy image must be optimized to WebP");

    await assert.rejects(
      storage.saveImageRecord(
        `url(data:image/png;base64,${Buffer.alloc(MAX_IMAGE_BYTES, 7).toString("base64")})`,
        "invalid-large"
      ),
      (error) => error && error.code === "INVALID_IMAGE",
      "an oversized undecodable payload must fail closed"
    );

    const dbPath = path.join(uploadsDir, "metadata-backfill.db");
    let db = openDatabase(dbPath, { uploadsDir });
    const columns = new Set(db.prepare("PRAGMA table_info(listing_images)").all().map((column) => column.name));
    [
      "mime_type",
      "byte_size",
      "width",
      "height",
      "sha256",
      "storage_key",
      "source_type",
      "uploaded_by",
      "created_at"
    ].forEach((column) => assert.ok(columns.has(column), `listing_images must include ${column}`));
    const imageRow = db.prepare("SELECT id FROM listing_images WHERE listing_id = 'oak-table' ORDER BY position LIMIT 1").get();
    db.prepare(`UPDATE listing_images SET css = ?, mime_type = NULL, byte_size = NULL, width = NULL, height = NULL,
      sha256 = NULL, storage_key = NULL, source_type = 'upload' WHERE id = ?`).run(legacyCss, imageRow.id);
    db.close();
    db = openDatabase(dbPath, { uploadsDir });
    const backfilled = db.prepare("SELECT * FROM listing_images WHERE id = ?").get(imageRow.id);
    assert.equal(backfilled.width, width, "existing local uploads must have width backfilled");
    assert.equal(backfilled.height, height, "existing local uploads must have height backfilled");
    assert.ok(backfilled.byte_size < MAX_IMAGE_BYTES, "existing local uploads must remain below the byte ceiling");
    assert.match(backfilled.sha256, /^[a-f0-9]{64}$/);
    db.close();

    console.log("Image storage tests passed: sub-1MB, dimensions preserved, metadata schema present.");
  } finally {
    fs.rmSync(uploadsDir, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
