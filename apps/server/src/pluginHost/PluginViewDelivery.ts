// @effect-diagnostics nodeBuiltinImport:off -- The attachment id is derived from a plain SHA-256 of the page.
// Views reach the browser as MCP apps do: a CSP-injected copy in the attachments directory, served by the signed asset route.
import * as NodeCrypto from "node:crypto";

import { PluginHostError } from "@t3tools/contracts";
import { injectMcpAppCsp, MCP_APP_MAX_HTML_BYTES } from "@t3tools/shared/mcpApp";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { issueAssetUrl } from "../assets/AssetAccess.ts";
import { resolveViewPage } from "./PluginManifestLoader.ts";

/** The attachment id's thread segment; copies are named `plugin-view-<uuid>-html`. */
const ID_PREFIX = "plugin-view";

export interface IssuedViewUrl {
  readonly relativeUrl: string;
  readonly expiresAt: number;
}

export interface PluginViewDeliveryOptions {
  readonly attachmentsDir: string;
  readonly issueUrl: (attachmentId: string) => Effect.Effect<IssuedViewUrl, PluginHostError>;
}

export const makePluginViewDelivery = Effect.fn("PluginViewDelivery.make")(function* (
  options: PluginViewDeliveryOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* Effect.context<FileSystem.FileSystem | Path.Path>();

  /** Writes the page with the CSP injected, once per distinct content, and returns a signed URL for it. */
  const deliver = Effect.fn("PluginViewDelivery.deliver")(function* (input: {
    readonly pluginId: string;
    readonly viewId: string;
    readonly directory: string;
    readonly html: string;
  }) {
    const reject = (reason: string) =>
      new PluginHostError({ reason: "view-rejected", detail: reason });
    const page = yield* resolveViewPage(input.directory, input.html).pipe(
      Effect.provide(platform),
      Effect.mapError((error) => reject(error.reason)),
    );
    const source = yield* fs
      .readFileString(page)
      .pipe(Effect.mapError(() => reject(`${input.html} is not readable.`)));
    if (Buffer.byteLength(source) > MCP_APP_MAX_HTML_BYTES)
      return yield* reject(`${input.html} is larger than ${MCP_APP_MAX_HTML_BYTES} bytes.`);
    const html = injectMcpAppCsp(source, undefined);
    const hash = NodeCrypto.createHash("sha256")
      .update(`${input.pluginId}\0${input.viewId}\0${html}`)
      .digest("hex");
    const attachmentId = `${ID_PREFIX}-${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}-html`;
    const file = path.join(options.attachmentsDir, `${attachmentId}.html`);
    const ioFailed = () =>
      new PluginHostError({ reason: "io-failed", detail: "The view page could not be stored." });
    if (!(yield* fs.exists(file).pipe(Effect.mapError(ioFailed)))) {
      yield* fs
        .makeDirectory(options.attachmentsDir, { recursive: true })
        .pipe(Effect.mapError(ioFailed));
      yield* fs.writeFileString(file, html).pipe(Effect.mapError(ioFailed));
    }
    const issued = yield* options.issueUrl(attachmentId);
    return { file, url: issued.relativeUrl, expiresAt: issued.expiresAt };
  });

  const discard = (files: Iterable<string>) =>
    Effect.forEach(files, (file) => fs.remove(file, { force: true }).pipe(Effect.ignore), {
      discard: true,
    });

  /** Removes copies a previous run left behind. */
  const sweep = Effect.gen(function* () {
    const names = yield* fs
      .readDirectory(options.attachmentsDir)
      .pipe(Effect.orElseSucceed((): Array<string> => []));
    yield* discard(
      names
        .filter((name) => name.startsWith(`${ID_PREFIX}-`))
        .map((name) => path.join(options.attachmentsDir, name)),
    );
  });

  return { deliver, discard, sweep };
});
export type PluginViewDelivery = Effect.Success<ReturnType<typeof makePluginViewDelivery>>;

/**
 * Signs a URL for a delivered page on the asset route, the way MCP apps are signed.
 * The CLI also builds the host layer without the asset services, so they are looked up
 * when a view is read, in the RPC handler's context, which has them; the cast only drops
 * the type-level requirement.
 */
export const issueViewUrl = (attachmentId: string) => {
  const issued = issueAssetUrl({
    resource: {
      _tag: "attachment",
      attachmentId,
      mimeType: "text/html",
      disposition: "inline",
      renderIntent: "mcp-app",
    },
  });
  // @effect-diagnostics-next-line unsafeEffectTypeAssertion:off -- see the comment above.
  const withoutRequirements = issued as Effect.Effect<IssuedViewUrl, Effect.Error<typeof issued>>;
  return withoutRequirements.pipe(
    Effect.catchCause(() =>
      Effect.fail(
        new PluginHostError({ reason: "io-failed", detail: "The view URL could not be issued." }),
      ),
    ),
  );
};
