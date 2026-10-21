/**
 * 验证 {{cwd}} 修复：用宿主自己的 renderPrompt / renderContextSections 跑一遍
 * 插件产出的 sections，确认不再有未注册变量；再给插件补注册 cwd 的其它路径做兜底回归。
 *
 * 用法：node scripts/verify-cwd-fix.mjs [--host <app/dsh 目录>]
 * 退出码 0 = 全部通过。
 */
import { readFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

const args = process.argv.slice(2);
const hostArg = args.indexOf("--host");
const HOST = hostArg >= 0
  ? resolve(args[hostArg + 1])
  : "E:/DSH/resources/app/dsh";

let failures = 0;
let passes = 0;
function check(name, fn) {
  try {
    const detail = fn();
    passes += 1;
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name} — ${error?.message || error}`);
  }
}
function assert(cond, message) {
  if (!cond) throw new Error(message);
}

// 非 ASCII 路径（中文目录）在 file URL 里会被百分号编码，必须解回来。
const pkgRoot = fileURLToPath(new URL("..", import.meta.url));

// ── 1. 仓库静态检查：不能有活跃的 {{cwd}} 插值 ────────────────────────────────
const patchYml = readFileSync(join(pkgRoot, "cordis.patch.yml"), "utf8");
check("cordis.patch.yml 的 personaSuffix 为空串", () => {
  const m = /personaSuffix:\s*(.*)$/m.exec(patchYml);
  assert(m, "找不到 personaSuffix 行");
  const value = m[1].trim().replace(/^["']|["']$/g, "");
  assert(value === "", `personaSuffix 仍是 ${JSON.stringify(m[1].trim())}`);
  return "personaSuffix: \"\"";
});
check("cordis.patch.yml 非注释行里没有 {{cwd}}", () => {
  const bad = patchYml.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .filter((line) => line.includes("{{cwd}}"));
  assert(bad.length === 0, `仍有 ${bad.length} 行：${bad[0]}`);
  return "";
});
check("presets/redteam/agent.cordis.yml 非注释行里没有 {{cwd}}", () => {
  const text = readFileSync(join(pkgRoot, "presets/redteam/agent.cordis.yml"), "utf8");
  const bad = text.split(/\r?\n/)
    .filter((line) => !line.trimStart().startsWith("#"))
    .filter((line) => line.includes("{{cwd}}"));
  assert(bad.length === 0, `仍有 ${bad.length} 行：${bad[0]}`);
  return "";
});

// ── 2. 插件运行时：写回 persona 的文本不再带 cwd ──────────────────────────────
const identity = await import(pathToFileURL(join(pkgRoot, "lib/identity.js")).href);

check("rewritePromptAssembly 不把 {{cwd}} 写回 persona 段", () => {
  const assembled = {
    variables: { provider: "magpie", model: "deepseek/deepseek-flash" },
    sections: [
      { name: "harness:identity", order: -1000, text: "You are a coding agent powered by the {{model}} model." },
      { name: "deployment:persona-prefix", order: 0, text: "" },
      { name: "deployment:persona-suffix", order: 10200, text: "" },
      { name: "dsh-purge", order: -100000, text: "OPERATOR BODY", interpolate: false },
    ],
    contexts: [],
    tools: [],
  };
  const out = identity.rewritePromptAssembly(assembled, "", { context: {}, dropMnemon: true });
  for (const section of out.sections) {
    assert(!String(section.text || "").includes("{{cwd}}"), `段 ${section.name} 仍含 {{cwd}}`);
  }
  return "";
});

check("overlayOfficialIdentity 清掉宿主残留的 cwd 后缀", () => {
  const out = identity.overlayOfficialIdentity([
    { name: "deployment:persona-suffix", order: 10200, text: "Your working directory is {{cwd}}." },
    { name: "deployment:persona-prefix", order: 0, text: "Keep me. Your working directory is {{cwd}}. And me." },
  ]);
  for (const section of out) {
    assert(!String(section.text || "").includes("{{cwd}}"), `段 ${section.name} 仍含 {{cwd}}`);
  }
  const prefix = out.find((s) => s.name === "deployment:persona-prefix");
  assert(prefix.text.includes("Keep me.") && prefix.text.includes("And me."), "用户自写文本被误删");
  return "";
});

check("withoutUnregisteredVariables 只降级未注册/无值变量", () => {
  const text = identity.withoutUnregisteredVariables(
    "{{model}} | {{cwd}} | {{provider}} | {{notavar}} | {{",
    { provider: "p", model: "m", empty: undefined },
  );
  assert(text.includes("{{model}}"), "合法变量被吃掉");
  assert(text.includes("{{provider}}"), "合法变量被吃掉");
  assert(!text.includes("{{cwd}}"), "cwd 未被降级");
  assert(!text.includes("{{notavar}}"), "未注册变量未被降级");
  return text;
});

// ── 3. 用宿主自己的渲染器渲染插件的输出 ──────────────────────────────────────
const sysPromptPath = join(HOST, "node_modules/@deepseek-ai/dsh-system-prompt/lib/index.js");
check("宿主 system-prompt 模块存在", () => {
  assert(existsSync(sysPromptPath), `找不到 ${sysPromptPath}（用 --host 指定 app/dsh 目录）`);
  return sysPromptPath;
});

if (existsSync(sysPromptPath)) {
  const host = await import(pathToFileURL(sysPromptPath).href);

  function renders(sections) {
    const assembly = {
      sections,
      contexts: [],
      tools: [],
      // 与 0.2.1-rc.2 一致：宿主只注册了 provider / model
      variables: { provider: "magpie", model: "deepseek/deepseek-flash" },
    };
    return host.renderPrompt(assembly);
  }

  check("修复后的插件输出可被宿主渲染（不再抛 unknown prompt variable）", () => {
    const assembled = {
      variables: { provider: "magpie", model: "deepseek/deepseek-flash" },
      sections: [
        { name: "deployment:persona-prefix", order: 0, text: "" },
        { name: "deployment:persona-suffix", order: 10200, text: "" },
        { name: "dsh-purge", order: -100000, text: "OPERATOR BODY with {{cwd}} inside", interpolate: false },
        { name: "tool:bash", order: 1000, text: "Prefer bash." },
      ],
      contexts: [],
      tools: [],
    };
    const out = identity.rewritePromptAssembly(assembled, "", { context: {}, dropMnemon: true });
    const rendered = renders(out.sections);
    assert(!rendered.includes("unknown prompt variable"), "渲染抛错");
    return `${rendered.length} 字节`;
  });

  check("回归：旧版 personaSuffix（{{cwd}}）确实会被宿主拒绝 —— 证明修复有效", () => {
    let threw = "";
    try {
      renders([{ name: "deployment:persona-suffix", order: 10200, text: "Your working directory is {{cwd}}." }]);
    } catch (error) {
      threw = String(error?.message || error);
    }
    assert(threw.includes("unknown prompt variable"), `预期抛错，实际：${threw || "没有抛错"}`);
    assert(threw.includes("deployment:persona-suffix"), "报错没有指到 persona-suffix");
    return threw;
  });

  check("兜底：未经 escape 的未注册变量渲染也不抛错", () => {
    const text = identity.withoutUnregisteredVariables(
      "{{cwd}} and {{model}}",
      { provider: "magpie", model: "deepseek/deepseek-flash" },
    );
    const rendered = renders([{ name: "deployment:persona-suffix", order: 10200, text }]);
    assert(!rendered.includes("{{model}}"), "model 没被插值");
    return rendered;
  });
}

console.log(`\n${passes} passed, ${failures} failed`);
process.exit(failures === 0 ? 0 : 1);
