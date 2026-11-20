# @t3-plugin-host/cordis

An optional adapter for writing T3 Code plugins as [Cordis](https://github.com/cordiverse/cordis) 4 plugins. The host does not depend on it: a plugin that does not import it works as before.

The adapter runs a real Cordis context inside the plugin's process.

- Services the host forwards (`inject` in `plugin.json`) appear as `ctx["<service name>"]`.
- The host's plugin context is the service `t3`: use `ctx.t3.log`, `ctx.t3.handle`, `ctx.t3.settings`, `ctx.t3.storage` after adding `"t3"` to the Cordis plugin's `inject`.
- The services listed under `provides` in `plugin.json` are taken from the Cordis context by name, and their methods are registered with the host. The method names come from the manifest, so they are written once. Each method is called as `method(input, meta)`, where `meta.caller` says who is calling.

## Install

The package is not published, and npm cannot install a sub-directory of a Git repository. Install it from a local copy of this directory:

```sh
(cd path/to/plugin-host-cordis && npm pack)   # writes t3-plugin-host-cordis-0.1.0.tgz
npm install path/to/plugin-host-cordis/t3-plugin-host-cordis-0.1.0.tgz
```

`npm install path/to/plugin-host-cordis` also works (a symlink), once `npm install` has run in that directory.

Use an install that keeps `node_modules` inside the plugin directory, since the child process loads the entry with a plain `import` and no build step. The entry must be plain JavaScript that Node runs as it is (`.mjs`).

## Minimal plugin

`plugin.json`:

```json
{
  "name": "example.counter",
  "version": "0.1.0",
  "extensions": {
    "com.jieyuexing.t3code": {
      "apiVersion": 1,
      "entry": "./index.mjs",
      "capabilities": ["settings"],
      "inject": ["example.clock"],
      "provides": [
        {
          "name": "example.counter",
          "methods": [{ "name": "get", "readOnly": true, "ui": true }]
        }
      ]
    }
  }
}
```

`index.mjs`:

```js
import { Service, cordisPlugin } from "@t3-plugin-host/cordis";

class Counter extends Service {
  static inject = ["t3", "example.clock"];

  constructor(ctx) {
    super(ctx, "example.counter");
    ctx.effect(() => () => ctx.t3.log.info("counter stopped"));
  }

  async get() {
    return { value: (await this.ctx.t3.storage.get("count")) ?? 0 };
  }
}

export const { activate, deactivate } = cordisPlugin(Counter);
```

A complete example with state and a call to another plugin is in [`example/`](./example).

`cordisPlugin(plugin, config?)` takes a `Service` class or a plugin object (`{ inject, apply }`) and returns the `activate` and `deactivate` functions the host expects. Import Cordis's own exports (`Service`, `Context`, ...) from this package too, so the plugin runs on the Cordis copy pinned here.

## Differences from writing a T3 plugin directly

- Activation fails with a reason when the Cordis plugin is waiting for a service nobody provides (the missing names are listed), when a service in `provides` was not provided, when a declared method is not a function, or when `apply` throws. A plain Cordis context would stay pending without telling the host.
- Cleanup goes through `ctx.effect(() => () => ...)`; `deactivate` disposes the plugin so it runs. Cordis 4 does not fire `ctx.on("dispose")`.
- Only the services listed under `provides` in `plugin.json` reach the host. Services that Cordis plugins provide to one another inside the process stay private.
- Not forwarded: events, `intercept`, `isolate`, Cordis's loader and config reloading.

## Version

Cordis is pinned to an exact version in `package.json` (`4.0.0-rc.12`), so plugins built on this adapter all run on the same one. Move it here and nowhere else.

## Tests

```sh
npm install
npm test
```

The last test runs `example/` in the host's real child runtime (`apps/server/src/pluginHost/childRuntime.ts`), so it needs this directory inside a T3 Code checkout and a Node that runs `.ts` files directly.
