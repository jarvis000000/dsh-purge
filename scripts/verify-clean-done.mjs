/**
 * 端到端验证「清洗」判定：只跑判定链（pending / hostWritten / flash），
 * 不调用会杀进程的 asar 热替换。
 */
import fs from "node:fs";

const core = await import(
  "file:///C:/Users/wangj/.dsh/profiles/desktop/node_modules/dsh-purge/lib/core.js"
);

const aiBase = "E:\\DSH\\resources\\app\\dsh\\node_modules\\@deepseek-ai";

// 1. 所有补丁状态
const st = await core.patchStatus(aiBase);
const SOFT = new Set(["applied", "already", "missing_file", "skipped", "na", "off"]);
const hard = Object.entries(st).filter(([, v]) => !SOFT.has(v));
const pending = Object.entries(st).filter(([, v]) => v === "pending");

console.log("=== 补丁状态 ===");
console.log("总补丁:", Object.keys(st).length);
console.log("pending:", pending.length ? pending.map(([k]) => "#" + k).join(" ") : "无");
console.log("硬失败:", hard.length ? hard.map(([k, v]) => `#${k}:${v}`).join(" ") : "无");

// 2. 宿主提示词标记
const sp = "E:/DSH/resources/app/dsh/node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js";
const spText = fs.readFileSync(sp, "utf8");
const keeps = core.hostPromptKeepsInject(spText);
console.log("\n=== 宿主提示词 ===");
console.log("hostPromptKeepsInject:", keeps);

// 3. 冻结常量完整性
const dc = "E:/DSH/resources/app/dsh/node_modules/@deepseek-ai/dsh-harness-dev-context/lib/index.js";
const dcText = fs.readFileSync(dc, "utf8");
const prefix = /const LEGACY_WEB_SURFACE = \{\s*prefix: "([^"]*)"/.exec(dcText)?.[1];
console.log("\n=== 冻结常量 ===");
console.log("LEGACY_WEB_SURFACE.prefix:", JSON.stringify(prefix));
console.log("完好:", prefix === "You are interacting with the user through the DeepSeek Harness Web GUI at ");

// 4. 最终判定
const wouldBlock = pending.length > 0 || hard.length > 0 || !keeps;
console.log("\n=== 结论 ===");
console.log(wouldBlock ? "✗ 仍会被拦下重启" : "✓ 清洗完成，可以重启");
process.exit(wouldBlock ? 1 : 0);
