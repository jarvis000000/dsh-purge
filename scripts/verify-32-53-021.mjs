/**
 * 回归：#32 / #53 在 dsh 0.2.1 上必须命中 dsh-harness-dev-context，
 * 而不是继续对着 dsh-web-app（那里已经没有这句了）。
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join, resolve } from "node:path";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const args = process.argv.slice(2);
const hostArg = args.indexOf("--host");
const HOST = hostArg >= 0 ? resolve(args[hostArg + 1]) : "E:/DSH/resources/app/dsh";

const core = await import(pathToFileURL(join(pkgRoot, "lib/core.js")).href);

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

const devCtx = join(HOST, "node_modules/@deepseek-ai/dsh-harness-dev-context/lib/index.js");
const webApp = join(HOST, "node_modules/@deepseek-ai/dsh-web-app/lib/index.js");

check("两个 candidate 文件都存在", () => {
  assert(fs.existsSync(devCtx), `缺少 ${devCtx}`);
  assert(fs.existsSync(webApp), `缺少 ${webApp}`);
  return "";
});

const original = fs.readFileSync(devCtx, "utf8");
const p32 = core.ALL_PATCHES.find((p) => p.id === 32);
const p53 = core.ALL_PATCHES.find((p) => p.id === 53);

check("#32 / #53 的 file 列表包含 harness-dev-context", () => {
  assert(p32.file.includes("harness-dev-context"), `#32 file=${JSON.stringify(p32.file)}`);
  assert(p53.file.includes("harness-dev-context"), `#53 file=${JSON.stringify(p53.file)}`);
  return "";
});

check("#32 在 0.2.1 的 dev-context 上命中", () => {
  const out = core.applyReplacementsToText(original, p32, devCtx);
  assert(out.changed, "没有改动");
  assert(
    out.text.includes("You are interacting with the user through the local web GUI at "),
    "身份句没被中性化",
  );
  assert(!out.text.includes("You are interacting with the user through the DeepSeek Harness Web GUI at "), "旧句仍在");
  return "";
});

check("#53 在 #32 的产物上继续命中（顺序依赖）", () => {
  const a = core.applyReplacementsToText(original, p32, devCtx);
  const b = core.applyReplacementsToText(a.text, p53, devCtx);
  assert(b.changed, "没有改动");
  assert(b.text.includes("Local web GUI: "), "没收敛成 Local web GUI");
  assert(!b.text.includes("Do not start a replacement server"), "禁止另开服务器那句还在");
  return "";
});

check("#53 去掉的是两处（当前正文 + 冻结历史文案）", () => {
  const count = (s) => (s.match(/Do not start a replacement server/g) || []).length;
  const a = core.applyReplacementsToText(original, p32, devCtx);
  const b = core.applyReplacementsToText(a.text, p53, devCtx);
  assert(count(original) === 2, `原文出现 ${count(original)} 次，预期 2`);
  assert(count(b.text) === 0, `产物仍有 ${count(b.text)} 处`);
  return "";
});

check("幂等：再跑一遍不再变化", () => {
  const a = core.applyReplacementsToText(original, p32, devCtx);
  const b = core.applyReplacementsToText(a.text, p53, devCtx);
  const a2 = core.applyReplacementsToText(b.text, p32, devCtx);
  const b2 = core.applyReplacementsToText(a2.text, p53, devCtx);
  assert(b2.changed === false, "二次 apply 仍在改");
  return "";
});

check("产物语法合法", () => {
  const a = core.applyReplacementsToText(original, p32, devCtx);
  const b = core.applyReplacementsToText(a.text, p53, devCtx);
  const tmp = join(pkgRoot, "scripts", ".p32-53-check.mjs");
  fs.writeFileSync(tmp, b.text, "utf8");
  try {
    execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  } finally {
    fs.rmSync(tmp, { force: true });
  }
  return "";
});

console.log(`\n${failures === 0 ? "all passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
