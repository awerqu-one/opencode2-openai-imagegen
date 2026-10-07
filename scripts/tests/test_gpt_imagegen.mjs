import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  MAX_CODEX_RESPONSE_BYTES,
  MAX_GENERATED_PNG_BYTES,
  parseImageGenerationResultFromSSE,
  requestGeneratedPng,
  validateGeneratedPngEncodedLength,
  validateOutputPath,
  validateSize,
} from "../../.opencode/plugins/gpt-imagegen.js"
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  truncate,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path"
import gptImagegenPlugin from "../../.opencode/plugins/gpt-imagegen.js"

const ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
const MIB = 1024 * 1024
const MAX_REFERENCE_BYTES = 20 * MIB
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const GENERATED_PNG = Buffer.concat([PNG_SIGNATURE, Buffer.from([0x00, 0x00, 0x00, 0x00, 0x01])])
const OAUTH_CREDENTIAL = {
  type: "oauth",
  access: "unit-test-oauth-token-not-real",
  metadata: { accountID: "unit-test-chatgpt-account" },
}

function makeRegistry() {
  const registry = Object.create(null)
  const register = (nameOrDefinition, maybeDefinition) => {
    const definition = maybeDefinition ?? nameOrDefinition
    const name = typeof nameOrDefinition === "string" ? nameOrDefinition : definition?.name
    if (typeof name !== "string") throw new TypeError("Registered tools must have a name")
    registry[name] = definition
    return registry
  }

  Object.defineProperties(registry, {
    register: { value: register },
    add: { value: register },
    set: { value: register },
    tools: { get: () => registry },
  })
  return registry
}

async function setupPlugin(project, options = {}) {
  const activeConnection = Object.hasOwn(options, "activeConnection")
    ? options.activeConnection
    : { providerID: "openai" }
  const credential = Object.hasOwn(options, "credential") ? options.credential : OAUTH_CREDENTIAL
  const registry = makeRegistry()
  let transformCount = 0
  let resolveCount = 0
  let activeProvider

  const context = {
    location: { directory: project },
    tool: {
      transform: async (transformer, definition) => {
        transformCount += 1
        if (typeof transformer === "function") {
          const transformed = await transformer(registry)
          if (transformed && typeof transformed === "object") Object.assign(registry, transformed)
        } else if (typeof transformer === "string" && definition) {
          registry[transformer] = definition
        } else if (transformer && typeof transformer === "object") {
          Object.assign(registry, transformer)
        }
      },
    },
    integration: {
      connection: {
        active: async (provider) => {
          activeProvider = provider
          return activeConnection
        },
        resolve: async (connection) => {
          resolveCount += 1
          assert.equal(connection, activeConnection)
          return credential
        },
      },
    },
  }

  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => {
    throw new Error("Unexpected network request during plugin setup")
  }
  try {
    await gptImagegenPlugin.setup(context)
  } finally {
    globalThis.fetch = originalFetch
  }
  return {
    context,
    tool: registry.gpt_imagegen,
    transformCount,
    get activeProvider() { return activeProvider },
    get resolveCount() { return resolveCount },
  }
}

async function makeProject(t) {
  const parent = await mkdtemp(join(tmpdir(), "gpt-imagegen-test-"))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const project = join(parent, "project")
  await mkdir(project)
  return { parent, project }
}

async function withMockFetch(mockFetch, run) {
  const originalFetch = globalThis.fetch
  globalThis.fetch = mockFetch
  try {
    return await run()
  } finally {
    globalThis.fetch = originalFetch
  }
}

function sseImageResponse(imageBytes = GENERATED_PNG) {
  const data = JSON.stringify({
    type: "response.output_item.done",
    item: {
      type: "image_generation_call",
      result: imageBytes.toString("base64"),
    },
  })
  return new Response(`data: ${data}\n\n`, {
    status: 200,
    headers: { "content-type": "text/event-stream" },
  })
}

function baseArgs(overrides = {}) {
  return {
    prompt: "A small unit-test illustration",
    out: "generated.png",
    quality: "high",
    size: "1024x1024",
    ...overrides,
  }
}

function resultText(value, seen = new Set()) {
  if (value instanceof Error) return `${value.name}: ${value.message}`
  if (typeof value === "string") return value
  if (!value || typeof value !== "object" || seen.has(value)) return ""
  seen.add(value)
  if (Array.isArray(value)) return value.map((entry) => resultText(entry, seen)).join(" ")
  return Object.entries(value).map(([key, entry]) => `${key} ${resultText(entry, seen)}`).join(" ")
}

async function expectToolError(invoke, messagePattern) {
  let outcome
  try {
    outcome = await invoke()
  } catch (error) {
    outcome = error
  }
  const text = resultText(outcome)
  assert.match(text, messagePattern, `Expected an actionable tool error; got: ${text}`)
  return text
}

async function writePng(path, extra = Buffer.alloc(0)) {
  const bytes = Buffer.concat([PNG_SIGNATURE, extra])
  await writeFile(path, bytes)
  return bytes
}

async function writeSparsePng(path, size) {
  await writeFile(path, PNG_SIGNATURE)
  await truncate(path, size)
}

async function listFiles(root) {
  const files = []
  const visit = async (directory) => {
    let entries
    try {
      entries = await readdir(directory, { withFileTypes: true })
    } catch (error) {
      if (error.code === "ENOENT") return
      throw error
    }
    for (const entry of entries) {
      const path = join(directory, entry.name)
      if (entry.isDirectory()) await visit(path)
      else files.push(path)
    }
  }
  await visit(root)
  return files
}

function assertWithin(child, root) {
  const pathFromRoot = relative(resolve(root), resolve(child))
  assert.ok(
    pathFromRoot &&
      pathFromRoot !== ".." &&
      !pathFromRoot.startsWith(`..${sep}`) &&
      !isAbsolute(pathFromRoot),
    `Expected ${child} to be inside ${root}`,
  )
}

function executeTool(plugin, project, args) {
  return plugin.tool.execute(args, { directory: project })
}

function bodyText(body) {
  if (typeof body === "string") return body
  if (body instanceof ArrayBuffer) return Buffer.from(body).toString("utf8")
  if (ArrayBuffer.isView(body)) {
    return Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString("utf8")
  }
  return JSON.stringify(body ?? "")
}

describe("OpenCode V2 GPT ImageGen plugin", { concurrency: false }, () => {
  it("registers gpt_imagegen through the structural setup API", async (t) => {
    const { project } = await makeProject(t)
    const plugin = await setupPlugin(project)

    assert.equal(gptImagegenPlugin.id, "opencode-gpt-imagegen-project")
    assert.equal(typeof gptImagegenPlugin.setup, "function")
    assert.equal(plugin.transformCount, 1)
    assert.equal(plugin.activeProvider, undefined)
    assert.equal(plugin.resolveCount, 0)
    assert.ok(plugin.tool, "ctx.tool.transform should register gpt_imagegen")
    assert.equal(typeof plugin.tool.execute, "function")
  })

  it("does not fetch without an active OAuth connection or with an API-key credential", async (t) => {
    const { project } = await makeProject(t)
    let fetchCalls = 0

    await withMockFetch(async () => {
      fetchCalls += 1
      return sseImageResponse()
    }, async () => {
      const noConnection = await setupPlugin(project, { activeConnection: undefined })
      await expectToolError(
        () => executeTool(noConnection, project, baseArgs()),
        /connect|oauth|authentication|credential/i,
      )
      assert.equal(noConnection.activeProvider, "openai")
      assert.equal(noConnection.resolveCount, 0)

      const missingCredential = await setupPlugin(project, { credential: null })
      await expectToolError(
        () => executeTool(missingCredential, project, baseArgs()),
        /connect|oauth|authentication|credential/i,
      )
      assert.equal(missingCredential.resolveCount, 1)

      const apiKeyOnly = await setupPlugin(project, {
        credential: { type: "api", key: "unit-test-api-key-not-real" },
      })
      await expectToolError(
        () => executeTool(apiKeyOnly, project, baseArgs()),
        /oauth|chatgpt|codex|credential|authentication/i,
      )
      assert.equal(apiKeyOnly.activeProvider, "openai")
      assert.equal(apiKeyOnly.resolveCount, 1)
      assert.equal(fetchCalls, 0)
    })
  })

  it("parses a mocked SSE image, accepts five in-project references, and saves only under generated-images", async (t) => {
    const { project } = await makeProject(t)
    const references = []
    const referenceBytes = []
    for (let index = 0; index < 5; index += 1) {
      const path = join(project, `reference-${index}.png`)
      const bytes = await writePng(path, Buffer.from([index + 1]))
      references.push(path)
      referenceBytes.push(bytes)
    }

    const plugin = await setupPlugin(project)
    const requests = []
    const result = await withMockFetch(async (input, init) => {
      const requestBody = init?.body ?? (input instanceof Request ? await input.clone().text() : undefined)
      requests.push({
        url: input instanceof Request ? input.url : String(input),
        body: bodyText(requestBody),
        redirect: init?.redirect,
        accountId: new Headers(init?.headers).get("chatgpt-account-id"),
      })
      return sseImageResponse()
    }, () => executeTool(plugin, project, baseArgs({ images: references })))

    assert.equal(requests.length, 1)
    assert.equal(requests[0].url, ENDPOINT)
    assert.equal(requests[0].redirect, "error")
    assert.equal(requests[0].accountId, "unit-test-chatgpt-account")
    for (const bytes of referenceBytes) {
      assert.ok(requests[0].body.includes(bytes.toString("base64")), "each accepted reference should be encoded in the request")
    }

    const outputRoot = join(project, ".opencode", "generated-images")
    const outputFiles = await listFiles(outputRoot)
    assert.equal(outputFiles.length, 1)
    assertWithin(outputFiles[0], outputRoot)
    assert.deepEqual(await readFile(outputFiles[0]), GENERATED_PNG)
    assert.ok(resultText(result).includes(basename(outputFiles[0])), "the tool result should identify the saved image")
  })

  it("rejects outside-project references and symlink escapes before fetching", async (t) => {
    const { parent, project } = await makeProject(t)
    const outside = join(parent, "outside.png")
    await writePng(outside)
    const escapedLink = join(project, "linked-reference.png")
    try {
      await symlink(outside, escapedLink)
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) return t.skip(`symlinks unavailable: ${error.code}`)
      throw error
    }

    const plugin = await setupPlugin(project)
    let fetchCalls = 0
    await withMockFetch(async () => {
      fetchCalls += 1
      return sseImageResponse()
    }, async () => {
      await expectToolError(
        () => executeTool(plugin, project, baseArgs({ images: [outside] })),
        /project|outside|path|reference|image/i,
      )
      await expectToolError(
        () => executeTool(plugin, project, baseArgs({ images: ["linked-reference.png"] })),
        /project|outside|symlink|path|reference|image/i,
      )
      assert.equal(fetchCalls, 0)
    })
  })

  it("rejects unsupported reference signatures before fetching", async (t) => {
    const { project } = await makeProject(t)
    const unsupported = join(project, "looks-like-image.png")
    await writeFile(unsupported, Buffer.from("not an image signature"))
    const plugin = await setupPlugin(project)
    let fetchCalls = 0

    await withMockFetch(async () => {
      fetchCalls += 1
      return sseImageResponse()
    }, async () => {
      await expectToolError(
        () => executeTool(plugin, project, baseArgs({ images: [unsupported] })),
        /signature|unsupported|format|image|invalid/i,
      )
      assert.equal(fetchCalls, 0)
    })
  })

  it("bounds the total Codex SSE response size", async () => {
    const oversizedChunk = new Proxy(new Uint8Array([0]), {
      get(target, property) {
        if (property === "byteLength") return MAX_CODEX_RESPONSE_BYTES + 1
        return Reflect.get(target, property, target)
      },
    })
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(oversizedChunk)
      },
    })

    await assert.rejects(
      parseImageGenerationResultFromSSE(stream),
      /72 MiB|response.*limit/i,
    )
  })

  it("bounds the decoded PNG size before base64 decoding", () => {
    const maximumEncodedLength = Math.ceil(MAX_GENERATED_PNG_BYTES / 3) * 4
    assert.doesNotThrow(() => validateGeneratedPngEncodedLength(maximumEncodedLength))
    assert.throws(
      () => validateGeneratedPngEncodedLength(maximumEncodedLength + 1),
      /50 MiB.*limit/i,
    )
  })

  it("enforces the five-reference, 20 MiB per-file, and 50 MiB aggregate limits", async (t) => {
    const { project } = await makeProject(t)
    const plugin = await setupPlugin(project)
    const sixSmall = []
    for (let index = 0; index < 6; index += 1) {
      const path = join(project, `count-${index}.png`)
      await writePng(path, Buffer.from([index]))
      sixSmall.push(path)
    }

    const tooLarge = join(project, "over-per-file-limit.png")
    await writeSparsePng(tooLarge, MAX_REFERENCE_BYTES + 1)

    const aggregate = []
    for (let index = 0; index < 3; index += 1) {
      const path = join(project, `aggregate-${index}.png`)
      await writeSparsePng(path, 17 * MIB)
      aggregate.push(path)
    }

    let fetchCalls = 0
    await withMockFetch(async () => {
      fetchCalls += 1
      return sseImageResponse()
    }, async () => {
      await expectToolError(
        () => executeTool(plugin, project, baseArgs({ images: sixSmall })),
        /5|five|count|maximum|limit|too many/i,
      )
      await expectToolError(
        () => executeTool(plugin, project, baseArgs({ images: [tooLarge] })),
        /20|size|large|limit|maximum|exceed/i,
      )
      await expectToolError(
        () => executeTool(plugin, project, baseArgs({ images: aggregate })),
        /50|combined|aggregate|total|size|limit|large|exceed/i,
      )
      assert.equal(fetchCalls, 0)
    })
  })

  it("preserves an existing output and writes the next versioned name", async (t) => {
    const { project } = await makeProject(t)
    const outputRoot = join(project, ".opencode", "generated-images")
    await mkdir(outputRoot, { recursive: true })
    const originalPath = join(outputRoot, "scene.png")
    const originalBytes = Buffer.from("pre-existing-user-file")
    await writeFile(originalPath, originalBytes)

    const plugin = await setupPlugin(project)
    const result = await withMockFetch(async () => sseImageResponse(), () =>
      executeTool(plugin, project, baseArgs({ out: "scene.png" })),
    )

    assert.deepEqual(await readFile(originalPath), originalBytes)
    const versionedPath = join(outputRoot, "scene-v2.png")
    assert.deepEqual(await readFile(versionedPath), GENERATED_PNG)
    assertWithin(await realpath(versionedPath), await realpath(outputRoot))
    assert.match(resultText(result), /scene-v2\.png/)
  })

  it("rejects an output symlink escape without modifying its external target", async (t) => {
    const { parent, project } = await makeProject(t)
    const outputRoot = join(project, ".opencode", "generated-images")
    await mkdir(outputRoot, { recursive: true })
    const outside = join(parent, "protected-outside.png")
    const protectedBytes = Buffer.from("keep-this-file-unchanged")
    await writeFile(outside, protectedBytes)
    try {
      await symlink(outside, join(outputRoot, "escape.png"))
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) return t.skip(`symlinks unavailable: ${error.code}`)
      throw error
    }

    const plugin = await setupPlugin(project)
    let fetchCalls = 0
    await withMockFetch(async () => {
      fetchCalls += 1
      return sseImageResponse()
    }, async () => {
      await expectToolError(
        () => executeTool(plugin, project, baseArgs({ out: "escape.png" })),
        /project|outside|symlink|path|output|destination/i,
      )
      assert.equal(fetchCalls, 0)
    })
    assert.deepEqual(await readFile(outside), protectedBytes)
    assert.equal((await lstat(join(outputRoot, "escape.png"))).isSymbolicLink(), true)
  })

  it("rejects an output-root symlink escape before fetching", async (t) => {
    const { parent, project } = await makeProject(t)
    const opencodeDirectory = join(project, ".opencode")
    const outsideOutput = join(parent, "outside-output")
    await mkdir(opencodeDirectory)
    await mkdir(outsideOutput)
    try {
      await symlink(outsideOutput, join(opencodeDirectory, "generated-images"), "dir")
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) return t.skip(`symlinks unavailable: ${error.code}`)
      throw error
    }

    const plugin = await setupPlugin(project)
    let fetchCalls = 0
    await withMockFetch(async () => {
      fetchCalls += 1
      return sseImageResponse()
    }, async () => {
      await expectToolError(
        () => executeTool(plugin, project, baseArgs()),
        /symlink|outside|project|output|generated-images/i,
      )
      assert.equal(fetchCalls, 0)
    })
    assert.deepEqual(await readdir(outsideOutput), [])
  })

  it("rejects a directory used as the output filename before fetching", async (t) => {
    const { project } = await makeProject(t)
    const outputRoot = join(project, ".opencode", "generated-images")
    await mkdir(join(outputRoot, "existing-directory.png"), { recursive: true })
    const plugin = await setupPlugin(project)
    let fetchCalls = 0

    await withMockFetch(async () => {
      fetchCalls += 1
      return sseImageResponse()
    }, async () => {
      await expectToolError(
        () => executeTool(plugin, project, baseArgs({ out: "existing-directory.png" })),
        /regular image file|directory|special file/i,
      )
      assert.equal(fetchCalls, 0)
    })
  })

  it("rejects output traversal and absolute paths before fetching", async (t) => {
    const { parent, project } = await makeProject(t)
    const plugin = await setupPlugin(project)
    let fetchCalls = 0

    await withMockFetch(async () => {
      fetchCalls += 1
      return sseImageResponse()
    }, async () => {
      await expectToolError(
        () => executeTool(plugin, project, baseArgs({ out: "../escape.png" })),
        /project|outside|traversal|path|output|destination/i,
      )
      await expectToolError(
        () => executeTool(plugin, project, baseArgs({ out: join(parent, "absolute.png") })),
        /project|outside|absolute|relative|generated-images|path|output|destination/i,
      )
      assert.equal(fetchCalls, 0)
    })
  })

  it("validates size locally before any request is sent", async (t) => {
    const { project } = await makeProject(t)
    const plugin = await setupPlugin(project)
    let fetchCalls = 0

    await withMockFetch(async () => {
      fetchCalls += 1
      return sseImageResponse()
    }, async () => {
      for (const size of ["1000x1000", "4096x4096", "3840x1024", "256x256", "3840x2176", "1024", "1024X1024", ""]) {
        await expectToolError(() => executeTool(plugin, project, baseArgs({ size })), /size/i)
      }
      assert.equal(fetchCalls, 0)
    })
  })

  it("accepts the documented size bounds", () => {
    for (const size of ["auto", "1024x1024", "640x1024", "1280x3840", "3840x1280", "3840x2160", "2048x2048"]) {
      assert.equal(validateSize(size), size)
    }
  })

  it("rejects each documented size violation", () => {
    const violations = [
      ["1000x1000", /multiples of 16/],
      ["4096x4096", /3840/],
      ["3840x1024", /3:1/],
      ["256x256", /655360/],
      ["3840x2176", /8294400/],
      ["1024X1024", /auto or WIDTHxHEIGHT/],
      ["0x1024", /auto or WIDTHxHEIGHT/],
      ["1024", /auto or WIDTHxHEIGHT/],
      ["", /auto or WIDTHxHEIGHT/],
      [1024, /auto or WIDTHxHEIGHT/],
    ]
    for (const [size, pattern] of violations) {
      assert.throws(() => validateSize(size), pattern, `size ${JSON.stringify(size)} should be rejected`)
    }
  })

  it("requires a PNG output name and adds the extension when it is omitted", () => {
    assert.equal(validateOutputPath("hero"), "hero.png")
    assert.equal(validateOutputPath(join("sub", "hero")), join("sub", "hero.png"))
    assert.equal(validateOutputPath("hero.png"), "hero.png")
    assert.equal(validateOutputPath("HERO.PNG"), "HERO.PNG")
    assert.throws(() => validateOutputPath("photo.jpg"), /must end in \.png/)
    assert.throws(() => validateOutputPath("archive.tar.gz"), /must end in \.png/)
    assert.throws(() => validateOutputPath(".png"), /filename before \.png/)
  })

  it("rejects a non-PNG output name before fetching and saves an extensionless name as PNG", async (t) => {
    const { project } = await makeProject(t)
    const plugin = await setupPlugin(project)
    let fetchCalls = 0

    await withMockFetch(async () => {
      fetchCalls += 1
      return sseImageResponse()
    }, async () => {
      await expectToolError(() => executeTool(plugin, project, baseArgs({ out: "photo.jpg" })), /must end in \.png/)
      assert.equal(fetchCalls, 0)

      const result = await executeTool(plugin, project, baseArgs({ out: "sunrise" }))
      assert.match(resultText(result), /sunrise\.png/)
    })

    const outputFiles = await listFiles(join(project, ".opencode", "generated-images"))
    assert.equal(outputFiles.length, 1)
    assert.equal(basename(outputFiles[0]), "sunrise.png")
    assert.deepEqual(await readFile(outputFiles[0]), GENERATED_PNG)
  })

  it("reports each HTTP failure with an accurate next step", async () => {
    const auth = { type: "oauth", access: "unit-test-oauth-token-not-real" }
    const cases = [
      [400, /rejected the image request \(HTTP 400\)/],
      [401, /Reconnect ChatGPT\/Codex OAuth/],
      [404, /endpoint was not found \(HTTP 404\)/],
      [413, /too large \(HTTP 413\)/],
      [429, /rate limited \(HTTP 429\)/],
      [503, /temporarily unavailable \(HTTP 503\)/],
      [418, /returned HTTP 418/],
    ]
    for (const [status, pattern] of cases) {
      const outcome = await requestGeneratedPng(auth, baseArgs(), [], {
        fetchImpl: async () => new Response("", { status }),
      }).then(() => undefined, (error) => error)
      assert.match(outcome.message, pattern, `status ${status}`)
      if (status !== 401) assert.doesNotMatch(outcome.message, /Reconnect ChatGPT/, `status ${status}`)
    }
  })

  it("surfaces a bounded failure detail and cancels the Codex stream", async () => {
    let cancelled = false
    const data = JSON.stringify({
      type: "response.failed",
      response: { error: { message: `Prompt was blocked\n by policy ${"x".repeat(500)}` } },
    })
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(`data: ${data}\n\n`))
      },
      cancel() {
        cancelled = true
      },
    })

    const outcome = await parseImageGenerationResultFromSSE(stream).then(() => undefined, (error) => error)
    assert.match(outcome.message, /Prompt was blocked by policy x+/)
    assert.ok(outcome.message.length < 400, "the failure detail should be truncated")
    assert.equal(cancelled, true)
  })

  it("fails a stalled stream with a timeout error instead of hanging", async () => {
    const auth = { type: "oauth", access: "unit-test-oauth-token-not-real" }
    const outcome = await requestGeneratedPng(auth, baseArgs(), [], {
      timeoutMs: 20,
      fetchImpl: async (url, init) => ({
        ok: true,
        status: 200,
        body: new ReadableStream({
          start(controller) {
            init.signal.addEventListener("abort", () => controller.error(new Error("aborted")))
          },
        }),
      }),
    }).then(() => undefined, (error) => error)
    assert.match(outcome.message, /timed out/)
  })

  it("reports a caller cancellation as cancelled rather than as a timeout", async () => {
    const auth = { type: "oauth", access: "unit-test-oauth-token-not-real" }
    const controller = new AbortController()
    const pending = requestGeneratedPng(auth, baseArgs(), [], {
      signal: controller.signal,
      fetchImpl: (url, init) => new Promise((_, reject) => {
        init.signal.addEventListener("abort", () => reject(new Error("aborted")))
      }),
    }).then(() => undefined, (error) => error)
    controller.abort()

    const outcome = await pending
    assert.match(outcome.message, /cancelled/)
    assert.doesNotMatch(outcome.message, /timed out/)
  })
})
