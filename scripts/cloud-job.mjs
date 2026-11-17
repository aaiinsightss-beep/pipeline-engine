#!/usr/bin/env node
// GitHub Actions side of the cloud engine (.github/workflows/cloud-engine.yml): fetch the original the browser put on R2,
// run the same processUpload as Engine.bat (x264 instead of NVENC), and report progress back to the Worker.
import { createWriteStream, mkdirSync, rmSync } from "node:fs";
import { pipeline } from "node:stream/promises";
import { Readable } from "node:stream";
import { join } from "node:path";
import { makeApi, processUpload, processHq, TMP_ROOT } from "./engine-core.mjs";

// This runs in a PUBLIC repository: its logs are public. Never print file names, titles, Drive paths or links here;
// details go to the Pipeline site (the report call), which is private.
const hq = process.argv[2] === "hq"; // "hq <version id>": make the Instagram file for a scheduled post from its Drive master
const jobId = process.argv[hq ? 3 : 2] || "";
if (!/^[\w-]{10,64}$/.test(jobId)) { console.error("usage: node scripts/cloud-job.mjs <job id> | hq <version id>"); process.exit(2); }
if (!process.env.PIPELINE_URL || !process.env.PIPELINE_ADMIN_KEY) { console.error("PIPELINE_URL and PIPELINE_ADMIN_KEY secrets are missing"); process.exit(2); }
// hqPreset: "medium" keeps the Instagram HQ file close to "slow" quality at about half the runner minutes.
const cfg = { url: process.env.PIPELINE_URL.replace(/\/$/, ""), adminKey: process.env.PIPELINE_ADMIN_KEY, encoder: "libx264", hqPreset: "medium", driveRemote: process.env.DRIVE_REMOTE || undefined };
const api = makeApi(cfg);
const started = Number(process.env.JOB_START) * 1000 || Date.now();
let chain = Promise.resolve(), last = 0, latest = null;
const report = (body) => (chain = chain.then(() => api(`/api/admin/cloud/${jobId}/report`, { method: "POST", json: { started_at: started, ...body } }))
  .catch((e) => console.error(`report failed: ${e.message}`)));
const dir = join(TMP_ROOT, `cloud-${jobId}`);
if (hq) {
  const say = (body) => api(`/api/admin/versions/${jobId}/prep`, { method: "POST", json: body }).catch(() => {});
  try { await processHq({ cfg, versionId: jobId }); await say({ ok: true }); console.log("post file ready"); }
  catch (e) { await say({ ok: false, error: e.message }); console.error("post file failed (details are in Pipeline)"); process.exitCode = 1; }
  process.exit();
}
try {
  const job = await api(`/api/admin/cloud/${jobId}`);
  report({ status: "running", progress: { stage: "downloading the original" } });
  mkdirSync(dir, { recursive: true });
  const file = join(dir, job.file_name);
  const res = await fetch(`${cfg.url}/api/admin/cloud/${jobId}/source`, { headers: { authorization: `Bearer ${cfg.adminKey}` } });
  if (!res.ok || !res.body) throw new Error(`Couldn't download the original (${res.status})`);
  await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
  const r = await processUpload({ cfg, file, clipId: job.clip_id, onProgress: (p) => {
    latest = p;
    if (Date.now() - last > 3000) { last = Date.now(); report({ status: "running", progress: p }); }
  } });
  console.log("done");
  await report({ status: "done", progress: { ...latest, n: r.n, stage: "done" } });
} catch (e) {
  console.error("failed (details are in Pipeline)");
  await report({ status: "error", error: e.message, progress: latest });
  process.exitCode = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
  await chain;
}
