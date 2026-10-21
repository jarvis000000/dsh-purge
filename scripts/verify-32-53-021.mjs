/**
 * #32 / #53 在 dsh 0.2.1 上的回归。
 *
 * 背景（崩溃事故 2026-10-21 14:06:37）：
 * 0.2.1 把 Web GUI 身份提示词搬到 dsh-harness-dev-context，同一段文本
 * 在文件里存在两份 —— WEB_SURFACE_PROMPT（当前正文）和 LEGACY_WEB_SURFACE
 * （冻结的历史模板，宿主用来认回旧会话）。用裸字符串替换会把冻结模板
 * 一起改掉，导致会话恢复匹配失败、宿主进程直接退出。
 *
 * 现在的分工：
 *   #32  负责当前正文（用常量名前缀锚定），收成 "Local web GUI: this one, ..."
 *   #53  只负责老版本 dsh-web-app 的短句；0.2.1 上不参与
 *   两条都不允许改动 LEGACY_*
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const core = await import(pathToFileURL(path.join(pkgRoot, "lib/core.js")).href);

const PRISTINE = [
  path.join(os.tmpdir(), "dc-orig", "package", "lib", "index.js"),
  "E:/DSH/resources/app/dsh/node_modules/@deepseek-ai/dsh-harness-dev-context/lib/index.js",
].find((p) => fs.existsSync(p));

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

const grab = (t, name) => {
  const at = t.indexOf(`const ${name} = `);
  if (at < 0) return null;
  const end = t.indexOf("\n};", at);
  return t.slice(at, end < 0 ? t.length : end + 3);
};
const frozen = (t) => ({
  LEGACY_SOURCE: grab(t, "LEGACY_SOURCE"),
  LEGACY_WEB_SURFACE: grab(t, "LEGACY_WEB_SURFACE"),
});

check("找到 dev-context 基准文件", () => {
  assert(PRISTINE, "没有基准文件");
  return PRISTINE;
});

const pristine = fs.readFileSync(PRISTINE, "utf8");
const p32 = core.ALL_PATCHES.find((p) => p.id === 32);
const p53 = core.ALL_PATCHES.find((p) => p.id === 53);

check("#32 / #53 都声明指向 harness-dev-context", () => {
  assert(p32.file.includes("harness-dev-context"), `#32 ${JSON.stringify(p32.file)}`);
  assert(p53.file.includes("harness-dev-context"), `#53 ${JSON.stringify(p53.file)}`);
  return "";
});

check("#32 在当前正文上生效，且中性化产品名", () => {
  const r = core.applyReplacementsToText(pristine, p32, "x.js");
  assert(r.changed, "没有改动");
  assert(r.text.includes("const WEB_SURFACE_PROMPT = `Local web GUI: this one,"), "没收成 Local web GUI");
  assert(
    !/const WEB_SURFACE_PROMPT = `You are interacting with the user through the DeepSeek Harness/.test(r.text),
    "正文仍有产品名",
  );
  return "";
});

check("当前正文改完后，冻结模板逐字节不变", () => {
  const before = frozen(pristine);
  const r = core.applyReplacementsToText(pristine, p32, "x.js");
  const after = frozen(r.text);
  for (const k of Object.keys(before)) {
    assert(before[k] !== null, `基准里没有 ${k}`);
    assert(before[k] === after[k], `${k} 被改动了 —— 会复现崩溃`);
  }
  return "LEGACY_SOURCE / LEGACY_WEB_SURFACE 一致";
});

check("#53 在 0.2.1 上不改任何东西（正文已由 #32 处理）", () => {
  const r = core.applyReplacementsToText(pristine, p53, "x.js");
  assert(r.changed === false, "#53 仍在改 0.2.1 文件，可能与 #32 抢锚点");
  return "";
});

check("#53 仍能处理老版本 dsh-web-app 的短句", () => {
  const legacy = 'const X = "You are interacting with the user through the local web GUI at ${webUrl}.";';
  const r = core.applyReplacementsToText(legacy, p53, "x.js");
  assert(r.changed, "老版本短句没被处理");
  assert(r.text.includes("Local web GUI: ${webUrl}."), "老版本没收成 Local web GUI");
  return "";
});

check("护栏：任何试图改 LEGACY_* 的补丁会被整条撤销", () => {
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
  assert(r.changed === false, "护栏没生效");
  assert(r.text === pristine, "改动没被撤销");
  return "已撤销";
});

check("整条链（#32 → #53）产物语法合法", () => {
  const a = core.applyReplacementsToText(pristine, p32, "x.js");
  const b = core.applyReplacementsToText(a.text, p53, "x.js");
  const tmp = path.join(pkgRoot, "scripts", ".devctx-chain.mjs");
  fs.writeFileSync(tmp, b.text, "utf8");
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
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
