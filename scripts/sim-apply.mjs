/**
 * 全量 apply 模拟：复制会被补丁改到的文件到临时目录，逐个 apply，
 * 统计 applied / skipped / not-found，并对 JS 产物做语法检查。
 * 只读真实安装，不写宿主。
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const core = await import(pathToFileURL(path.join(pkgRoot, "lib/core.js")).href);
process.env.DSH_HOME ||= "C:/Users/wangj/.dsh";

const aiBase = core.enumeratePatchAiBases()[0];
console.log("aiBase:", aiBase);

const targets = core.targetFiles(aiBase);
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "purge-sim-"));
let applied = 0;
let untouched = 0;
let failed = 0;
const report = [];

for (const [key, fp] of Object.entries(targets)) {
  if (!fp || !fs.existsSync(fp) || fs.statSync(fp).isDirectory()) continue;
  let text;
  try {
    text = fs.readFileSync(fp, "utf8");
  } catch {
    continue;
  }
  const patches = core.ALL_PATCHES.filter((p) => {
    const files = Array.isArray(p.file) ? p.file : [p.file];
    return files.includes(key);
  });
  if (patches.length === 0) continue;

  let out = text;
  const hits = [];
  for (const p of patches) {
    if (Array.isArray(p.forbid) && p.forbid.some((m) => out.includes(m))) continue;
    const r = core.applyReplacementsToText(out, p, fp);
    if (r.changed) hits.push("#" + p.id);
    out = r.text;
  }

  if (hits.length === 0) {
    untouched += 1;
    report.push(`  -  ${key.padEnd(24)} ${path.basename(fp).padEnd(14)} 无改动（pattern 未命中或已应用）`);
    continue;
  }

  // 语法检查（只检查 js）
  let syntax = "ok";
  if (fp.endsWith(".js")) {
    const tmp = path.join(tmpRoot, `${key.replace(/[\\/]/g, "_")}.mjs`);
    fs.writeFileSync(tmp, out, "utf8");
    try {
      execFileSync(process.execPath, ["--check", tmp], { stdio: "pipe" });
    } catch (e) {
      syntax = "SYNTAX ERROR";
      failed += 1;
    }
  }
  applied += 1;
  report.push(`  +  ${key.padEnd(24)} ${path.basename(fp).padEnd(14)} ${hits.join(",")} ${syntax}`);
}

console.log(report.join("\n"));
console.log(`\n有改动文件: ${applied} / 无改动: ${untouched} / 失败: ${failed}`);
fs.rmSync(tmpRoot, { recursive: true, force: true });
process.exit(failed === 0 ? 0 : 1);
