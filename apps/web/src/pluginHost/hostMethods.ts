// Every method a page may ask of the host with `callHost`, and the capability its plugin's manifest needs.
// `hostApi.ts` implements exactly these; the testkit applies the same check to plugin tests. No imports: plugin repos load this file with plain Node.

const HOST_METHOD_CAPABILITY = {
  "vcs.status": "host.vcs-read",
  "review.diffPreview": "host.vcs-read",
  "review.diffFileContents": "host.vcs-read",
  "t3.openDiff": "host.vcs-read",
  "t3.openPluginSettings": "settings",
  "threads.pending": "host.threads-read",
  "threads.lastReply": "host.threads-read",
  "threads.question": "host.threads-read",
  "t3.openThread": "host.threads-read",
  "threads.snooze": "host.threads-organize",
  "t3.openUrl": "host.open-url",
  "browser.open": "host.browser",
  "browser.profiles": "host.browser",
  "t3.openFile": "host.open-file",
  "t3.addToComposer": "host.composer",
} as const;

export type HostMethod = keyof typeof HOST_METHOD_CAPABILITY;

/** Why the host would deny `method` to a plugin with these capabilities, or `null` if it would let it through. */
export function hostMethodDenial(method: string, capabilities: ReadonlyArray<string>) {
  if (!Object.hasOwn(HOST_METHOD_CAPABILITY, method)) return `The host does not offer "${method}".`;
  const capability = HOST_METHOD_CAPABILITY[method as HostMethod];
  return capabilities.includes(capability)
    ? null
    : `"${method}" needs the ${capability} capability.`;
}
