// Durable local image storage for listing photos.
//
// New uploads are persisted with a hard sub-1,000,000-byte ceiling. Payloads
// already below that ceiling are retained byte-for-byte (so the server never
// needlessly degrades a client's photo). Oversized payloads are re-encoded as
// WebP at progressively lower quality while preserving their pixel dimensions.

const crypto = require("node:crypto");
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const sharp = require("sharp");

const DEFAULT_UPLOADS_DIR = path.join(__dirname, "..", "uploads");
const MAX_IMAGE_BYTES = 1_000_000;
const MAX_INPUT_BYTES = 12 * 1024 * 1024;
const SYNC_WORKER_PATH = path.join(__dirname, "image-optimize-worker.js");

const MIME_EXTENSIONS = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif"
};
const FORMAT_MIME = { jpeg: "image/jpeg", png: "image/png", webp: "image/webp", gif: "image/gif" };

const INLINE_DATA_URL_PATTERN = /^url\(data:([\w./+-]+);base64,([^)]+)\)(.*)$/;
const LOCAL_FILE_URL_PATTERN = /^url\(\/uploads\/([^)]+)\)(.*)$/;

class ImageStorageError extends Error {
  constructor(message, code) {
    super(message);
    this.name = "ImageStorageError";
    this.code = code;
  }
}

function digest(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function safeFilenameBase(value) {
  const safe = String(value || "image").replace(/[^a-zA-Z0-9_-]/g, "-").slice(0, 160);
  return safe || "image";
}

async function readableMetadata(buffer, strict = false) {
  try {
    const metadata = await sharp(buffer, { animated: true, limitInputPixels: 80_000_000 }).metadata();
    return {
      width: Number.isFinite(metadata.width) ? metadata.width : null,
      height: Number.isFinite(metadata.height) ? metadata.height : null,
      format: metadata.format || null
    };
  } catch (_error) {
    if (strict) throw new ImageStorageError("The uploaded image could not be decoded.", "INVALID_IMAGE");
    return { width: null, height: null, format: null };
  }
}

async function optimizeOversizedImage(buffer) {
  let inputMetadata;
  try {
    inputMetadata = await sharp(buffer, { animated: true, limitInputPixels: 80_000_000 }).metadata();
  } catch (_error) {
    throw new ImageStorageError("The uploaded image could not be decoded.", "INVALID_IMAGE");
  }

  const qualities = [90, 82, 74, 66, 58, 50, 42, 34, 26, 20, 15, 10];
  for (const quality of qualities) {
    const candidate = await sharp(buffer, { animated: true, limitInputPixels: 80_000_000 })
      .webp({ quality, effort: 6 })
      .toBuffer();
    if (candidate.length >= MAX_IMAGE_BYTES) continue;

    const outputMetadata = await sharp(candidate, { animated: true }).metadata();
    if (outputMetadata.width !== inputMetadata.width || outputMetadata.height !== inputMetadata.height) {
      throw new ImageStorageError("Image optimization changed the pixel dimensions.", "IMAGE_DIMENSIONS_CHANGED");
    }
    return {
      buffer: candidate,
      mimeType: "image/webp",
      width: outputMetadata.width || null,
      height: outputMetadata.height || null
    };
  }

  throw new ImageStorageError(
    "The image could not be compressed below 1 MB without changing its resolution.",
    "IMAGE_TOO_LARGE"
  );
}

function createImageStorage(uploadsDir) {
  const resolvedDir = uploadsDir || process.env.UPLOADS_DIR || DEFAULT_UPLOADS_DIR;

  function ensureUploadsDir() {
    fs.mkdirSync(resolvedDir, { recursive: true });
  }

  async function recordForLocalCss(css, options = {}) {
    const match = LOCAL_FILE_URL_PATTERN.exec(css || "");
    if (!match) {
      return {
        css,
        mimeType: null,
        byteSize: null,
        width: null,
        height: null,
        sha256: null,
        storageKey: null,
        sourceType: options.sourceType || (/^url\(https?:/i.test(css || "") ? "external" : "css"),
        uploadedBy: options.uploadedBy || null,
        createdAt: Date.now()
      };
    }

    const storageKey = path.basename(match[1]);
    const filePath = path.join(resolvedDir, storageKey);
    if (!fs.existsSync(filePath)) {
      return {
        css,
        mimeType: null,
        byteSize: null,
        width: null,
        height: null,
        sha256: null,
        storageKey,
        sourceType: options.sourceType || "upload",
        uploadedBy: options.uploadedBy || null,
        createdAt: Date.now()
      };
    }

    const buffer = fs.readFileSync(filePath);
    const dimensions = await readableMetadata(buffer);
    const extension = path.extname(storageKey).slice(1).toLowerCase();
    const mimeType = Object.entries(MIME_EXTENSIONS).find(([, ext]) => ext === extension)?.[0] || null;
    return {
      css,
      mimeType,
      byteSize: buffer.length,
      width: dimensions.width,
      height: dimensions.height,
      sha256: digest(buffer),
      storageKey,
      sourceType: options.sourceType || "upload",
      uploadedBy: options.uploadedBy || null,
      createdAt: Date.now()
    };
  }

  async function saveImageRecord(css, filenameBase, options = {}) {
    const match = INLINE_DATA_URL_PATTERN.exec(css || "");
    if (!match) return recordForLocalCss(css, options);

    const [, declaredMimeType, base64, suffix] = match;
    if (!Object.prototype.hasOwnProperty.call(MIME_EXTENSIONS, declaredMimeType)) {
      throw new ImageStorageError("Choose a JPEG, PNG, WebP, or GIF image.", "UNSUPPORTED_IMAGE_TYPE");
    }

    const inputBuffer = Buffer.from(base64, "base64");
    if (inputBuffer.length === 0) throw new ImageStorageError("The uploaded image is empty.", "INVALID_IMAGE");
    if (inputBuffer.length > MAX_INPUT_BYTES) {
      throw new ImageStorageError("The uploaded image is too large to process.", "IMAGE_INPUT_TOO_LARGE");
    }

    let outputBuffer = inputBuffer;
    let dimensions = await readableMetadata(inputBuffer, true);
    let outputMimeType = FORMAT_MIME[dimensions.format];
    if (!outputMimeType) {
      throw new ImageStorageError("Choose a JPEG, PNG, WebP, or GIF image.", "UNSUPPORTED_IMAGE_TYPE");
    }
    if (inputBuffer.length >= MAX_IMAGE_BYTES) {
      const optimized = await optimizeOversizedImage(inputBuffer);
      outputBuffer = optimized.buffer;
      outputMimeType = optimized.mimeType;
      dimensions = { width: optimized.width, height: optimized.height };
    }
    if (outputBuffer.length >= MAX_IMAGE_BYTES) {
      throw new ImageStorageError("The image must be smaller than 1 MB.", "IMAGE_TOO_LARGE");
    }

    const extension = MIME_EXTENSIONS[outputMimeType];
    const fileName = `${safeFilenameBase(filenameBase)}.${extension}`;
    const filePath = path.join(resolvedDir, fileName);
    const tempPath = `${filePath}.${process.pid}.tmp`;
    ensureUploadsDir();
    fs.writeFileSync(tempPath, outputBuffer);
    fs.renameSync(tempPath, filePath);

    return {
      css: `url(/uploads/${fileName})${suffix}`,
      mimeType: outputMimeType,
      byteSize: outputBuffer.length,
      width: dimensions.width,
      height: dimensions.height,
      sha256: digest(outputBuffer),
      storageKey: fileName,
      sourceType: options.sourceType || "upload",
      uploadedBy: options.uploadedBy || null,
      createdAt: Date.now()
    };
  }

  async function saveImageIfInline(css, filenameBase) {
    return (await saveImageRecord(css, filenameBase)).css;
  }

  function processImageBufferSync(inputBuffer) {
    if (!inputBuffer.length) throw new ImageStorageError("The uploaded image is empty.", "INVALID_IMAGE");
    if (inputBuffer.length > MAX_INPUT_BYTES) {
      throw new ImageStorageError("The uploaded image is too large to process.", "IMAGE_INPUT_TOO_LARGE");
    }
    const result = spawnSync(process.execPath, [SYNC_WORKER_PATH], {
      input: inputBuffer,
      encoding: "utf8",
      maxBuffer: 24 * 1024 * 1024
    });
    if (result.status !== 0) {
      const code = String(result.stderr || "").trim() || "INVALID_IMAGE";
      throw new ImageStorageError("The uploaded image could not be migrated safely.", code);
    }
    const parsed = JSON.parse(result.stdout);
    return {
      buffer: Buffer.from(parsed.bufferBase64, "base64"),
      mimeType: parsed.mimeType,
      width: parsed.width,
      height: parsed.height
    };
  }

  // Startup remains synchronous, but legacy rows still pass through the same
  // decoder, dimension check and strict byte ceiling via a short-lived worker.
  function saveImageIfInlineSync(css, filenameBase) {
    const match = INLINE_DATA_URL_PATTERN.exec(css || "");
    if (!match) return css;
    const [, _declaredMimeType, base64, suffix] = match;
    const processed = processImageBufferSync(Buffer.from(base64, "base64"));
    const extension = MIME_EXTENSIONS[processed.mimeType];
    const fileName = `${safeFilenameBase(filenameBase)}.${extension}`;
    ensureUploadsDir();
    fs.writeFileSync(path.join(resolvedDir, fileName), processed.buffer);
    return `url(/uploads/${fileName})${suffix}`;
  }

  function inspectAndOptimizeLocalFileSync(storageKey) {
    const currentPath = path.join(resolvedDir, path.basename(storageKey));
    const processed = processImageBufferSync(fs.readFileSync(currentPath));
    const filenameBase = path.basename(storageKey, path.extname(storageKey));
    const nextStorageKey = `${filenameBase}.${MIME_EXTENSIONS[processed.mimeType]}`;
    const nextPath = path.join(resolvedDir, nextStorageKey);
    fs.writeFileSync(nextPath, processed.buffer);
    if (nextPath !== currentPath) {
      try { fs.unlinkSync(currentPath); } catch (_error) { /* already absent */ }
    }
    return {
      storageKey: nextStorageKey,
      mimeType: processed.mimeType,
      byteSize: processed.buffer.length,
      width: processed.width,
      height: processed.height,
      sha256: digest(processed.buffer)
    };
  }

  function deleteFileIfLocal(css) {
    const match = LOCAL_FILE_URL_PATTERN.exec(css || "");
    if (!match) return;
    try {
      fs.unlinkSync(path.join(resolvedDir, path.basename(match[1])));
    } catch (_error) {
      // Already gone, or never existed.
    }
  }

  return {
    uploadsDir: resolvedDir,
    ensureUploadsDir,
    saveImageRecord,
    saveImageIfInline,
    saveImageIfInlineSync,
    inspectAndOptimizeLocalFileSync,
    recordForLocalCss,
    deleteFileIfLocal
  };
}

module.exports = {
  createImageStorage,
  DEFAULT_UPLOADS_DIR,
  MAX_IMAGE_BYTES,
  ImageStorageError
};
