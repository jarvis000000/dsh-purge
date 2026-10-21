/**
 * 回归：解包目录已在运行时，不能再判成「密封包待换」。
 *
 * 事故（2026-10-21 14:24 / 14:29 反复）：
 *   resources/app 早就解包并打好补丁，Electron 按「目录优先于 asar」加载的
 *   就是它；但插件只看 app.asar 文件是否还在磁盘上，判定「仍密封」，于是每次
 *   apply 都去换包重启 —— 每次重启都撞 Electron 的
 *   "dsh desktop host acknowledged an unrequested shutdown" 崩溃框。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const core = await import(
  pathToFileURL("C:/Users/wangj/.dsh/profiles/desktop/node_modules/dsh-purge/lib/core.js").href
);

let failures = 0;
function check(name, fn) {
  try {
    const d = fn();
    console.log(`PASS  ${name}${d ? ` — ${d}` : ""}`);
  } catch (e) {
    failures += 1;
    console.log(`FAIL  ${name} — ${e?.message || e}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

/** 造一个 resources 布局，返回 app.asar 路径（unpackedAppLooksLive 以它为锚）。 */
function layout({ unpacked = true, mainExists = true, dshExists = true } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "dsh-layout-"));
  const resources = path.join(root, "resources");
  fs.mkdirSync(resources, { recursive: true });
  const asar = path.join(resources, "app.asar");
  fs.writeFileSync(asar, "stub");
  if (unpacked) {
    const app = path.join(resources, "app");
    fs.mkdirSync(path.join(app, "lib"), { recursive: true });
    fs.writeFileSync(
      path.join(app, "package.json"),
      JSON.stringify({ name: "@deepseek-ai/dsh-desktop", version: "0.2.1-rc.2", main: "lib/main.js" }),
    );
    if (mainExists) fs.writeFileSync(path.join(app, "lib", "main.js"), "// main\n");
    if (dshExists) fs.mkdirSync(path.join(app, "dsh"), { recursive: true });
  }
  return { asar, cleanup: () => fs.rmSync(root, { recursive: true, force: true }) };
}

const live = core.unpackedAppLooksLive;
assert(typeof live === "function", "unpackedAppLooksLive 未导出");

check("真实安装：解包目录在跑 → 不再判成密封", () => {
  assert(core.sealedAsarHandoff() === null, "仍在要求换 asar → 会反复重启崩溃");
  assert(core.desktopAsarStillSealed() === false, "desktopAsarStillSealed 仍为 true");
  return "不需要换包";
});

check("解包完整（package.json + main + dsh）→ 判为已在运行", () => {
  const l = layout();
  try {
    assert(live(l.asar) === true, "完整解包目录没被认出");
    return "live";
  } finally { l.cleanup(); }
});

check("缺 main 指向的文件 → 不算在运行", () => {
  const l = layout({ mainExists: false });
  try {
    assert(live(l.asar) === false, "缺 main 却判为在运行，补丁不会生效");
    return "not-live";
  } finally { l.cleanup(); }
});

check("缺 dsh 主体 → 不算在运行", () => {
  const l = layout({ dshExists: false });
  try {
    assert(live(l.asar) === false, "空壳目录被误判成在运行");
    return "not-live";
  } finally { l.cleanup(); }
});

check("完全没有解包目录（纯 asar 密封包）→ 不算在运行", () => {
  const l = layout({ unpacked: false });
  try {
    assert(live(l.asar) === false, "纯密封包却判为在运行");
    return "not-live";
  } finally { l.cleanup(); }
});

// ── desktop.js 侧的独立入口也要拦住 ──────────────────────────────────────────
// 14:52 那次崩溃走的是 restartOfficialHarness()，它没经过 core.sealedAsarHandoff()，
// 自己看 asar 文件还在就直接 PowerShell 换包，所以必须在这一层也判。
const desktop = await import(
  pathToFileURL("C:/Users/wangj/.dsh/profiles/desktop/node_modules/dsh-purge/lib/desktop.js").href
);

check("desktop.restartOfficialHarness：解包目录在跑时拒绝换包", () => {
  const r = desktop.restartOfficialHarness({
    exe: "E:/DSH/DSH.exe",
    asar: "E:/DSH/resources/app.asar",
  });
  assert(r.restarting === false, `仍在重启：${JSON.stringify(r)}`);
  assert(r.reason === "unpacked-already-live", `reason=${r.reason}`);
  return r.reason;
});

check("desktop.unpackedAppIsLiveForAsar：完整解包 → true", () => {
  const l = layout();
  try {
    assert(desktop.unpackedAppIsLiveForAsar(l.asar) === true, "完整解包没认出");
    return "true";
  } finally { l.cleanup(); }
});

check("desktop.unpackedAppIsLiveForAsar：缺 main → false", () => {
  const l = layout({ mainExists: false });
  try {
    assert(desktop.unpackedAppIsLiveForAsar(l.asar) === false, "缺 main 却判为在跑");
    return "false";
  } finally { l.cleanup(); }
});

check("desktop.unpackedAppIsLiveForAsar：纯 asar → false", () => {
  const l = layout({ unpacked: false });
  try {
    assert(desktop.unpackedAppIsLiveForAsar(l.asar) === false, "纯密封包判为在跑");
    return "false";
  } finally { l.cleanup(); }
});

console.log(`\n${failures === 0 ? "all passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
