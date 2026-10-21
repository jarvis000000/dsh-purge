/**
 * 启动冒烟：在没有 Electron 宿主的普通 node 进程里 import 插件并调用 apply()，
 * 用一个尽量像 cordis 的假 ctx。目的只有一个——apply() 不能抛错（抛错 = 宿主把插件判为未激活）。
 *
 * 用法：node scripts/smoke-apply.mjs
 */
import { fileURLToPath, pathToFileURL } from "node:url";
import { join } from "node:path";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
process.env.DSH_HOME ||= join(pkgRoot, ".smoke-home");

const events = new Map();
const disposers = [];
function makeCtx(extra = {}) {
  const ctx = {
    systemPrompt: {
      section: () => () => {},
      context: () => () => {},
      suppressRuntimeContext: () => () => {},
      variable: () => () => {},
      tools: () => () => {},
      getSectionOrder: () => 0,
      getContextOrder: () => 0,
    },
    tools: { register: () => () => {} },
    effect: (fn) => {
      const d = typeof fn === "function" ? fn() : void 0;
      if (typeof d === "function") disposers.push(d);
      return d;
    },
    on: (name, fn) => {
      if (!events.has(name)) events.set(name, []);
      events.get(name).push(fn);
      return () => {
        const list = events.get(name) || [];
        const i = list.indexOf(fn);
        if (i >= 0) list.splice(i, 1);
      };
    },
    get: () => undefined,
    inject: () => () => {},
    emit: () => {},
    logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} },
    ...extra,
  };
  ctx.ctx = ctx;
  return ctx;
}

let failures = 0;
const mod = await import(pathToFileURL(join(pkgRoot, "lib/index.js")).href);

function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures += 1;
    console.log(`FAIL  ${name} — ${error?.message || error}`);
  }
}

check("模块导出 apply / name / inject", () => {
  if (typeof mod.apply !== "function") throw new Error("apply 不是函数");
  if (mod.name !== "dsh-purge") throw new Error(`name = ${mod.name}`);
  if (!Array.isArray(mod.inject)) throw new Error("inject 不是数组");
});

check("apply() 在最小 ctx 下不抛错", () => {
  mod.apply(makeCtx(), {
    enabled: true,
    autoApplyOnStart: false,
    autoUpdateOnStart: false,
    autoRevertOnMissing: false,
    stripMnemon: true,
    capabilityProtocol: true,
    hooksDenyBypass: true,
    postPrompt: "post body with {{cwd}} inside",
  });
});

check("apply() 在空 ctx 下也不抛错（防御）", () => {
  try {
    mod.apply({}, { enabled: true });
  } catch (error) {
    throw new Error(String(error?.message || error));
  }
});

check("apply() 挂了 system-prompt/assemble 监听", () => {
  const list = events.get("system-prompt/assemble") || [];
  if (list.length === 0) throw new Error("没有挂 assemble 监听");
});

for (const d of disposers) {
  try { d(); } catch { /* 清理失败不影响结论 */ }
}

console.log(`\n${failures === 0 ? "smoke ok" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
