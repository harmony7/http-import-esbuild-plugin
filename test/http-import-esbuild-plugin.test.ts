import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import {
    httpImportEsbuildPlugin,
    type HttpImportEsbuildPluginParams,
} from "../src/httpImportEsbuildPlugin.js";

/** Save/restore global fetch between tests */
const realFetch = globalThis.fetch;

function setFetchMock(fn: typeof realFetch) {
    globalThis.fetch = fn;
}

function restoreFetch() {
    globalThis.fetch = realFetch;
}

/**
 * Helper: run esbuild with stdin using the plugin.
 * Returns { outputText, result }.
 */
async function runBuild(code: string, pluginParams?: HttpImportEsbuildPluginParams) {
    const result = await build({
        stdin: {
            contents: code,
            resolveDir: process.cwd(),
            sourcefile: "stdin.js",
            loader: "js",
        },
        bundle: true,
        format: "esm",
        write: false,
        logLevel: "silent",
        plugins: [httpImportEsbuildPlugin(pluginParams)],
    });

    const outFile = result.outputFiles[0];
    assert.ok(outFile, "expected a JS output file");
    return { outputText: outFile.text, result };
}

/** Helper to make a Response-like object easily */
function makeResponse(body: BodyInit | null, { status = 200, contentType = "application/javascript" } = {}) {
    return new Response(body, {
        status,
        headers: contentType ? { "content-type": contentType } : undefined,
    });
}

test.afterEach(() => {
    restoreFetch();
});

test("loads absolute https URL entry", async () => {
    setFetchMock(async (info) => {
        const url = String(info);
        assert.equal(url, "https://example.com/a.js");
        return makeResponse("export const a = 1;");
    });

    const { outputText } = await runBuild(`\
import { a } from "https://example.com/a.js";
console.log(a);
`);

    assert.match(outputText, /a\s*=\s*1/);
});

test("leaves bare imports inside http modules untouched", async () => {
    const calls: string[] = [];

    setFetchMock(async (info) => {
        const url = String(info);
        calls.push(url);

        if (url === "https://example.com/a.js") {
            // This module has a *bare* import, which should NOT be rewritten
            return makeResponse(`
import React from "react";

export function useSomething() {
  return React;
}
`);
        }

        // If the plugin ever tries to treat the bare "react" import
        // as an HTTP URL (e.g. https://example.com/react), we'll hit this:
        throw new Error("unexpected url " + url);
    });

    await assert.rejects(
      () => runBuild(`\
import { useSomething } from "https://example.com/a.js";
console.log(useSomething);
`),
      // We don't really care about the specific error here; esbuild
      // will complain it can't resolve "react", which is *expected*.
      () => true,
    );

    // The key assertion: only the top-level URL was ever fetched.
    assert.deepEqual(calls, [
        "https://example.com/a.js",
    ]);
});

test("resolves relative imports inside http namespace", async () => {
    const calls: string[] = [];
    setFetchMock(async (info) => {
        const url = String(info);
        calls.push(url);

        if (url === "https://example.com/a.js") {
            return makeResponse(`
import { b } from "./b.js";
export const a = b + 1;
`);
        }
        if (url === "https://example.com/b.js") {
            return makeResponse(`export const b = 41;`);
        }
        throw new Error("unexpected url " + url);
    });

    const { outputText } = await runBuild(`\
import { a } from "https://example.com/a.js";
console.log(a);
`);

    assert.deepEqual(calls, [
        "https://example.com/a.js",
        "https://example.com/b.js",
    ]);
    assert.match(outputText, /b\s*=\s*41/);
});

test("pathname extension loader wins over content-type", async () => {
    // .ts URL but content-type says js
    setFetchMock(async (info) => {
        const url = String(info);
        assert.equal(url, "https://example.com/mod.ts");
        return makeResponse(`export const x: number = 1;`, {
            status: 200,
            contentType: "application/javascript",
        });
    });

    const { outputText } = await runBuild(`\
import { x } from "https://example.com/mod.ts";
console.log(x);
`);

    // If loader wasn't 'ts', esbuild would throw on ': number'
    assert.match(outputText, /x\s*=\s*1/);
});

test("content-type loader used when no extension", async () => {
    setFetchMock(async (info) => {
        const url = String(info);
        assert.equal(url, "https://example.com/mod");
        return makeResponse(`export const x: number = 2;`, {
            status: 200,
            contentType: "application/typescript; charset=utf-8",
        });
    });

    const { outputText } = await runBuild(`\
import { x } from "https://example.com/mod";
console.log(x);
`);

    // If loader wasn't 'ts', build would fail
    assert.match(outputText, /x\s*=\s*2/);
});

test("falls back to js loader when no ext and unknown content-type", async () => {
    setFetchMock(async (info) => {
        const url = String(info);
        assert.equal(url, "https://example.com/mod");
        return makeResponse(`export const x = 3;`, {
            status: 200,
            contentType: "application/octet-stream",
        });
    });

    const { outputText } = await runBuild(`\
import { x } from "https://example.com/mod";
console.log(x);
`);

    assert.match(outputText, /x\s*=\s*3/);
});

test("multiple downloads of same resource don't cause multiple fetches", async () => {
    let calls = 0;
    setFetchMock(async () => {
        calls++;
        return makeResponse(`export const x = 1;`);
    });

    await runBuild(`\
import "https://example.com/a.js";
import "https://example.com/a.js";
`);

    assert.equal(calls, 1);
});

test("throws on non-OK status", async () => {
    setFetchMock(async () => makeResponse("nope", { status: 404 }));

    await assert.rejects(
        () => runBuild(`import "https://example.com/a.js";`),
        (err) => {
            assert.match(String(err), /GET https:\/\/example\.com\/a\.js failed: status 404/);
            return true;
        }
    );
});

test("aborts fetch on timeout", async () => {
    setFetchMock((_info, init) => {
        const signal = init?.signal;
        assert.ok(signal != null);
        return new Promise((_resolve, reject) => {
            // When abortController.abort() fires, the signal emits an event.
            signal.addEventListener("abort", () => {
                reject(new DOMException("The operation was aborted.", "AbortError"));
            });
            // Never resolve → force timeout path
        });
    });

    await assert.rejects(
        () => runBuild(`import "https://example.com/a.js";`, { timeoutMs: 10 }),
        err => {
            // Test doesn't care about wording, just that it rejects.
            assert.match(String(err), /abort/i);
            return true;
        }
    );
});

test("multiple different URLs are fetched separately and cached separately", async () => {
    const calls = new Set();
    setFetchMock(async (info) => {
        const url = String(info);
        calls.add(url);
        if (url.endsWith("/a.js")) return makeResponse(`export const a = 1;`);
        if (url.endsWith("/b.js")) return makeResponse(`export const b = 2;`);
        throw new Error("unexpected " + url);
    });

    await runBuild(`\
import "https://example.com/a.js";
import "https://example.com/b.js";
import "https://example.com/a.js";
import "https://example.com/b.js";
`);

    assert.deepEqual(calls, new Set([
        "https://example.com/a.js",
        "https://example.com/b.js",
    ]));
});

test("dedupes transitive http imports (b.js loads once)", async () => {
    const callsByUrl = new Map();

    setFetchMock(async (info) => {
        const url = String(info);
        callsByUrl.set(url, (callsByUrl.get(url) ?? 0) + 1);

        if (url === "https://example.com/a.js") {
            return makeResponse(`\
import { b } from "./b.js";
export const a = b + 1;
`);
        }
        if (url === "https://example.com/b.js") {
            return makeResponse(`export const b = 41;`);
        }
        throw new Error("unexpected url " + url);
    });

    const { outputText } = await runBuild(`\
import { a } from "https://example.com/a.js";
import { b } from "https://example.com/b.js";
console.log(a, b);
`);

    // sanity
    assert.match(outputText, /b\s*\+\s*1/);
    assert.equal(callsByUrl.get("https://example.com/a.js"), 1);

    // key assertion
    assert.equal(callsByUrl.get("https://example.com/b.js"), 1);
});
