const APP_VERSION = "v0.1.0"; // manually update this
document.getElementById("pageVersion").textContent = APP_VERSION;


* global ExifReader, JSZip */

const elFiles = document.getElementById("files");
const elProcess = document.getElementById("process");
const elZip = document.getElementById("downloadZip");
const elResults = document.getElementById("results");
const elStatus = document.getElementById("status");

const elTsSource = document.getElementById("tsSource");
const elOutFormat = document.getElementById("outFormat");
const elTsStyle = document.getElementById("tsStyle");
const elSizePct = document.getElementById("sizePct");
const elMarginPct = document.getElementById("marginPct");
const elOrange = document.getElementById("orange");

let processed = []; // { name, blob, url }

elFiles.addEventListener("change", () => {
  processed = [];
  elResults.innerHTML = "";
  elStatus.textContent = "";
  elProcess.disabled = !(elFiles.files && elFiles.files.length);
  elZip.disabled = true;
});

elProcess.addEventListener("click", async () => {
  if (!elFiles.files?.length) return;
  processed = [];
  elResults.innerHTML = "";
  elZip.disabled = true;

  const files = Array.from(elFiles.files);
  elProcess.disabled = true;

  try {
    for (let i = 0; i < files.length; i++) {
      elStatus.textContent = `Processing ${i + 1}/${files.length}…`;
      const out = await stampOne(files[i]);
      processed.push(out);
      addResultCard(out);
    }
    elStatus.textContent = `Done. Processed ${files.length} file(s).`;
    elZip.disabled = processed.length === 0;
  } catch (err) {
    console.error(err);
    elStatus.textContent = `Error: ${err?.message ?? String(err)}`;
  } finally {
    elProcess.disabled = false;
  }
});

elZip.addEventListener("click", async () => {
  if (!processed.length) return;
  elZip.disabled = true;
  elStatus.textContent = "Building ZIP…";

  try {
    const zip = new JSZip();
    for (const item of processed) zip.file(item.name, item.blob);
    const zipBlob = await zip.generateAsync({ type: "blob" });
    downloadBlob(zipBlob, "stamped_images.zip");
    elStatus.textContent = "ZIP downloaded.";
  } catch (err) {
    console.error(err);
    elStatus.textContent = `ZIP error: ${err?.message ?? String(err)}`;
  } finally {
    elZip.disabled = false;
  }
});

async function stampOne(file) {
  const buffer = await file.arrayBuffer();

  // Read EXIF (date + orientation)
  let tags = null;
  try {
    tags = ExifReader.load(buffer, { expanded: true });
  } catch {
    tags = null;
  }

  const orientation =
    tags?.exif?.Orientation?.value ??
    tags?.exif?.Orientation?.description ??
    1;

  const timestampDate = pickTimestampDate(file, tags);
  const stampText = formatStamp(timestampDate, elTsStyle.value);

  // Decode image
  const inType = file.type || "application/octet-stream";
  const imgBlob = new Blob([buffer], { type: inType });
  const bitmap = await createImageBitmap(imgBlob);

  // Prepare canvas with orientation correction
  const { canvas, ctx, drawW, drawH } = makeCanvasForOrientation(bitmap, orientation);

  // Draw image
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, drawW, drawH);

  // Draw timestamp
  drawTimestamp(ctx, canvas.width, canvas.height, stampText);

  // Export
  const { outType, outExt, jpegQuality } = pickOutputFormat(inType, elOutFormat.value);

  const outBlob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Failed to encode output image."))),
      outType,
      jpegQuality
    );
  });

  const outName = replaceExtension(file.name, outExt);
  const outUrl = URL.createObjectURL(outBlob);

  // Cleanup
  bitmap.close?.();

  return { name: outName, blob: outBlob, url: outUrl };
}

function pickTimestampDate(file, tags) {
  const source = elTsSource.value;

  if (source === "now") return new Date();
  if (source === "modified") return new Date(file.lastModified);

  // EXIF preferred
  const exifStr =
    tags?.exif?.DateTimeOriginal?.description ||
    tags?.exif?.DateTimeOriginal?.value ||
    tags?.exif?.DateTime?.description ||
    tags?.exif?.DateTime?.value ||
    null;

  const parsed = exifStr ? parseExifDate(exifStr) : null;
  return parsed || new Date(file.lastModified);
}

// Typical EXIF date is "YYYY:MM:DD HH:MM:SS"
function parseExifDate(s) {
  if (typeof s !== "string") return null;
  const m = s.match(/^(\d{4})[:\-](\d{2})[:\-](\d{2})\s+(\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [_, Y, M, D, h, min, sec] = m;
  const dt = new Date(
    Number(Y),
    Number(M) - 1,
    Number(D),
    Number(h),
    Number(min),
    Number(sec || "0")
  );
  return Number.isNaN(dt.getTime()) ? null : dt;
}

function formatStamp(dt, style) {
  const pad = (n) => String(n).padStart(2, "0");
  const YYYY = dt.getFullYear();
  const YY = String(YYYY).slice(-2);
  const MM = pad(dt.getMonth() + 1);
  const DD = pad(dt.getDate());
  const HH = pad(dt.getHours());
  const mm = pad(dt.getMinutes());

  if (style === "ddmmyy") return `${DD}/${MM}/${YY} ${HH}:${mm}`;
  if (style === "iso") return `${YYYY}-${MM}-${DD} ${HH}:${mm}`;
  return `${MM}/${DD}/${YY} ${HH}:${mm}`; // mmddyy
}

function drawTimestamp(ctx, w, h, text) {
  const sizePct = clamp(Number(elSizePct.value) || 4.5, 1, 12) / 100;
  const marginPct = clamp(Number(elMarginPct.value) || 2.0, 0, 10) / 100;

  const fontSize = Math.max(12, Math.round(w * sizePct));
  const margin = Math.round(w * marginPct);
  const color = (elOrange.value || "#ff8a00").trim();

  ctx.save();

  // “Digital camera-ish” look: monospace + strong contrast outline
  ctx.font = `${fontSize}px "VT323", ui-monospace, Menlo, Consolas, Monaco, monospace`;
  ctx.textBaseline = "alphabetic";

  const metrics = ctx.measureText(text);
  const x = w - margin - metrics.width;
  const y = h - margin;

  // Dark outline
  ctx.lineWidth = Math.max(2, Math.round(fontSize * 0.12));
  ctx.strokeStyle = "rgba(0,0,0,0.85)";
  ctx.strokeText(text, x, y);

  // Orange fill
  ctx.fillStyle = color;
  ctx.shadowColor = "rgba(0,0,0,0.35)";
  ctx.shadowBlur = Math.max(1, Math.round(fontSize * 0.08));
  ctx.fillText(text, x, y);

  ctx.restore();
}

function pickOutputFormat(inType, choice) {
  const isJpeg = /image\/jpeg/i.test(inType) || /image\/jpg/i.test(inType);
  const isPng = /image\/png/i.test(inType);

  if (choice === "png") return { outType: "image/png", outExt: "png", jpegQuality: undefined };
  if (choice === "jpeg") return { outType: "image/jpeg", outExt: "jpg", jpegQuality: 1.0 };

  // same as input (fallback to PNG if unknown)
  if (isPng) return { outType: "image/png", outExt: "png", jpegQuality: undefined };
  if (isJpeg) return { outType: "image/jpeg", outExt: "jpg", jpegQuality: 1.0 };
  return { outType: "image/png", outExt: "png", jpegQuality: undefined };
}

function replaceExtension(filename, newExt) {
  const base = filename.replace(/\.[^/.]+$/, "");
  return `${base}_stamped.${newExt}`;
}

function addResultCard(item) {
  const card = document.createElement("div");
  card.className = "card";

  const img = document.createElement("img");
  img.src = item.url;
  img.alt = item.name;

  const a = document.createElement("a");
  a.href = item.url;
  a.download = item.name;
  a.textContent = `Download: ${item.name}`;

  card.appendChild(img);
  card.appendChild(a);
  elResults.appendChild(card);
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
async function ensureFontLoaded(family, px = 32) {
  if (!document.fonts) return; // older browsers fallback
  await document.fonts.load(`${px}px "${family}"`);
  await document.fonts.ready;
}


/**
 * Create a canvas and apply EXIF orientation transforms.
 * Returns { canvas, ctx, drawW, drawH } where drawW/drawH are bitmap draw dimensions after transform.
 */
function makeCanvasForOrientation(bitmap, orientation) {
  const w = bitmap.width;
  const h = bitmap.height;

  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");

  // Orientations 5-8 swap width/height
  const swap = [5, 6, 7, 8].includes(Number(orientation));
  canvas.width = swap ? h : w;
  canvas.height = swap ? w : h;

  ctx.save();
  applyExifOrientationTransform(ctx, Number(orientation) || 1, w, h, canvas.width, canvas.height);

  // After transform, draw bitmap into the transformed coordinate space:
  // For swapped cases we still draw with original w/h, because transform maps it.
  const drawW = w;
  const drawH = h;

  // Restore is done by caller after draw? We keep it transformed for immediate draw.
  // Caller will draw, then ctx remains transformed; so we must not restore yet.
  // We will NOT restore here; caller draws image and stamp in displayed orientation (no need for EXIF coords).
  // To stamp in final coords, we should stamp AFTER resetting transform.
  // Therefore: we do draw in transformed space, then reset transform back for stamping.

  // We'll return with ctx transformed; caller must reset before stamping.
  return {
    canvas,
    ctx,
    drawW,
    drawH,
    resetForStamp: () => { ctx.restore(); }
  };
}

function applyExifOrientationTransform(ctx, o, w, h, cw, ch) {
  // Based on common EXIF orientation mappings used in browser canvas pipelines.
  switch (o) {
    case 2: // mirror horizontal
      ctx.translate(cw, 0);
      ctx.scale(-1, 1);
      break;
    case 3: // rotate 180
      ctx.translate(cw, ch);
      ctx.rotate(Math.PI);
      break;
    case 4: // mirror vertical
      ctx.translate(0, ch);
      ctx.scale(1, -1);
      break;
    case 5: // mirror horizontal + rotate 90 CW
      ctx.rotate(0.5 * Math.PI);
      ctx.scale(1, -1);
      break;
    case 6: // rotate 90 CW
      ctx.translate(cw, 0);
      ctx.rotate(0.5 * Math.PI);
      break;
    case 7: // mirror horizontal + rotate 90 CCW
      ctx.translate(cw, ch);
      ctx.rotate(0.5 * Math.PI);
      ctx.scale(-1, 1);
      break;
    case 8: // rotate 90 CCW
      ctx.translate(0, ch);
      ctx.rotate(-0.5 * Math.PI);
      break;
    default:
      // 1: no transform
      break;
  }
}

// Patch: we must reset transform before stamping (so stamp uses final displayed coords).
// We wrap stampOne to call resetForStamp after drawing the image.
const _stampOne = stampOne;
stampOne = async function(file) {
  const buffer = await file.arrayBuffer();
  let tags = null;
  try { tags = ExifReader.load(buffer, { expanded: true }); } catch { tags = null; }

  const orientation = tags?.exif?.Orientation?.value ?? 1;
  const timestampDate = pickTimestampDate(file, tags);
  const stampText = formatStamp(timestampDate, elTsStyle.value);

  const inType = file.type || "application/octet-stream";
  const imgBlob = new Blob([buffer], { type: inType });
  const bitmap = await createImageBitmap(imgBlob);

  const { canvas, ctx, drawW, drawH, resetForStamp } = makeCanvasForOrientation(bitmap, orientation);

  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(bitmap, 0, 0, drawW, drawH);

  // Reset transform so (0,0) is top-left of final image for stamping
  resetForStamp();

  await ensureFontLoaded("VT323", 48);


  drawTimestamp(ctx, canvas.width, canvas.height, stampText);

  const { outType, outExt, jpegQuality } = pickOutputFormat(inType, elOutFormat.value);
  const outBlob = await new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("Failed to encode output image."))),
      outType,
      jpegQuality
    );
  });

  const outName = replaceExtension(file.name, outExt);
  const outUrl = URL.createObjectURL(outBlob);
  bitmap.close?.();

  return { name: outName, blob: outBlob, url: outUrl };
};

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}
