/**
 * 回归：patch #40 在 dsh 0.2.1-rc.2 的真实宿主文件上必须命中，
 * 且「重启门禁」依赖的标记必须真的能写进去。
 *
 * 用法：node scripts/verify-40-021.mjs [--host <app/dsh 目录>]
 */
import fs from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";
import { resolve } from "node:path";

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

const target = join(HOST, "node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js");
assert(fs.existsSync(target), `找不到 ${target}（用 --host 指定）`);
const original = fs.readFileSync(target, "utf8");
const p40 = core.ALL_PATCHES.find((p) => p.id === 40);

check("#40 是 COMPLETE_PROMPT_KEEP_INJECT", () => {
  assert(p40, "找不到 #40");
  assert(p40.name === "COMPLETE_PROMPT_KEEP_INJECT", p40.name);
  return "";
});

check("#40 在 0.2.1 宿主文件上至少命中一条 pattern", () => {
  const hits = p40.replacements.filter((r) => (
    r.pattern instanceof RegExp ? r.pattern.test(original) : original.includes(r.pattern)
  )).length;
  assert(hits > 0, "所有 pattern 都匹配不上 → 会变成 skipped");
  return `${hits}/${p40.replacements.length} 命中`;
});

check("applyReplacementsToText 真的改写内容并写入 marker", () => {
  const out = core.applyReplacementsToText(original, p40, target);
  assert(out.changed, "changed=false，等于没写");
  assert(
    out.text.includes("complete prompt keeps inject + agent-instructions"),
    "marker 没写进去 → hostPromptKeepsInject() 恒 false → 重启门禁失败",
  );
  return "";
});

check("改写保留 requiredContexts 语义（0.2.1 的 contexts 过滤）", () => {
  const out = core.applyReplacementsToText(original, p40, target);
  assert(out.text.includes("const requiredContexts = new Set("), "requiredContexts 丢了");
  assert(
    out.text.includes("transformed.contexts.filter((entry) => requiredContexts.has(entry.name))"),
    "contexts 过滤语义丢了",
  );
  return "";
});

check("改写保留 purge 段注入", () => {
  const out = core.applyReplacementsToText(original, p40, target);
  assert(out.text.includes('startsWith("dsh-purge")'), "purge 过滤逻辑丢了");
  return "";
});

check("幂等：二次 apply 不再变化", () => {
  const once = core.applyReplacementsToText(original, p40, target);
  const twice = core.applyReplacementsToText(once.text, p40, target);
  assert(twice.changed === false, "二次 apply 仍在改，可能重复注入");
  return "";
});

check("兜底 pattern 能接管未知形状", () => {
  const synthetic =
    "async assemble() {\n" +
    "\t\tconst transformed = await this.ctx.waterfall(scopeTarget(this, scope), \"system-prompt/assemble\", assembly, context, () => Promise.resolve(assembly));\n" +
    "\t\tif (completeSection === void 0 && !runtimeContextSuppressed) return transformed;\n" +
    "\t\tconst somethingNew = 1;\n" +
    "\t\treturn {\n" +
    "\t\t\t...transformed,\n" +
    "\t\t\tsections: completeSection === void 0 ? transformed.sections : [completeSection],\n" +
    "\t\t\tcontexts: runtimeContextSuppressed ? transformed.contexts : transformed.contexts\n" +
    "\t\t};\n" +
    "}";
  const out = core.applyReplacementsToText(synthetic, p40, "synthetic.js");
  assert(out.changed, "兜底没接管未知形状");
  assert(out.text.includes("complete prompt keeps inject + agent-instructions"), "兜底没写 marker");
  return "";
});

console.log(`\n${failures === 0 ? "all passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
