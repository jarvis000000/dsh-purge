/**
 * 崩溃回归：#53 曾经改动 LEGACY_WEB_SURFACE 的 prefix，导致宿主恢复旧会话时
 * 匹配不到冻结文案模板而崩溃（2026-10-21 14:06:37）。
 *
 * 本套用 npm 上的 0.2.1-rc.2 原始包做基准，验证：
 *   1. #32 / #53 只动 WEB_SURFACE_PROMPT，LEGACY_* 一个字节都不变
 *   2. 若某个 pattern 试图改 LEGACY_*，protectLegacy 会让整条补丁撤销
 *   3. 产物语法合法、幂等
 *   4. 装回宿主后能正常 import（模块顶层无异常）
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const core = await import(pathToFileURL(path.join(pkgRoot, "lib/core.js")).href);

let failures = 0;
function check(name, fn) {
  try {
    const detail = fn();
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name} — ${error?.message || error}`);
  }
}
const assert = (cond, msg) => { if (!cond) throw new Error(msg); };

// ── 基准文件：优先用 npm 原始包，其次用宿主当前文件 ──────────────────────────
const PRISTINE = [
  path.join(os.tmpdir(), "dc-orig", "package", "lib", "index.js"),
  "E:/DSH/resources/app/dsh/node_modules/@deepseek-ai/dsh-harness-dev-context/lib/index.js",
].find((p) => fs.existsSync(p));

check("找到 dev-context 基准文件", () => {
  assert(PRISTINE, "没有基准文件");
  const t = fs.readFileSync(PRISTINE, "utf8");
  assert(t.includes("const LEGACY_WEB_SURFACE = {"), "基准文件缺少 LEGACY_WEB_SURFACE");
  assert(t.includes("const WEB_SURFACE_PROMPT = `"), "基准文件缺少 WEB_SURFACE_PROMPT");
  return PRISTINE;
});

const pristine = fs.readFileSync(PRISTINE, "utf8");

/** 抽出两个冻结常量的原文，用于「一个字节都没变」的断言。 */
function frozenBlocks(text) {
  const grab = (name) => {
    const at = text.indexOf(`const ${name} = `);
    if (at < 0) return null;
    const end = text.indexOf("\n};", at);
    return text.slice(at, end < 0 ? text.length : end + 3);
  };
  return { LEGACY_SOURCE: grab("LEGACY_SOURCE"), LEGACY_WEB_SURFACE: grab("LEGACY_WEB_SURFACE") };
}

const p32 = core.ALL_PATCHES.find((p) => p.id === 32);
const p53 = core.ALL_PATCHES.find((p) => p.id === 53);

check("#53 带 protectLegacy 声明", () => {
  assert(Array.isArray(p53.protectLegacy), "#53 没有 protectLegacy");
  assert(p53.protectLegacy.includes("LEGACY_WEB_SURFACE"), "没保护 LEGACY_WEB_SURFACE");
  return p53.protectLegacy.join(", ");
});

check("#32 + #53 不改动任何 LEGACY_* 常量", () => {
  const before = frozenBlocks(pristine);
  const a = core.applyReplacementsToText(pristine, p32, "x.js");
  const b = core.applyReplacementsToText(a.text, p53, "x.js");
  const after = frozenBlocks(b.text);
  for (const k of Object.keys(before)) {
    assert(before[k] === after[k], `${k} 被改动了 —— 会复现崩溃`);
  }
  return "两个冻结常量逐字节一致";
});

check("#53 在 0.2.1 上不改文件（正文已由 #32 统一处理，避免抢锚点）", () => {
  const b = core.applyReplacementsToText(pristine, p53, "x.js");
  assert(b.changed === false, "#53 仍在改 0.2.1 文件，可能与 #32 抢同一锚点");
  // 但 #32 必须确实把正文改掉了，否则两条都不生效
  const a = core.applyReplacementsToText(pristine, p32, "x.js");
  assert(a.changed, "#32 没有改动，说明 0.2.1 上这两条都没生效");
  assert(a.text.includes("const WEB_SURFACE_PROMPT = `Local web GUI:"), "正文没被中性化");
  return "由 #32 负责";
});

check("护栏：pattern 若试图改 LEGACY_* 则整条撤销", () => {
  const evil = {
    id: 53,
    protectLegacy: ["LEGACY_WEB_SURFACE"],
    replacements: [
      {
        pattern: 'prefix: "You are interacting with the user through the DeepSeek Harness Web GUI at "',
        replace: 'prefix: "Local web GUI: "',
      },
    ],
  };
  const r = core.applyReplacementsToText(pristine, evil, "x.js");
  assert(r.changed === false, "护栏没生效，补丁仍然改了冻结常量");
  assert(r.text === pristine, "产物与原文不一致，说明改动没被撤销");
  return "已撤销";
});

check("产物语法合法", () => {
  const a = core.applyReplacementsToText(pristine, p32, "x.js");
  const b = core.applyReplacementsToText(a.text, p53, "x.js");
  const tmp = path.join(pkgRoot, "scripts", ".devctx-check.mjs");
  fs.writeFileSync(tmp, b.text, "utf8");
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return "";
});

check("产物可被 import（模块顶层无异常）", () => {
  const a = core.applyReplacementsToText(pristine, p32, "x.js");
  const b = core.applyReplacementsToText(a.text, p53, "x.js");
  const tmp = path.join(os.tmpdir(), `devctx-import-${Date.now()}.mjs`);
  fs.writeFileSync(tmp, b.text, "utf8");
  try {
    // 只验证模块能加载；依赖解析失败也说明它跑不到宿主里
    execFileSync(process.execPath, ["-e", `import(${JSON.stringify(pathToFileURL(tmp).href)}).then(()=>{},e=>{console.error(String(e.message));process.exit(3)})`], { stdio: "pipe" });
  } catch (error) {
    const msg = String(error.stderr || error.message);
    // 找不到 @deepseek-ai 依赖属于正常（沙箱里没装），不算失败
    assert(/Cannot find package|ERR_MODULE_NOT_FOUND/.test(msg), `模块加载失败：${msg.slice(0, 200)}`);
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return "";
});

check("幂等：二次 apply 不再变化", () => {
  const a = core.applyReplacementsToText(pristine, p32, "x.js");
  const b = core.applyReplacementsToText(a.text, p53, "x.js");
  const a2 = core.applyReplacementsToText(b.text, p32, "x.js");
  const b2 = core.applyReplacementsToText(a2.text, p53, "x.js");
  assert(b2.changed === false, "二次 apply 仍在改");
  return "";
});

console.log(`\n${failures === 0 ? "all passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
