// @effect-diagnostics nodeBuiltinImport:off -- Binary fixtures exercise the build input byte validator.
import { describe, expect, it } from "vite-plus/test";
import {
  validateTemplateMembers,
  verifyOfficialTemplate,
  assertX64Binary,
} from "./cli-official-template-cn.ts";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

const stem = "t3-0.0.46-nightly.20261008.2833-linux-x64";
const members = [
  stem,
  ...["node_modules", "resource-monitor", "client", "t3"].map((name) => `${stem}/${name}`),
];
describe("official template safety", () => {
  it.each([
    `${stem}/../escape`,
    "/absolute",
    `${stem}/node_modules/../../escape`,
    `${stem}/a\\b`,
    "another-root/a",
  ])("rejects unsafe path %s", (bad) => {
    expect(() =>
      validateTemplateMembers([...members, bad], [...members.map(() => "d"), "-"], stem),
    ).toThrow();
  });
  it.each(["l", "h", "b", "c", "p"])("rejects link or special type %s", (type) => {
    expect(() => validateTemplateMembers(members, [type, "d", "d", "d", "-"], stem)).toThrow();
  });
  it("accepts regular files and directories only", () => {
    expect(() => validateTemplateMembers(members, ["d", "d", "d", "d", "-"], stem)).not.toThrow();
  });
  it("rejects a wrong architecture before packaging", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "zh-arch-test-"));
    try {
      const file = NodePath.join(dir, "binary");
      NodeFS.writeFileSync(file, Buffer.alloc(128));
      expect(() => assertX64Binary(file, "linux")).toThrow("Expected Linux x64");
      expect(() => assertX64Binary(file, "win")).toThrow("Expected Windows x64");
    } finally {
      NodeFS.rmSync(dir, { recursive: true });
    }
  });
  it("rejects unsupported template target before looking up sources", () => {
    expect(() =>
      verifyOfficialTemplate({
        repoRoot: "missing",
        hostPlatform: "darwin",
        archive: "missing",
        metadata: "missing",
        sums: "missing",
        version: "bad",
        platform: "mac",
        arch: "arm64",
      }),
    ).toThrow("only supports");
  });
});
