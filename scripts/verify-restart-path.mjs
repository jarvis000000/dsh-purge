/**
 * 重启路径回归：dsh 0.2.1 上必须拿到「优雅退出」适配器。
 *
 * 事故（2026-10-21 14:14 / 14:24 / 14:47 反复）：
 *   插件 apply 后靠 process.exit(0) 让 host 退出，等 PowerShell 先杀 Electron。
 *   抢不过就触发宿主 main.js:3845 的 "host stopped" 崩溃框。
 *
 * 根因：dsh 0.2.1 不再提供 desktopRuntime / desktopActions / requestRestart，
 * desktopRuntimeOf() 恒返回 null，永远走 "no runtime handoff" 分支。
 * 0.2.1 的预期退出协议是 IPC：host → {"type":"shutdown-complete"} → Electron。
 */
import { pathToFileURL } from "node:url";

const desktop = await import(
  pathToFileURL("C:/Users/wangj/.dsh/profiles/desktop/node_modules/dsh-purge/lib/desktop.js").href
);

let failures = 0;
function check(name, fn) {
  try {
    const d = fn();
    console.log(`PASS  ${name}${d ? ` — ${d}` : ""}`);
  } catch (e) {
    failures += 1;
    console.log(`FAIL  ${name} — ${e?.message || e}`);
  }
}
const assert = (c, m) => { if (!c) throw new Error(m); };

const of = desktop._desktopRuntimeOf;
assert(typeof of === "function", "desktopRuntimeOf 未导出");

/** 造一个 0.2.1 桌面宿主的 ctx。 */
const ctx021 = (extra = {}) => {
  const services = new Map([
    ["appExit", () => {}],
    ["cmdlineArgs", { get: () => [] }],
    ["appReady", {}],
  ]);
  for (const [k, v] of Object.entries(extra)) services.set(k, v);
  return { get: (k) => services.get(k) };
};

/** 模拟 Electron fork 出来的 IPC 通道。 */
function withIpc(fn) {
  const sent = [];
  const prevSend = process.send;
  const prevConnected = process.connected;
  process.send = (msg, cb) => { sent.push(msg); if (typeof cb === "function") cb(null); };
  Object.defineProperty(process, "connected", { value: true, configurable: true });
  return Promise.resolve(fn(sent)).finally(() => {
    process.send = prevSend;
    Object.defineProperty(process, "connected", { value: prevConnected, configurable: true });
  });
}

await withIpc(async () => {
  check("0.2.1 形态：能解析出适配器（不再返回 null）", () => {
    const rt = of(ctx021());
    assert(rt, "返回 null → 会走 process.exit 分支，弹崩溃框");
    assert(typeof rt.requestRestart === "function", "缺 requestRestart");
    return "ok";
  });
});

await withIpc(async (sent) => {
  const rt = of(ctx021());
  await rt.requestRestart();
  check("requestRestart() 走 IPC 发 shutdown-complete", () => {
    assert(sent.length > 0, "没有发出任何 IPC 消息");
    const msg = sent.find((m) => m && m.type === "shutdown-complete");
    assert(msg, `发了 ${JSON.stringify(sent)}，但不是 shutdown-complete`);
    return JSON.stringify(msg);
  });
});

check("老服务 desktopRuntime.requestRestart 仍然优先", () => {
  const legacy = { requestRestart: () => "legacy" };
  const rt = of({ get: (k) => (k === "desktopRuntime" ? legacy : undefined) });
  assert(rt === legacy, "旧路径被覆盖了");
  return "legacy";
});

check("非桌面宿主（没有 appExit/cmdlineArgs）返回 null", () => {
  const rt = of({ get: () => undefined });
  assert(rt === null, "web 宿主不该拿到适配器");
  return "null";
});

check("没有 IPC 通道时返回 null（走原兜底）", () => {
  const prevSend = process.send;
  const prevConnected = process.connected;
  process.send = undefined;
  Object.defineProperty(process, "connected", { value: false, configurable: true });
  try {
    const rt = of(ctx021());
    assert(rt === null, "没有 process.send 却给了适配器");
    return "null";
  } finally {
    process.send = prevSend;
    Object.defineProperty(process, "connected", { value: prevConnected, configurable: true });
  }
});

console.log(`\n${failures === 0 ? "all passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
