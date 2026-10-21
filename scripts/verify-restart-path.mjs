/**
 * 重启路径回归：0.2.1 上不能再伪造 shutdown-complete。
 *
 * Electron 侧 main.js:3833 的判定是：
 *   if (message.type === "shutdown-complete") if (this.stopping) this.shutdownCompleted = true;
 *   else this.fail(new Error("dsh desktop host acknowledged an unrequested shutdown"));
 *
 * this.stopping 只有 Electron 自己的 stop() 会置位（它先发 {type:"shutdown"} 给 host），
 * host 单方面发 shutdown-complete 会被判成异常。
 * 实测 2026-10-21 14:29:52 就崩在这一行：acknowledged an unrequested shutdown。
 *
 * 正确做法：只断开 IPC，不发那条消息。
 */
import { pathToFileURL } from "node:url";

const desktop = await import(
  pathToFileURL("C:/Users/wangj/.dsh/profiles/desktop/node_modules/dsh-purge/lib/desktop.js").href
);

let failures = 0;
function check(name, fn) {
  try {
    const detail = fn();
    console.log(`PASS  ${name}${detail ? ` — ${detail}` : ""}`);
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

/** 模拟 Electron fork 出来的 IPC 通道，记录 send 与 disconnect。 */
function withIpc(fn) {
  const sent = [];
  let disconnected = 0;
  const prevSend = process.send;
  const prevDisconnect = process.disconnect;
  const prevConnected = process.connected;
  process.send = (msg, cb) => {
    sent.push(msg);
    if (typeof cb === "function") cb(null);
  };
  process.disconnect = () => { disconnected += 1; };
  Object.defineProperty(process, "connected", { value: true, configurable: true });
  return Promise.resolve(fn(sent, () => disconnected)).finally(() => {
    process.send = prevSend;
    process.disconnect = prevDisconnect;
    Object.defineProperty(process, "connected", { value: prevConnected, configurable: true });
  });
}

await withIpc(async () => {
  check("0.2.1 形态：能解析出适配器（不再返回 null）", () => {
    const rt = of(ctx021());
    assert(rt, "返回 null → 会走 process.exit 分支，弹崩溃框");
    assert(typeof rt.requestRestart === "function", "缺 requestRestart");
    assert(rt.kind === "ipc-disconnect", `kind 应为 ipc-disconnect，实际 ${rt.kind}`);
    return rt.kind;
  });
});

await withIpc(async (sent, discos) => {
  const rt = of(ctx021());
  await rt.requestRestart();
  check("requestRestart() 只断开 IPC，绝不发 shutdown-complete", () => {
    const bad = sent.filter((m) => m && m.type === "shutdown-complete");
    assert(bad.length === 0, "发了 shutdown-complete，Electron 会报 unrequested shutdown");
    assert(discos() === 1, `disconnect 调用 ${discos()} 次，应为 1`);
    return `sent=${JSON.stringify(sent)} disconnect=${discos()}`;
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
