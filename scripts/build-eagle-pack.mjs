import crypto from "node:crypto";
import path from "node:path";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import {
  QuantizerCelebi,
  Score,
  argbFromRgb,
  blueFromArgb,
  greenFromArgb,
  redFromArgb
} from "@material/material-color-utilities";
import sharp from "sharp";

const DEFAULT_PACK_NAME = "PVDex";
const DEFAULT_OUTPUT_DIR = path.resolve("build", DEFAULT_PACK_NAME);
const DEFAULT_INPUT_PATH = path.resolve("videos.json");
const DEFAULT_CONCURRENCY = 8;
const SHANGHAI_TZ = "Asia/Shanghai";

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const inputPath = path.resolve(getOption(options, "input") ?? DEFAULT_INPUT_PATH);
  const outputDir = path.resolve(getOption(options, "output") ?? DEFAULT_OUTPUT_DIR);
  const packName = getOption(options, "packName", "pack-name") ?? DEFAULT_PACK_NAME;
  const concurrency = Number.parseInt(
    getOption(options, "concurrency") ?? `${DEFAULT_CONCURRENCY}`,
    10
  );

  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`Invalid concurrency: ${options.concurrency}`);
  }

  const rawInput = await readFile(inputPath, "utf8");
  const entries = JSON.parse(rawInput.replace(/^\uFEFF/, ""));

  if (!Array.isArray(entries)) {
    throw new Error("Input JSON must be an array of video entries.");
  }

  await rm(outputDir, { force: true, recursive: true });
  await mkdir(outputDir, { recursive: true });

  const folderId = makeId(`folder:${packName}`);
  const images = [];
  let skipped = 0;

  let completed = 0;
  await runWithConcurrency(entries, concurrency, async (entry, index) => {
    try {
      const imageRecord = await buildEntryRecord({
        entry,
        outputDir,
        folderId
      });
      images[index] = imageRecord;
    } catch (error) {
      skipped += 1;
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`Warning: skipped ${entry.id} (${entry.title ?? "untitled"}): ${message}`);
    } finally {
      completed += 1;
      if (completed === entries.length || completed % 25 === 0) {
        console.log(`Processed ${completed}/${entries.length} items`);
      }
    }
  });

  const builtImages = images.filter(Boolean);

  const modificationTime = builtImages.reduce(
    (max, image) => Math.max(max, image.lastModified ?? image.modificationTime ?? 0),
    Date.now()
  );

  const packJson = {
    images: builtImages,
    folder: {
      id: folderId,
      name: packName,
      description: "",
      children: [],
      modificationTime,
      tags: [],
      extendTags: [],
      icon: "film",
      iconColor: "orange",
      pinyin: toPinyinKey(packName),
      password: "",
      passwordTips: ""
    }
  };

  await writeFile(path.join(outputDir, "pack.json"), JSON.stringify(packJson));

  console.log(`Wrote Eagle pack to ${outputDir}`);
  if (skipped > 0) {
    console.warn(`Warning: skipped ${skipped} item(s) due to build/download errors.`);
  }
}

function parseArgs(argv) {
  const options = {};

  for (let i = 0; i < argv.length; i += 1) {
    const current = argv[i];
    if (!current.startsWith("--")) {
      continue;
    }

    const key = current.slice(2);
    const value = argv[i + 1];
    if (value == null || value.startsWith("--")) {
      options[key] = "true";
      continue;
    }

    options[key] = value;
    i += 1;
  }

  return options;
}

function getOption(options, ...keys) {
  for (const key of keys) {
    if (options[key] != null) {
      return options[key];
    }
  }

  return undefined;
}

async function buildEntryRecord({ entry, outputDir, folderId }) {
  const metrics = parseJsonValue(entry.metrics, {});
  const tags = parseJsonValue(entry.tags, []);
  const website = buildWebsite(entry.bvid);
  const annotation = buildAnnotation(entry, metrics);
  const star = computeStar(entry.views);
  const timestamp = getTimestamp(entry.createdAt);
  const safeName = sanitizeWindowsName(entry.title, entry.id);

  const asset = await downloadCover(entry.cover, entry.id, safeName);
  const itemDir = path.join(outputDir, `${entry.id}.info`);
  await mkdir(itemDir, { recursive: true });
  await writeFile(path.join(itemDir, asset.fileName), asset.buffer);

  const imageRecord = {
    id: entry.id,
    name: safeName,
    size: asset.buffer.length,
    btime: timestamp,
    mtime: timestamp,
    ext: asset.ext,
    tags,
    folders: [folderId],
    isDeleted: false,
    url: website,
    annotation,
    star,
    modificationTime: timestamp,
    noThumbnail: true,
    width: asset.width,
    height: asset.height,
    lastModified: timestamp + 1,
    palettes: asset.palettes
  };

  await writeFile(path.join(itemDir, "metadata.json"), JSON.stringify(imageRecord));

  return imageRecord;
}

async function downloadCover(url, id, safeName) {
  const response = await fetch(url, {
    headers: {
      "user-agent": "pvdex-eaglepack-builder/1.0"
    }
  });

  if (!response.ok) {
    throw new Error(`Failed to download cover for ${id}: ${response.status} ${response.statusText}`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const image = sharp(buffer).rotate();
  const metadata = await image.metadata();

  if (!metadata.width || !metadata.height) {
    throw new Error(`Unable to infer dimensions for ${id} from ${url}`);
  }

  const ext = normalizeExt(metadata.format, url, response.headers.get("content-type"));
  const fileName = `${safeName}.${ext}`;
  const palettes = await extractPalettes(buffer);

  return {
    buffer,
    ext,
    fileName,
    width: metadata.width,
    height: metadata.height,
    palettes
  };
}

async function extractPalettes(buffer) {
  const { data } = await sharp(buffer)
    .rotate()
    .ensureAlpha()
    .resize({
      width: 64,
      height: 64,
      fit: "inside",
      withoutEnlargement: true
    })
    .raw()
    .toBuffer({ resolveWithObject: true });

  const pixels = [];

  for (let index = 0; index < data.length; index += 4) {
    const alpha = data[index + 3];
    if (alpha < 16) {
      continue;
    }

    pixels.push(argbFromRgb(data[index], data[index + 1], data[index + 2]));
  }

  if (pixels.length === 0) {
    return [];
  }

  const quantized = QuantizerCelebi.quantize(pixels, 16);
  const ranked = Score.score(quantized, {
    desired: 10,
    filter: false
  });

  const fallbackByPopulation = [...quantized.entries()]
    .sort((left, right) => right[1] - left[1])
    .map(([argb]) => argb);
  const orderedColors = [...new Set([...ranked, ...fallbackByPopulation])].slice(0, 10);

  return orderedColors.map((argb) => ({
    color: [redFromArgb(argb), greenFromArgb(argb), blueFromArgb(argb)],
    ratio: simplifyNumber(((quantized.get(argb) ?? 0) / pixels.length) * 100)
  }));
}

function buildAnnotation(entry, metrics) {
  const lines = [
    `Release Date: ${formatReleaseDate(entry.createdAt, metrics.pubdate)}`,
    `Author: ${metrics.pvAuthor || entry.author || ""}`,
    `Graphics: ${formatGraphics(metrics.graphics)}`,
    "Description:",
    entry.desc || ""
  ];

  return lines.join("\n").trim();
}

function buildWebsite(bvid) {
  if (typeof bvid !== "string" || bvid.length === 0) {
    return "";
  }

  if (bvid.startsWith("BV")) {
    return `https://www.bilibili.com/video/${bvid}`;
  }

  if (bvid.startsWith("YT_")) {
    return `https://www.youtube.com/watch?v=${bvid.slice(3)}`;
  }

  return `https://www.youtube.com/watch?v=${bvid}`;
}

function computeStar(views) {
  const safeViews = Math.max(1, Number(views) || 0);
  const logViews = Math.max(0, Math.min(6, Math.log10(safeViews)));
  return Math.max(0, Math.min(5, Math.round((logViews / 6) * 5)));
}

function formatReleaseDate(createdAt, pubdate) {
  if (Number.isFinite(pubdate)) {
    return formatDate(new Date(pubdate * 1000));
  }

  if (typeof pubdate === "string" && pubdate.trim() !== "" && Number.isFinite(Number(pubdate))) {
    return formatDate(new Date(Number(pubdate) * 1000));
  }

  if (createdAt) {
    return formatDate(new Date(createdAt));
  }

  return formatDate(new Date());
}

function formatDate(date) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: SHANGHAI_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(date);
}

function formatGraphics(graphics) {
  const numeric = Number(graphics);
  return Number.isFinite(numeric) ? numeric : 0;
}

function getTimestamp(createdAt) {
  if (createdAt) {
    const timestamp = new Date(createdAt).getTime();
    if (Number.isFinite(timestamp)) {
      return timestamp;
    }
  }

  return Date.now();
}

function parseJsonValue(raw, fallback) {
  if (raw == null || raw === "") {
    return fallback;
  }

  if (typeof raw !== "string") {
    return raw;
  }

  try {
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function normalizeExt(format, url, contentType) {
  const formatMap = {
    jpeg: "jpg",
    jpg: "jpg",
    png: "png",
    webp: "webp",
    gif: "gif",
    avif: "avif",
    tif: "tif",
    tiff: "tif"
  };

  if (format && formatMap[format]) {
    return formatMap[format];
  }

  if (contentType) {
    const type = contentType.split(";")[0].trim().toLowerCase();
    const contentTypeMap = {
      "image/jpeg": "jpg",
      "image/jpg": "jpg",
      "image/png": "png",
      "image/webp": "webp",
      "image/gif": "gif",
      "image/avif": "avif",
      "image/tiff": "tif"
    };
    if (contentTypeMap[type]) {
      return contentTypeMap[type];
    }
  }

  try {
    const pathname = new URL(url).pathname;
    const ext = path.extname(pathname).replace(/^\./, "").toLowerCase();
    if (ext) {
      return ext === "jpeg" ? "jpg" : ext;
    }
  } catch {
    return "jpg";
  }

  return "jpg";
}

function sanitizeWindowsName(name, fallbackName = "cover") {
  const invisibleChars =
    /[\u0000-\u001F\u007F<>:"/\\|?*\u00A0\u200B-\u200F\u202A-\u202E\u2060-\u206F\uFEFF]/g;

  let sanitized = `${name || fallbackName}`
    .replace(invisibleChars, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[. ]+$/g, "");

  if (!sanitized) {
    sanitized = `${fallbackName || "cover"}`
      .replace(invisibleChars, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/[. ]+$/g, "");
  }

  if (!sanitized) {
    sanitized = "cover";
  }

  const reservedNames = new Set([
    "CON",
    "PRN",
    "AUX",
    "NUL",
    "COM1",
    "COM2",
    "COM3",
    "COM4",
    "COM5",
    "COM6",
    "COM7",
    "COM8",
    "COM9",
    "LPT1",
    "LPT2",
    "LPT3",
    "LPT4",
    "LPT5",
    "LPT6",
    "LPT7",
    "LPT8",
    "LPT9"
  ]);

  if (reservedNames.has(sanitized.toUpperCase())) {
    sanitized = `_${sanitized}`;
  }

  return sanitized.slice(0, 120);
}

function simplifyNumber(value) {
  return Number(value.toFixed(2).replace(/\.?0+$/, ""));
}

function toPinyinKey(name) {
  const key = `${name}`.toUpperCase().replace(/[^A-Z0-9]/g, "");
  return key || "PVDEX";
}

function makeId(seed) {
  return crypto
    .createHash("sha1")
    .update(seed)
    .digest("base64")
    .replace(/[^A-Z0-9]/gi, "")
    .toUpperCase()
    .slice(0, 13)
    .padEnd(13, "0");
}

async function runWithConcurrency(items, concurrency, worker) {
  let cursor = 0;
  const runners = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (true) {
      const index = cursor;
      cursor += 1;

      if (index >= items.length) {
        return;
      }

      await worker(items[index], index);
    }
  });

  await Promise.all(runners);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
