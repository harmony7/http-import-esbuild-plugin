import type { Loader, Plugin } from 'esbuild';

export type HttpImportEsbuildPluginParams = {
  namespace?: string,
  onLog?: (message: string) => void,
  timeoutMs?: number,
  loaderResolver?: LoaderResolver,
};

export type LoaderResolver = (
  args: { path: string, namespace: string, with: Record<string, string>, },
  res: Response,
) => (LoaderResolverResult | Promise<LoaderResolverResult>);

export type LoaderResolverResult = Loader | null | undefined;

export function httpImportEsbuildPlugin(params?: HttpImportEsbuildPluginParams): Plugin {
  const namespace = params?.namespace ?? '_http_url';
  const timeoutMs = params?.timeoutMs ?? 30_000;
  const loaderResolver = params?.loaderResolver;

  // Keep a map of resolved paths in case modules redirect
  const pathToResolvedUrl = new Map<string, string>();

  return {
    name: 'http-import',
    setup(build) {
      // Absolute http(s) entry or import
      build.onResolve({ filter: /^https?:\/\// }, args => ({
        path: args.path,
        namespace,
      }));

      // Relative import inside an http(s) module
      build.onResolve({ filter: /.*/, namespace }, args => {
        const base = pathToResolvedUrl.get(args.importer) ?? args.importer;
        return ({
          path: new URL(args.path, base).toString(),
          namespace,
        });
      });

      build.onLoad({ filter: /.*/, namespace }, async (args) => {
        params?.onLog?.(`Downloading: ${args.path}`);

        const abortController = new AbortController();
        const timer = setTimeout(() => abortController.abort(), timeoutMs);

        let res: Response;
        try {
          // NOTE: This also follows redirects, as { redirect: 'follow' } by default
          res = await fetch(args.path, { signal: abortController.signal });
        } finally {
          clearTimeout(timer);
        }

        if (!res.ok) {
          throw new Error(`GET ${args.path} failed: status ${res.status}`);
        }

        const resolvedUrl = res.url || args.path; // res.url is empty string in tests
        pathToResolvedUrl.set(args.path, resolvedUrl);

        const contents = new Uint8Array(await res.arrayBuffer());

        const loader =
          (loaderResolver != null ? await loaderResolver({path: args.path, namespace: args.namespace, with: args.with}, res) : null) ??
          loaderFromPathname(new URL(args.path).pathname) ??
          loaderFromContentType(res.headers.get("content-type")) ??
          "js";

        return { contents, loader };
      });
    },
  };
}
const EXT_TO_LOADER: Record<string, Loader> = {
  js: "js",
  mjs: "js",
  cjs: "js",
  ts: "ts",
  mts: "ts",
  cts: "ts",
  jsx: "jsx",
  tsx: "tsx",
  json: "json",
  css: "css",
  txt: "text",
};

function loaderFromPathname(pathname: string): Loader | undefined {
  const last = pathname.split("/").pop() ?? "";
  const dot = last.lastIndexOf(".");
  if (dot <= 0) {
    return undefined;
  }

  const ext = last.slice(dot + 1).toLowerCase();
  return EXT_TO_LOADER[ext];
}

function loaderFromContentType(contentType: string | null): Loader | undefined {
  if (contentType == null) {
    return undefined;
  }
  const t = contentType.split(';')[0].trim().toLowerCase();
  switch (t) {
    case 'application/javascript':
    case 'text/javascript':
      return 'js';
    case 'application/typescript':
    case 'text/typescript':
      return 'ts';
    case 'application/json':
    case 'text/json':
      return 'json';
    case 'text/css':
      return 'css';
    case 'text/plain':
      return 'text';
  }
  return undefined;
}
