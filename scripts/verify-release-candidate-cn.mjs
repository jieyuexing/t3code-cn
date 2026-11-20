#!/usr/bin/env node
import * as NodeUtil from "node:util";
import { readJson, assertCandidate } from "./release-source-cn.mjs";
import { auditDmg, smokeCli } from "./candidate-target-checks-cn.mjs";
import { verifyReceipt } from "./release-validation-cn.mjs";
const { values } = NodeUtil.parseArgs({
  options: {
    "audit-dmg": { type: "boolean" },
    "smoke-cli": { type: "boolean" },
    ...Object.fromEntries(
      ["artifact", "candidate", "output", "receipt"].map((n) => [n, { type: "string" }]),
    ),
  },
});
if (!values.artifact || !values.candidate) throw new Error("Required: --artifact --candidate");
if (values["audit-dmg"] && values["smoke-cli"]) throw new Error("Choose one target operation");
if (values["audit-dmg"] || values["smoke-cli"]) {
  if (!values.output) throw new Error("--output (new directory) required");
  await (values["audit-dmg"] ? auditDmg : smokeCli)({
    artifact: values.artifact,
    candidateFile: values.candidate,
    output: values.output,
  });
  console.log("Target receipt created; replay with --receipt before suite preflight");
} else {
  const candidate = readJson(values.candidate);
  assertCandidate(candidate, values.artifact);
  if (!values.receipt) throw new Error("Target validation pending: --receipt required");
  console.log(JSON.stringify(verifyReceipt(candidate, values.receipt)));
}
