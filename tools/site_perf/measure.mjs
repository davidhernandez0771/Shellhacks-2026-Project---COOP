// Measures the showcase site the way site/PERFORMANCE.md reports it: headless Chromium,
// 4x CPU throttle, DevTools' "Fast 4G" profile, a 1440x900 viewport at devicePixelRatio 2
// (a Retina MacBook), cold cache on every run.
//   node tools/site_perf/serve.mjs 8767 site &      (Cloudflare-like server, brotli + ETags)
//   node tools/site_perf/measure.mjs http://localhost:8767/ [runs]
// Needs Playwright for Node, local or global (npm i -g playwright; npx playwright install chromium).
// Prints one JSON object with the median of each metric and the per-run values.
import { createRequire } from "node:module";
import { execSync } from "node:child_process";
import path from "node:path";

const require = createRequire(import.meta.url);
let pw;
try { pw = require("playwright"); }
catch { pw = require(path.join(execSync("npm root -g").toString().trim(), "playwright")); }
const { chromium } = pw;

const url = process.argv[2] || "http://localhost:8767/";
const runs = Number(process.argv[3] || 3);
// DevTools "Fast 4G" (front_end/core/sdk/NetworkManager.ts): 9 Mbit/s down, 1.5 Mbit/s up,
// 60 ms latency scaled by 2.75 => 165 ms RTT, both throughputs scaled by 0.9.
const FAST_4G = { offline: false, latency: 165, downloadThroughput: (9e6 / 8) * 0.9, uploadThroughput: (1.5e6 / 8) * 0.9 };
const CPU_RATE = Number(process.env.CPU_RATE || 4);
const DPR = Number(process.env.DPR || 2);
const SCROLL_S = 14;

const INIT = () => {
  window.__perf = { longTasks: [], status: [], enterAt: null };
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__perf.longTasks.push({ start: e.startTime, dur: e.duration });
    }).observe({ type: "longtask", buffered: true });
  } catch {}
  document.addEventListener("DOMContentLoaded", () => {
    const st = document.getElementById("gate-status");
    const btn = document.getElementById("gate-enter");
    if (st) new MutationObserver(() => window.__perf.status.push([st.textContent, performance.now()]))
      .observe(st, { childList: true, characterData: true, subtree: true });
    if (btn) new MutationObserver(() => { if (!btn.hidden && window.__perf.enterAt == null) window.__perf.enterAt = performance.now(); })
      .observe(btn, { attributes: true, attributeFilter: ["hidden"] });
  });
};

async function once(browser) {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: DPR });
  const page = await ctx.newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(String(e)));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  await page.addInitScript(INIT);
  const cdp = await ctx.newCDPSession(page);
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  await cdp.send("Network.emulateNetworkConditions", FAST_4G);
  await cdp.send("Emulation.setCPUThrottlingRate", { rate: CPU_RATE });
  await cdp.send("Performance.enable");

  const reqs = new Map();
  cdp.on("Network.responseReceived", (e) => { reqs.set(e.requestId, { url: e.response.url, bytes: 0, raw: 0 }); });
  cdp.on("Network.dataReceived", (e) => { const r = reqs.get(e.requestId); if (r) r.raw += e.dataLength; });
  cdp.on("Network.loadingFinished", (e) => { const r = reqs.get(e.requestId); if (r) r.bytes = e.encodedDataLength; });

  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.waitForFunction(() => window.__perf.enterAt != null, null, { timeout: 90000, polling: 50 });
  const load = await page.evaluate(() => ({
    enterAt: window.__perf.enterAt,
    fcp: (performance.getEntriesByName("first-contentful-paint")[0] || {}).startTime ?? null,
    status: window.__perf.status,
    longTasks: window.__perf.longTasks.slice(),
  }));
  const files = [...reqs.values()].filter((r) => r.bytes > 0);
  const transfer = files.reduce((a, r) => a + r.bytes, 0);

  // enter, wait for the intro to settle, then scroll the whole page at a constant speed
  await page.click("#gate-enter");
  await page.waitForTimeout(4000);
  const m0 = await cdp.send("Performance.getMetrics");
  const scroll = await page.evaluate(async (secs) => {
    const lt0 = window.__perf.longTasks.length;
    const max = document.documentElement.scrollHeight - innerHeight;
    const deltas = [];
    await new Promise((resolve) => {
      let t0 = null, prev = null;
      const step = (now) => {
        if (t0 == null) t0 = now;
        if (prev != null) deltas.push(now - prev);
        prev = now;
        const f = Math.min(1, (now - t0) / (secs * 1000));
        window.scrollTo(0, f * max);
        if (f < 1) requestAnimationFrame(step); else resolve();
      };
      requestAnimationFrame(step);
    });
    const lts = window.__perf.longTasks.slice(lt0);
    deltas.sort((a, b) => a - b);
    const q = (p) => deltas[Math.min(deltas.length - 1, Math.floor(p * deltas.length))];
    return {
      frames: deltas.length,
      fps: deltas.length / secs,
      p50: q(0.5), p95: q(0.95),
      longTasks: lts.length, longTaskMs: lts.reduce((a, e) => a + e.dur, 0),
    };
  }, SCROLL_S);
  const m1 = await cdp.send("Performance.getMetrics");
  const metric = (m, n) => m.metrics.find((x) => x.name === n).value;
  scroll.scriptMsPerFrame = ((metric(m1, "ScriptDuration") - metric(m0, "ScriptDuration")) * 1000) / scroll.frames;
  scroll.taskMsPerFrame = ((metric(m1, "TaskDuration") - metric(m0, "TaskDuration")) * 1000) / scroll.frames;
  await ctx.close();

  return {
    loaderEndMs: load.enterAt, fcpMs: load.fcp,
    transferKB: transfer / 1024, requests: files.length,
    largest: files.sort((a, b) => b.bytes - a.bytes).slice(0, 6)
      .map((r) => `${r.url.replace(/^https?:\/\/[^/]+\//, "")} ${(r.bytes / 1024).toFixed(1)} KB`),
    loadLongTasks: load.longTasks.length,
    loadLongTaskMs: load.longTasks.reduce((a, e) => a + e.dur, 0),
    loadLongest: load.longTasks.reduce((a, e) => Math.max(a, e.dur), 0),
    status: load.status.map(([s, t]) => `${s}@${Math.round(t)}`).join(" "),
    scroll, errors,
  };
}

const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const all = [];
for (let i = 0; i < runs; i++) all.push(await once(browser));
await browser.close();
const med = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s[Math.floor(s.length / 2)]; };
const pick = (f) => med(all.map(f));
console.log(JSON.stringify({
  url, runs,
  median: {
    loaderEndMs: pick((r) => r.loaderEndMs), fcpMs: pick((r) => r.fcpMs),
    transferKB: pick((r) => r.transferKB), requests: pick((r) => r.requests),
    loadLongTasks: pick((r) => r.loadLongTasks), loadLongTaskMs: pick((r) => r.loadLongTaskMs), loadLongest: pick((r) => r.loadLongest),
    scrollFps: pick((r) => r.scroll.fps), frameP50: pick((r) => r.scroll.p50), frameP95: pick((r) => r.scroll.p95),
    scrollLongTasks: pick((r) => r.scroll.longTasks), scriptMsPerFrame: pick((r) => r.scroll.scriptMsPerFrame),
    taskMsPerFrame: pick((r) => r.scroll.taskMsPerFrame),
  },
  runsDetail: all,
}, null, 2));
