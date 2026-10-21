/**
 * 用插件的真实 apply 路径跑 #32 / #53（不跑 82 条全套，避免触发 asar 热替换），
 * 写完直接读回验证，并确认 LEGACY_* 未变。
 */
import fs from "node:fs";

const core = await import(
  "file:///C:/Users/wangj/.dsh/profiles/desktop/node_modules/dsh-purge/lib/core.js"
);

const aiBase = "E:\\DSH\\resources\\app\\dsh\\node_modules\\@deepseek-ai";
const files = core.targetFiles(aiBase);
const fp = files["harness-dev-context"];

const g = (t, n) => {
  const a = t.indexOf(`const ${n} = `);
  if (a < 0) return null;
  const e = t.indexOf("\n};", a);
  return t.slice(a, e + 3);
};

const before = fs.readFileSync(fp, "utf8");
const legacyBefore = { s: g(before, "LEGACY_SOURCE"), w: g(before, "LEGACY_WEB_SURFACE") };

let out = before;
let anyChanged = false;
for (const id of [32, 53]) {
  const p = core.ALL_PATCHES.find((x) => x.id === id);
  const r = core.applyReplacementsToText(out, p, fp);
  console.log(`#${id}: changed=${r.changed}`);
  out = r.text;
  anyChanged ||= r.changed;
}

const legacyAfter = { s: g(out, "LEGACY_SOURCE"), w: g(out, "LEGACY_WEB_SURFACE") };
const intact = legacyBefore.s === legacyAfter.s && legacyBefore.w === legacyAfter.w;
console.log("LEGACY_* 未变:", intact);

if (!intact) {
  console.log("✗ 拒绝写入");
  process.exit(2);
}

if (!anyChanged) {
  console.log("(无变化，无需写入)");
  process.exit(0);
}

const bak = `${fp}.dshpurge.bak`;
if (!fs.existsSync(bak)) fs.copyFileSync(fp, bak);
fs.writeFileSync(fp, out, "utf8");
console.log("✓ 已写入，备份:", bak);

// 读回复核
const back = fs.readFileSync(fp, "utf8");
console.log("写入后 LEGACY 未变:", g(back, "LEGACY_WEB_SURFACE") === legacyBefore.w);
console.log("写入后含标记:", back.includes("[dsh-purge] web surface identity neutralized"));
