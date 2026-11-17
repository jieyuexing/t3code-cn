// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - 宿主侧演示脚本，直接驱动子进程、套接字与钥匙串命令。
// 邮箱插件的演示后端：插件仓自带的合成 IMAP 服务，配一条只给演示账号用的常驻测试钥匙串条目。
import * as NodeChildProcess from "node:child_process";
import * as NodeNet from "node:net";

export const MAIL_USER = "you@example.com";
export const MAIL_PASSWORD = "testpass";
const KEYCHAIN_SERVICE = "t3-mail";

export interface DemoMail {
  /** 把收件箱里的 uid 集合（如 `7:10`）移到另一个文件夹，演示 Agent 批准后邮箱真的变了。 */
  readonly move: (uids: string, folder: string) => Promise<void>;
  /** 只按本次启动记下的进程句柄停止；钥匙串条目常驻，不删。可重复调用。 */
  readonly stop: () => void;
}

/** 演示条目只建一次并长期保留：`-A` 让任何程序读它都不弹授权框；已有就原样用，不更新、不删除、不读密码。 */
function ensureKeychainEntry(accountId: string) {
  const find = NodeChildProcess.spawnSync(
    "security",
    ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", accountId],
    { stdio: "ignore" },
  );
  if (find.status === 0) return;
  NodeChildProcess.execFileSync(
    "security",
    ["add-generic-password", "-A", "-s", KEYCHAIN_SERVICE, "-a", accountId, "-w", MAIL_PASSWORD],
    { stdio: "ignore" },
  );
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitListening(port: number) {
  for (let attempt = 0; attempt < 50; attempt++) {
    const open = await new Promise<boolean>((resolve) => {
      const socket = NodeNet.connect(port, "127.0.0.1", () => socket.end(() => resolve(true)));
      socket.on("error", () => resolve(false));
    });
    if (open) return;
    await wait(200);
  }
  throw new Error("演示 IMAP 服务没有起来");
}

/** 最小的 IMAP 客户端：登录、选收件箱、`UID MOVE`、登出，每条命令等到带标签的回复。 */
function imapMove(port: number, uids: string, folder: string) {
  const commands = [
    `LOGIN ${MAIL_USER} ${MAIL_PASSWORD}`,
    "SELECT INBOX",
    `UID MOVE ${uids} ${folder}`,
    "LOGOUT",
  ];
  return new Promise<void>((resolve, reject) => {
    const socket = NodeNet.connect(port, "127.0.0.1");
    let buffer = "";
    let index = -1;
    const send = () => {
      index += 1;
      socket.write(`a${index} ${commands[index]}\r\n`);
    };
    socket.on("error", reject);
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      const lines = buffer.split("\r\n");
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        if (index === -1) {
          if (line.startsWith("* OK")) send();
          continue;
        }
        if (!line.startsWith(`a${index} `)) continue;
        if (!line.startsWith(`a${index} OK`)) {
          socket.destroy();
          reject(new Error(`IMAP ${commands[index]}: ${line}`));
          return;
        }
        if (index === commands.length - 1) {
          socket.end();
          resolve();
          return;
        }
        send();
      }
    });
  });
}

export async function startDemoMail(
  pluginDir: string,
  port: number,
  accountId: string,
): Promise<DemoMail> {
  ensureKeychainEntry(accountId);
  const server = NodeChildProcess.spawn(process.execPath, ["scripts/dev-imap.mjs", String(port)], {
    cwd: pluginDir,
    stdio: "ignore",
  });
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (server.exitCode === null) server.kill("SIGTERM");
  };
  process.on("exit", stop);
  try {
    await waitListening(port);
  } catch (error) {
    stop();
    throw error;
  }
  return { move: (uids, folder) => imapMove(port, uids, folder), stop };
}
