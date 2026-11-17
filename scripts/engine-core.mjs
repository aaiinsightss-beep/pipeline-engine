// Shared upload engine: master -> Google Drive with rclone, 1080p review copy + poster -> R2.
// The clip goes live as soon as the proxy is on R2; the master keeps uploading to Drive in parallel.
// Used by upload.mjs (CLI) and engine.mjs (website upload lane).
import { spawn } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, statSync, mkdtempSync, rmSync, mkdirSync, copyFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { basename, join, dirname, extname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
export const CONFIG_PATH = process.env.PIPELINE_CONFIG || join(HERE, "pipeline.config.json"); // override to point at another site (e.g. local dev)
export const TMP_ROOT = join(HERE, "..", ".engine-tmp"); // on the project drive, not C:
const R2_PART = 50 * 1024 * 1024; // under the Worker's 100 MB body limit, over R2's 5 MiB minimum
const R2_PARALLEL = 6;

export const loadConfig = () => (existsSync(CONFIG_PATH) ? JSON.parse(readFileSync(CONFIG_PATH, "utf8")) : null);
export const saveConfig = (cfg) => writeFileSync(CONFIG_PATH, JSON.stringify(cfg, null, 2));
export const mb = (n) => `${(n / 1024 / 1024).toFixed(1)} MB`;
export const remote = (cfg) => cfg.driveRemote || "quest_drive"; // the default rclone Drive remote

export function makeApi(cfg) {
  return async function api(path, opts = {}) {
    const res = await fetch(cfg.url + path, {
      method: opts.method || "GET",
      headers: { authorization: `Bearer ${cfg.adminKey}`, ...(opts.json ? { "content-type": "application/json" } : {}) },
      body: opts.json ? JSON.stringify(opts.json) : opts.body,
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`${path}: ${data.error || res.status}`);
    return data;
  };
}

export function run(cmd, args, { capture = false, onStdout, onStderr, env } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { env, stdio: ["ignore", capture || onStdout ? "pipe" : "ignore", "pipe"] });
    let out = "", err = "";
    p.stdout?.on("data", (d) => { out += d; onStdout?.(String(d)); });
    p.stderr.on("data", (d) => { err = (err + d).slice(-2000); onStderr?.(String(d)); });
    p.on("error", (e) => reject(new Error(`${cmd} not found. Install it and add it to PATH. (${e.message})`)));
    p.on("close", (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} failed (${code}): ${err.trim().split("\n").pop()}`))));
  });
}

// review-lab's proxy recipe: 1080p (long side <=1920), NVENC p5 4 Mbps, keyframe every 2 s for fast seeking; x264 fallback.
const ENCODERS = {
  h264_nvenc: ["-c:v", "h264_nvenc", "-preset", "p5", "-b:v", "4000k", "-maxrate", "6000k", "-bufsize", "12000k"],
  h264_videotoolbox: ["-c:v", "h264_videotoolbox", "-b:v", "4000k", "-maxrate", "6000k"], // Mac (Apple Silicon / Intel) hardware encoder
  libx264: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-maxrate", "6000k", "-bufsize", "12000k"],
};
export async function pickEncoder(cfg) {
  if (cfg.encoder && ENCODERS[cfg.encoder]) return cfg.encoder;
  for (const name of Object.keys(ENCODERS)) {
    try {
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-f", "lavfi", "-i", "testsrc2=size=1280x720:duration=0.5", ...ENCODERS[name], "-f", "null", "-"]);
      cfg.encoder = name;
      saveConfig(cfg);
      return name;
    } catch { /* try the next one */ }
  }
  throw new Error("No working H.264 encoder in FFmpeg");
}

export async function probe(file) {
  const p = JSON.parse(await run("ffprobe", ["-v", "error", "-show_entries",
    "stream=codec_type,codec_name,width,height,r_frame_rate,pix_fmt,bit_rate,field_order,sample_rate,channels:stream_side_data=rotation:format=duration,bit_rate,size", "-of", "json", file], { capture: true }));
  const v = p.streams?.find((x) => x.codec_type === "video"), a = p.streams?.find((x) => x.codec_type === "audio");
  if (!v?.width) throw new Error("No video stream found in that file");
  const [num, den] = String(v.r_frame_rate || "30/1").split("/").map(Number);
  const rot = Math.abs(Number(v.side_data_list?.find((d) => d.rotation != null)?.rotation) || 0);
  const [width, height] = rot === 90 || rot === 270 ? [v.height, v.width] : [v.width, v.height]; // phone videos shot upright
  return { width, height, duration: Number(p.format?.duration) || 0, fps: num / (den || 1) || 30,
    src: { vcodec: v.codec_name, pix: v.pix_fmt, vbps: Number(v.bit_rate) || Number(p.format?.bit_rate) || 0, field: v.field_order || "progressive",
      acodec: a?.codec_name ?? null, rate: Number(a?.sample_rate) || 0, ch: Number(a?.channels) || 0, size: Number(p.format?.size) || 0, rot } };
}

// Can Instagram take this file as it is (the original, untouched picture)? Meta's Reel spec: H.264 or HEVC, 4:2:0,
// progressive, width <= 1920, 23-60 fps, video <= 25 Mbps, <= 300 MB, 3 s - 15 min. Audio is always re-encoded to
// AAC 128 kbps 48 kHz (cheap, and Meta's audio cap), so only the picture decides.
export function igReady(meta) {
  const s = meta?.src;
  if (!s) return false;
  return ["h264", "hevc"].includes(s.vcodec) && /^yuvj?420p$/.test(s.pix || "") && (s.field === "progressive" || s.field === "unknown")
    && Math.min(meta.width, meta.height) <= 1920 && Math.max(meta.width, meta.height) <= 3840 && meta.width <= 1920
    && meta.fps >= 23 && meta.fps <= 60 && s.vbps > 0 && s.vbps <= 24.5e6 && s.size > 0 && s.size <= 290e6
    && meta.duration >= 3 && meta.duration <= 900 && !s.rot;
}
// Copy the picture bit for bit into a clean MP4 (moov first, no edit lists); only the audio is converted.
export function remuxArgs(src, out, meta) {
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0?", "-c:v", "copy",
    ...(meta.src?.vcodec === "hevc" ? ["-tag:v", "hvc1"] : []),
    "-c:a", "aac", "-b:a", "128k", "-ar", "48000", "-ac", "2", "-movflags", "+faststart", "-use_editlist", "0", "-progress", "pipe:1", "-nostats", out];
}

async function retry(fn, what, log) {
  for (let i = 1; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= 4) throw e;
      log?.(`${what} failed (${e.message}), retrying in ${i * 2}s`);
      await new Promise((r) => setTimeout(r, i * 2000));
    }
  }
}

// Master -> Drive exactly like review-lab's bg-master.mjs (rclone copyto, 256M chunks, retries). Returns the Drive file id.
// We read the id with lsjson instead of `rclone link`, so the client's master is NOT made public.
async function uploadMaster(cfg, file, drivePath, onPct) {
  const dest = `${remote(cfg)}:${drivePath}`;
  await run("rclone", ["copyto", file, dest, "--drive-chunk-size", "256M", "--drive-upload-cutoff", "16M",
    "--retries", "5", "--low-level-retries", "20", "--stats", "1s", "--stats-one-line", "--stats-log-level", "NOTICE"], {
    // rclone counts bytes it has read, not what Drive confirmed: never show 100% before rclone says it's done
    onStderr: (s) => { const m = /(\d+)%/.exec(s.split("\n").filter(Boolean).pop() || ""); if (m) onPct(Math.min(0.99, Number(m[1]) / 100)); },
  }).catch((e) => {
    throw /Quota exceeded|rateLimitExceeded|userRateLimitExceeded/i.test(e.message)
      ? new Error("Google Drive is rate-limiting rclone's shared login (use your own Google client ID, see README)") : e;
  });
  const info = JSON.parse(await run("rclone", ["lsjson", "--stat", "--no-modtime", dest], { capture: true }));
  if (!info?.ID) throw new Error(`rclone uploaded but returned no Drive id for ${drivePath}`);
  onPct(1);
  return info.ID;
}

// Straight to R2 over its S3 API with rclone (review-lab's method, much faster than 50 MB parts through the Worker)
// when pipeline.config.json has an "r2" key; through the Worker otherwise, or if the direct upload fails.
const R2_REMOTE = "PIPER2"; // not a single letter: Windows would read "X:" as a drive
function r2Env(cfg) {
  const r = cfg.r2;
  if (!r?.accountId || !r.accessKeyId || !r.secretAccessKey) return null;
  const K = (n) => `RCLONE_CONFIG_${R2_REMOTE}_${n}`;
  return { ...process.env, [K("TYPE")]: "s3", [K("PROVIDER")]: "Cloudflare", [K("ACCESS_KEY_ID")]: r.accessKeyId, [K("SECRET_ACCESS_KEY")]: r.secretAccessKey,
    [K("ENDPOINT")]: `https://${r.accountId}.r2.cloudflarestorage.com`, [K("NO_CHECK_BUCKET")]: "true" };
}
// bucket: what the site picked; the "r2" config is bucket 1, so bucket 2 (bucket 1 full) always goes through the site.
async function sendToR2({ cfg, api, file, key, partsPath, onBytes, log, bucket = 1 }) {
  const env = bucket === 1 ? r2Env(cfg) : null;
  if (env) {
    const total = statSync(file).size;
    try {
      await run("rclone", ["copyto", file, `${R2_REMOTE}:${cfg.r2.bucket || "pipeline-proxies"}/${key}`, "--s3-upload-concurrency", "8", "--s3-chunk-size", "16M",
        "--retries", "3", "--stats", "1s", "--stats-one-line", "--stats-log-level", "NOTICE"], {
        env, onStderr: (s) => { const m = /(\d+)%/.exec(s.split("\n").filter(Boolean).pop() || ""); if (m) onBytes((total * Number(m[1])) / 100); },
      });
      onBytes(total);
      return { direct: true };
    } catch (e) { log(`direct R2 upload failed (${e.message}); sending through the site instead`); }
  }
  return { parts: await uploadParts(api, partsPath, file, onBytes, log) };
}

// A master Drive refused is parked here (never lost with the engine's temp files) and retried: at engine start and
// every 30 minutes. <versionId>.json says where it goes; once it's up, the site gets its Drive id.
const PARKED = join(TMP_ROOT, "pending-drive");
function parkMaster(file, versionId, drivePath) {
  mkdirSync(PARKED, { recursive: true });
  const dest = join(PARKED, `${versionId}${extname(file)}`);
  copyFileSync(file, dest);
  writeFileSync(join(PARKED, `${versionId}.json`), JSON.stringify({ versionId, drivePath, file: dest }));
}
let retrying = false;
export async function retryParked(cfg, log = console.log) {
  if (retrying || !existsSync(PARKED)) return;
  retrying = true;
  try {
    const api = makeApi(cfg);
    for (const f of readdirSync(PARKED).filter((x) => x.endsWith(".json"))) {
      const job = JSON.parse(readFileSync(join(PARKED, f), "utf8"));
      try {
        const id = await uploadMaster(cfg, job.file, job.drivePath, () => {});
        await api(`/api/admin/versions/${job.versionId}/master`, { method: "POST", json: { drive_file_id: id } });
        rmSync(job.file, { force: true }); rmSync(join(PARKED, f), { force: true });
        log(`  ✔ master now on Drive: ${job.drivePath}`);
      } catch (e) { log(`  … master still waiting for Drive (${e.message}): ${job.drivePath}`); }
    }
  } finally { retrying = false; }
}

async function uploadParts(api, partsPath, file, onBytes, log) {
  const total = statSync(file).size;
  const count = Math.ceil(total / R2_PART);
  const fh = await open(file, "r");
  const parts = new Array(count);
  let next = 0, done = 0;
  try {
    const worker = async () => {
      while (next < count) {
        const i = next++;
        const offset = i * R2_PART, len = Math.min(R2_PART, total - offset);
        const buf = Buffer.alloc(len);
        await fh.read(buf, 0, len, offset);
        parts[i] = await retry(() => api(`${partsPath}/${i + 1}`, { method: "PUT", body: buf }), "Upload part", log);
        onBytes((done += len));
      }
    };
    await Promise.all(Array.from({ length: Math.min(R2_PARALLEL, count) }, worker));
  } finally { await fh.close(); }
  return parts;
}

// ---------- HQ post file for Instagram ----------
// Meta's Reel spec: MP4, H.264 progressive, closed GOP, 4:2:0, 23-60 fps, width <= 1920, VBR <= 25 Mbps,
// AAC 48 kHz <= 128 kbps, moov at the front, no edit lists, <= 300 MB, 3 s - 15 min.
// The review proxy streams fast; this is ~16 Mbps (peaks to 24, under Meta's 25 Mbps cap) so Instagram's own re-encode
// starts from a near-lossless 1080p file, the same as uploading the export from a phone.
// bps: a fixed bitrate (the review copy); without it, Instagram's size-capped target.
export function postEncodeArgs(src, out, meta, encoder, preset = "slow", bps) {
  const dur = Math.max(1, meta.duration || 1);
  const target = bps || Math.max(2e6, Math.min(16e6, Math.floor((270e6 * 8) / dur - 200e3))); // stay under 300 MB on long clips
  const max = Math.min(24e6, Math.floor(target * 1.5));
  const fps = meta.fps > 60 ? 60 : meta.fps < 23 ? 30 : null;
  const gop = String(Math.max(1, Math.round((fps || meta.fps || 30) * 2)));
  const video = encoder === "h264_nvenc"
    ? ["-c:v", "h264_nvenc", "-preset", "p7", "-tune", "hq", "-rc", "vbr", "-cq", bps ? "19" : "17", "-b:v", String(target), "-maxrate", String(max), "-bufsize", String(max * 2),
       "-spatial-aq", "1", "-temporal-aq", "1", "-bf", "2", "-strict_gop", "1", "-forced-idr", "1"]
    : ["-c:v", "libx264", "-preset", preset, "-crf", bps ? "17" : "16", "-maxrate", String(max), "-bufsize", String(max * 2), "-x264-params", "open-gop=0"];
  return ["-hide_banner", "-loglevel", "error", "-y", "-i", src, "-map", "0:v:0", "-map", "0:a:0?",
    "-vf", "scale='if(gte(iw,ih),min(1920,iw),-2)':'if(gte(iw,ih),-2,min(1920,ih))':flags=lanczos,format=yuv420p",
    ...(fps ? ["-r", String(fps)] : []), ...video, "-g", gop, "-profile:v", "high", "-pix_fmt", "yuv420p",
    "-c:a", "aac", "-b:a", "120k", "-ar", "48000", "-ac", "2", // Meta caps Reel audio at 128 kbps; ffmpeg overshoots a little
    "-movflags", "+faststart", "-use_editlist", "0", "-progress", "pipe:1", "-nostats", out];
}

async function makePostFile({ cfg, api, clipId, versionId, src, meta, encoder, preset, tmp, emit, log }) {
  const out = join(tmp, "post.mp4");
  // Best quality Instagram can get: the original picture itself when it already fits the Reel spec.
  const copy = igReady(meta);
  if (copy) log(`HQ file: original picture kept (${meta.src.vcodec}, ${(meta.src.vbps / 1e6).toFixed(1)} Mbps)`);
  await run("ffmpeg", copy ? remuxArgs(src, out, meta) : postEncodeArgs(src, out, meta, encoder, preset), {
    onStdout: (s) => {
      const us = /out_time_us=(\d+)/.exec(s)?.[1];
      if (us && meta.duration) emit({ postEncode: Math.min(1, Number(us) / 1e6 / meta.duration) });
    },
  });
  const size = statSync(out).size;
  if (size > 295e6) throw new Error(`HQ file is ${mb(size)}, over Instagram's 300 MB limit`);
  emit({ postEncode: 1, postTotal: size, stage: "HQ file → R2", postOriginal: copy });
  const { bucket } = await api(`/api/admin/versions/${versionId}/post`, { method: "POST", json: {} });
  const sent = await sendToR2({ cfg, api, file: out, key: `posts/${clipId}/${versionId}.mp4`, partsPath: `/api/admin/versions/${versionId}/post/parts`, onBytes: (b) => emit({ postUp: b }), log, bucket });
  await api(`/api/admin/versions/${versionId}/post/complete`, { method: "POST", json: sent });
  emit({ postUp: size, postDone: true });
  return size;
}

// "Make HQ file" for a version uploaded before HQ files existed: pull the master back from Drive by id.
export async function processHq({ cfg, versionId, onProgress = () => {}, log = () => {} }) {
  const api = makeApi(cfg);
  const state = { stage: "fetching master from Drive", download: 0, postEncode: 0, postUp: 0, postTotal: 0 };
  const emit = (patch) => { Object.assign(state, patch); onProgress({ ...state }); };
  emit({});
  const v = await api(`/api/admin/versions/${versionId}`);
  if (!v.drive_file_id) throw new Error("This version has no Drive master yet");
  const encoder = await pickEncoder(cfg);
  mkdirSync(TMP_ROOT, { recursive: true });
  const tmp = mkdtempSync(join(TMP_ROOT, "hq-"));
  try {
    await run("rclone", ["backend", "copyid", `${remote(cfg)}:`, v.drive_file_id, `${tmp}/`, "--stats", "1s", "--stats-one-line", "--stats-log-level", "NOTICE"], {
      onStderr: (s) => { const m = /(\d+)%/.exec(s.split("\n").filter(Boolean).pop() || ""); if (m) emit({ download: Number(m[1]) / 100 }); },
    });
    const src = readdirSync(tmp).map((f) => join(tmp, f)).find((f) => statSync(f).isFile());
    if (!src) throw new Error("Drive download produced no file");
    emit({ download: 1, stage: "encoding HQ file" });
    const meta = await probe(src);
    const size = await makePostFile({ cfg, api, clipId: v.clip_id, versionId, src, meta, encoder, tmp, emit, log });
    emit({ stage: "done" });
    return { n: v.n, size };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Upload one file as a new version of clipId.
 * onProgress({ stage, encode, proxy, proxyTotal, drive, live, n, encoder, drivePath }) — fractions 0..1 except proxy bytes.
 */
// onLive fires once the client can watch: Engine.bat starts the next file then, while this one's master keeps going.
export async function processUpload({ cfg, file, clipId, onProgress = () => {}, log = () => {}, onLive = () => {} }) {
  const api = makeApi(cfg);
  const state = { stage: "probing", encode: 0, drive: 0, proxy: 0, proxyTotal: 0, live: false, masterSize: statSync(file).size };
  const emit = (patch) => { Object.assign(state, patch); onProgress({ ...state }); };
  emit({});

  const [meta, encoder] = await Promise.all([probe(file), pickEncoder(cfg)]);
  const v = await api(`/api/admin/clips/${clipId}/versions`, { method: "POST", json: { file_name: basename(file), ...meta } });
  emit({ stage: "uploading", n: v.n, encoder, drivePath: v.drive_path });

  mkdirSync(TMP_ROOT, { recursive: true });
  const tmp = mkdtempSync(join(TMP_ROOT, "job-"));
  try {
    // Review copy first, master after (review-lab's order): a 4K master uploading at the same time would take most of
    // the upload bandwidth and make the client wait longer for the preview.
    const livePromise = (async () => {
      const proxy = join(tmp, "proxy.mp4"), poster = join(tmp, "poster.jpg");
      // The review copy IS the high-quality file (Instagram's spec, keyframe every 2 s): ~10 Mbps for short clips,
      // 6 Mbps past 5 minutes so long-form doesn't fill R2's free 10 GB. One encode, one upload.
      const previewBps = meta.duration > 300 ? 6e6 : 10e6;
      // A client's own upload is never reviewed, so it gets one file: the best Instagram accepts (the untouched H.264
      // picture when it fits the Reel spec, else ~16 Mbps 1080p). It is the preview too; the original goes to Drive.
      // shortcut: an HEVC original is re-encoded (browsers can't all preview HEVC); keep it bit-for-bit once they can.
      const ownCopy = v.own && igReady(meta) && meta.src.vcodec === "h264";
      await run("ffmpeg", v.own ? (ownCopy ? remuxArgs(file, proxy, meta) : postEncodeArgs(file, proxy, meta, encoder, encoder === "h264_nvenc" ? undefined : (cfg.hqPreset || "medium")))
        : postEncodeArgs(file, proxy, meta, encoder, encoder === "h264_nvenc" ? undefined : (cfg.proxyPreset || "fast"), previewBps), {
        onStdout: (s) => {
          const us = /out_time_us=(\d+)/.exec(s)?.[1];
          if (us && meta.duration) emit({ encode: Math.min(1, Number(us) / 1e6 / meta.duration) });
        },
      });
      emit({ encode: 1, proxyTotal: statSync(proxy).size });
      await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-ss", String(Math.min(3, Math.max(0.5, meta.duration / 3))), "-i", proxy,
        "-frames:v", "1", "-vf", "scale=480:-2", "-q:v", "4", poster]);
      // Filmstrip for hover-scrub: 100 frames tiled 10x10, 160px tall (review-lab's recipe). Optional: never blocks the upload.
      const sprite = join(tmp, "sprite.jpg");
      const spriteOk = await run("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", proxy,
        "-vf", `fps=${(100 / Math.max(meta.duration, 0.001)).toFixed(5)},scale=-2:160,tile=10x10`, "-frames:v", "1", "-q:v", "5", sprite])
        .then(() => true, (e) => (log(`sprite skipped: ${e.message}`), false));
      const sent = await sendToR2({ cfg, api, file: proxy, key: `proxies/${clipId}/${v.version_id}.mp4`, partsPath: `/api/admin/versions/${v.version_id}/parts`, onBytes: (b) => emit({ proxy: b }), log, bucket: v.bucket });
      await api(`/api/admin/versions/${v.version_id}/poster`, { method: "PUT", body: readFileSync(poster) });
      if (spriteOk) await api(`/api/admin/versions/${v.version_id}/sprite`, { method: "PUT", body: readFileSync(sprite) }).catch((e) => log(`sprite upload skipped: ${e.message}`));
      if (v.own && statSync(proxy).size > 295e6) throw new Error(`This video is ${mb(statSync(proxy).size)} after preparing it, over Instagram's 300 MB limit`);
      const postSame = !!v.own;
      const done = await api(`/api/admin/versions/${v.version_id}/complete`, { method: "POST", json: { ...sent, post_same: postSame, meta } });
      emit({ live: true, stage: "live · master → Drive" });
      onLive();
      return { done, postSame };
    })();
    // Every original goes to Drive, a client's own upload too: YouTube is sent the original, and it can be downloaded.
    const masterPromise = livePromise.then(() => uploadMaster(cfg, file, v.drive_path, (f) => emit({ drive: f })))
      .then((fileId) => api(`/api/admin/versions/${v.version_id}/master`, { method: "POST", json: { drive_file_id: fileId } }))
      .catch((e) => { if (state.live) parkMaster(file, v.version_id, v.drive_path); throw e; });

    // Live first; a Drive failure after that must not hide the fact the client can already review.
    // HQ post file after the review copy is live, so it never delays review. A failure here is reported, not fatal.
    const hqPromise = livePromise.then(({ postSame }) => (v.post === false || postSame)
      ? emit({ postDone: true, postSkipped: true })
      : makePostFile({ cfg, api, clipId, versionId: v.version_id, src: file, meta, encoder, preset: cfg.hqPreset, tmp, emit, log }))
      .catch((e) => { log(`HQ file failed: ${e.message}`); emit({ postError: e.message }); });
    const [live, master] = await Promise.allSettled([livePromise, masterPromise, hqPromise]);
    if (live.status === "rejected") throw live.reason;
    if (master.status === "rejected") throw new Error(`Clip is live; the master isn't on Drive yet (${master.reason.message}). It's saved on this computer and retried automatically.`);
    emit({ stage: "done" });
    return { n: v.n, pruned: live.value.done.pruned, drivePath: v.drive_path, url: `${cfg.url}/#/clip/${clipId}` };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// Drive usage for the admin Storage page: account totals (fast) + the Pipeline folder (walks it, a few seconds).
// Cached so opening the page repeatedly doesn't hammer Drive.
let driveCache = null;
export async function driveStorage(cfg, { fresh = false } = {}) {
  if (!fresh && driveCache && Date.now() - driveCache.at < 10 * 60_000) return driveCache.data;
  const r = remote(cfg);
  const [about, size] = await Promise.all([
    run("rclone", ["about", `${r}:`, "--json"], { capture: true }).then(JSON.parse),
    run("rclone", ["size", `${r}:Pipeline`, "--json"], { capture: true }).then(JSON.parse).catch(() => null), // no folder yet
  ]);
  const data = { remote: r, total: about.total ?? null, used: about.used ?? null, trashed: about.trashed ?? null, other: about.other ?? null, free: about.free ?? null,
    pipeline: size ? { bytes: size.bytes, files: size.count } : { bytes: 0, files: 0 }, checked_at: new Date().toISOString() };
  driveCache = { at: Date.now(), data };
  return data;
}
