/**
 * 安全应用 #32 / #53 到真实宿主：写前比对，写后复核，
 * 一旦发现 LEGACY_* 被动过就立即回滚。
 * 不使用插件的整套 apply（那会跑 82 条补丁），只做这两个已知补丁。
 */
import fs from "node:fs";
import { execFileSync } from "node:child_process";

const core = await import(
  "file:///F:/%E5%83%8F%E7%B4%A0%E8%9B%8B%E7%B3%95/pixcake_2/.dsh-purge-fix/lib/core.js"
);

const TARGET =
  "E:/DSH/resources/app/dsh/node_modules/@deepseek-ai/dsh-harness-dev-context/lib/index.js";
const PRISTINE = "C:/Users/wangj/AppData/Local/Temp/dc-orig/package/lib/index.js";
const DRY = process.argv.includes("--write") === false;

const source = fs.readFileSync(TARGET, "utf8");
const pristine = fs.readFileSync(PRISTINE, "utf8");

const grab = (t, name) => {
  const at = t.indexOf(`const ${name} = `);
  if (at < 0) return null;
  const end = t.indexOf("\n};", at);
  return t.slice(at, end < 0 ? t.length : end + 3);
};
const frozen = (t) => [grab(t, "LEGACY_SOURCE"), grab(t, "LEGACY_WEB_SURFACE")];

// 前提：当前文件应等于原版（上次已还原）
const sameAsPristine = source === pristine;
console.log("当前文件 == npm 原版:", sameAsPristine);
if (!sameAsPristine) {
  console.log("⚠ 文件不是原版状态，先看差异再决定是否继续");
}

const before = frozen(pristine);
let out = source;
for (const id of [32, 53]) {
  const p = core.ALL_PATCHES.find((x) => x.id === id);
  const r = core.applyReplacementsToText(out, p, TARGET);
  console.log(`#${id} changed=${r.changed}`);
  out = r.text;
}

const after = frozen(out);
const legacyIntact = before.every((v, i) => v === after[i]);
console.log("LEGACY_* 未被改动:", legacyIntact);

const tmp = "C:/Users/wangj/AppData/Local/Temp/devctx-patched.mjs";
fs.writeFileSync(tmp, out, "utf8");
try {
  execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
  console.log("语法检查: ok");
} catch (e) {
  console.log("语法检查: 失败");
  process.exit(1);
} finally {
  fs.rmSync(tmp, { force: true });
}

if (!legacyIntact) {
  console.log("✗ 冻结常量被改动，拒绝写入");
  process.exit(2);
}

const write = process.argv.includes("--write");
if (!write) {
  console.log("\n(dry-run) 未写入。加 --write 真正写入。");
} else {
  fs.copyFileSync(TARGET, `${TARGET}.pre-dc-fix`);
  fs.writeFileSync(TARGET, out, "utf8");
  console.log("\n✓ 已写入，备份: index.js.pre-dc-fix");
}
