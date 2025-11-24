# HTTP Import esbuild plugin

An esbuild plugin that resolves `http:` / `https:` imports.

> [!WARNING]  
> This loads remote code. Builds may be non-deterministic if URLs change. Pin versions as appropriate and use trusted CDNs only.

This esbuild plugin resolves imports from HTTP(S) URLs as though they are local files, including relative imports within those remote modules.

It works especially well with CDNs like [unpkg](https://unpkg.com/) because bare package URLs redirect to real files (usually ending in `.js`), allowing esbuild to infer loaders correctly.

This plugin was inspired by esbuild's official [HTTP plugin example](https://esbuild.github.io/plugins/#http-plugin).

## Usage

```sh
npm i esbuild @h7/http-import-esbuild-plugin
```

```js
import * as esbuild from 'esbuild';
import { httpImportEsbuildPlugin } from '@h7/http-import-esbuild-plugin';

export async function bundle(infile, outfile) {
  await esbuild.build({
    entryPoints: [infile],
    bundle: true,
    outfile,
    plugins: [httpImportEsbuildPlugin()],
    format: 'esm',
  });
}
```

Example source file:
```js
import { marked } from 'https://unpkg.com/marked';

console.log(
    marked.parse('# Marked output\n\nRendered by **marked**.')
);
```

## Notes

- Requires Node 18+ (global `fetch`).
- For esbuild `^0.27.0`.
- The URL becomes the module's identifier for the purpose of caching. For example, multiple imports to `'https://unpkg.com/marked'` would resolve a single instance of the module, but importing `'marked'` in the same execution unit would resolve to a separate instance.

## License

MIT
