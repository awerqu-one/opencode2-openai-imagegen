/*
 * Port of opencode-gpt-imagegen by Yuji Hatakeyama.
 * Upstream: https://github.com/yuji-hatakeyama/opencode-gpt-imagegen
 *
 * MIT License
 * Copyright (c) 2026 Yuji Hatakeyama
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */

import * as fs from "node:fs/promises"
import { constants as fsConstants } from "node:fs"
import * as path from "node:path"

export const CODEX_RESPONSES_ENDPOINT = "https://chatgpt.com/backend-api/codex/responses"
export const MAX_CODEX_RESPONSE_BYTES = 72 * 1024 * 1024
export const MAX_GENERATED_PNG_BYTES = 50 * 1024 * 1024

const DEFAULT_CODEX_MODEL = "gpt-5.5"
const IMAGEGEN_MODEL_ENV = "OPENCODE_IMAGEGEN_MODEL"
const MAX_ERROR_EXCERPT_CHARS = 500
const MAX_REFERENCE_COUNT = 5
const MAX_REFERENCE_BYTES = 20 * 1024 * 1024
const MAX_REFERENCE_TOTAL_BYTES = 50 * 1024 * 1024
const MAX_OUTPUT_VERSION = 999
const OUTPUT_EXTENSION = ".png"
const IMAGE_GENERATION_TIMEOUT_MS = 10 * 60 * 1000
const MAX_FAILURE_DETAIL_CHARS = 300
const SIZE_PATTERN = /^([1-9]\d*)x([1-9]\d*)$/
const SIZE_DIMENSION_STEP = 16
const SIZE_MAX_EDGE = 3840
const SIZE_MAX_ASPECT_RATIO = 3
const SIZE_MIN_PIXELS = 655360
const SIZE_MAX_PIXELS = 8294400
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const IMAGE_TOOL_DESCRIPTION = [
  "Generate raster images using OpenAI's hosted image_generation tool.",
  "Use for AI-created bitmap visuals such as photos, illustrations, textures, sprites, and mockups.",
  "Do not use when the task is better handled by editing existing SVG/vector/code-native assets, extending an established icon or logo system, or building the visual directly in HTML/CSS/canvas.",
  "Reference images may be attached through `images`; label each image's role inline in `prompt`, for example: 'Image 1: reference image'.",
  "For many distinct assets, invoke gpt_imagegen once per requested asset; this tool returns one image per call.",
  "Requires an active OpenAI ChatGPT/Codex OAuth connection. Returns the absolute path of the saved PNG.",
].join(" ")

function getErrorCode(error) {
  if (error && typeof error === "object" && typeof error.code === "string") return error.code
  return "filesystem error"
}

function isErrorCode(error, code) {
  return Boolean(error && typeof error === "object" && error.code === code)
}

function filesystemError(action, error) {
  return new Error(`${action} (${getErrorCode(error)}).`)
}

function isPathInside(parent, candidate) {
  const relative = path.relative(parent, candidate)
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  )
}

async function resolveProjectRoot(projectDirectory) {
  if (typeof projectDirectory !== "string" || projectDirectory.length === 0) {
    throw new Error("OpenCode did not provide an active project directory.")
  }

  let root
  try {
    root = await fs.realpath(projectDirectory)
  } catch (error) {
    throw filesystemError("The active project directory could not be resolved", error)
  }

  let stats
  try {
    stats = await fs.stat(root)
  } catch (error) {
    throw filesystemError("The active project directory could not be inspected", error)
  }
  if (!stats.isDirectory()) throw new Error("The active project path is not a directory.")
  return root
}

function detectImageMime(header) {
  if (
    header.length >= 8 &&
    header.subarray(0, 8).equals(PNG_SIGNATURE)
  ) {
    return "image/png"
  }
  if (header.length >= 3 && header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg"
  }
  if (
    header.length >= 12 &&
    header.toString("ascii", 0, 4) === "RIFF" &&
    header.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp"
  }
  if (header.length >= 6) {
    const signature = header.toString("ascii", 0, 6)
    if (signature === "GIF87a" || signature === "GIF89a") return "image/gif"
  }
  return undefined
}

function assertReferenceSize(entries) {
  let totalBytes = 0
  for (const entry of entries) {
    if (!entry.stats.isFile()) {
      throw new Error(`Reference images[${entry.index}] must resolve to a regular file.`)
    }
    if (entry.stats.size > MAX_REFERENCE_BYTES) {
      throw new Error(`Reference images[${entry.index}] exceeds the 20 MiB per-image limit.`)
    }
    totalBytes += entry.stats.size
  }
  if (totalBytes > MAX_REFERENCE_TOTAL_BYTES) {
    throw new Error("Reference images exceed the 50 MiB combined-size limit.")
  }
  for (const entry of entries) entry.size = entry.stats.size
}

async function readHeader(handle, index) {
  const buffer = Buffer.alloc(12)
  let result
  try {
    result = await handle.read(buffer, 0, buffer.length, 0)
  } catch (error) {
    throw filesystemError(`Reference images[${index}] could not be inspected`, error)
  }
  return buffer.subarray(0, result.bytesRead)
}

async function readExactBytes(handle, size, index) {
  const buffer = Buffer.alloc(size)
  let offset = 0
  while (offset < size) {
    let result
    try {
      result = await handle.read(buffer, offset, size - offset, offset)
    } catch (error) {
      throw filesystemError(`Reference images[${index}] could not be read`, error)
    }
    if (result.bytesRead === 0) {
      throw new Error(`Reference images[${index}] changed while it was being read.`)
    }
    offset += result.bytesRead
  }
  return buffer
}

async function withValidatedReferenceFiles(paths, projectDirectory, useFiles) {
  const requestedPaths = paths ?? []
  if (!Array.isArray(requestedPaths)) throw new Error("The images argument must be an array of file paths.")
  if (requestedPaths.length > MAX_REFERENCE_COUNT) {
    throw new Error("At most 5 reference images may be supplied.")
  }
  if (requestedPaths.length === 0) return useFiles([])

  const projectRoot = await resolveProjectRoot(projectDirectory)
  const entries = []
  let initialTotalBytes = 0

  for (let index = 0; index < requestedPaths.length; index++) {
    const referencePath = requestedPaths[index]
    if (typeof referencePath !== "string" || referencePath.length === 0 || referencePath.includes("\0")) {
      throw new Error(`Reference images[${index}] must be a valid file path.`)
    }

    const candidate = path.isAbsolute(referencePath)
      ? path.resolve(referencePath)
      : path.resolve(projectRoot, referencePath)
    let canonicalPath
    try {
      canonicalPath = await fs.realpath(candidate)
    } catch (error) {
      throw filesystemError(`Reference images[${index}] could not be resolved`, error)
    }
    if (!isPathInside(projectRoot, canonicalPath)) {
      throw new Error(`Reference images[${index}] must resolve inside the active project.`)
    }

    let stats
    try {
      stats = await fs.stat(canonicalPath)
    } catch (error) {
      throw filesystemError(`Reference images[${index}] could not be inspected`, error)
    }
    if (!stats.isFile()) throw new Error(`Reference images[${index}] must resolve to a regular file.`)
    if (stats.size > MAX_REFERENCE_BYTES) {
      throw new Error(`Reference images[${index}] exceeds the 20 MiB per-image limit.`)
    }
    initialTotalBytes += stats.size
    if (initialTotalBytes > MAX_REFERENCE_TOTAL_BYTES) {
      throw new Error("Reference images exceed the 50 MiB combined-size limit.")
    }
    entries.push({ index, path: canonicalPath, stats, size: stats.size })
  }

  const noFollow = fsConstants.O_NOFOLLOW ?? 0
  const openFlags = fsConstants.O_RDONLY | noFollow
  const openedEntries = []

  try {
    for (const entry of entries) {
      let handle
      try {
        handle = await fs.open(entry.path, openFlags)
      } catch (error) {
        throw filesystemError(`Reference images[${entry.index}] could not be opened safely`, error)
      }
      openedEntries.push({ ...entry, handle })
    }

    for (const entry of openedEntries) {
      let openedStats
      try {
        openedStats = await entry.handle.stat()
      } catch (error) {
        throw filesystemError(`Reference images[${entry.index}] could not be inspected`, error)
      }
      if (
        openedStats.dev !== entry.stats.dev ||
        (entry.stats.ino !== 0 && openedStats.ino !== 0 && openedStats.ino !== entry.stats.ino)
      ) {
        throw new Error(`Reference images[${entry.index}] changed while it was being opened.`)
      }
      entry.stats = openedStats
    }
    assertReferenceSize(openedEntries)

    for (const entry of openedEntries) {
      entry.header = await readHeader(entry.handle, entry.index)
      entry.mime = detectImageMime(entry.header)
      if (!entry.mime) {
        throw new Error(`Reference images[${entry.index}] is not a PNG, JPEG, WebP, or GIF image.`)
      }
    }

    for (const entry of openedEntries) {
      try {
        entry.stats = await entry.handle.stat()
      } catch (error) {
        throw filesystemError(`Reference images[${entry.index}] could not be rechecked`, error)
      }
    }
    assertReferenceSize(openedEntries)
    return await useFiles(openedEntries)
  } finally {
    for (const entry of openedEntries) {
      try {
        await entry.handle.close()
      } catch (error) {
        throw filesystemError(`Reference images[${entry.index}] could not be closed`, error)
      }
    }
  }
}

export async function readReferenceImages(paths, projectDirectory) {
  return withValidatedReferenceFiles(paths, projectDirectory, async (entries) => {
    const dataUrls = []
    for (const entry of entries) {
      const image = await readExactBytes(entry.handle, entry.size, entry.index)
      if (!image.subarray(0, entry.header.length).equals(entry.header) || detectImageMime(image) !== entry.mime) {
        throw new Error(`Reference images[${entry.index}] changed during validation.`)
      }
      dataUrls.push(`data:${entry.mime};base64,${image.toString("base64")}`)
    }
    return dataUrls
  })
}

function ensureOutputExtension(normalized) {
  const name = path.basename(normalized)
  if (name.toLowerCase().endsWith(OUTPUT_EXTENSION)) {
    if (name.length === OUTPUT_EXTENSION.length) {
      throw new Error("The out argument must include a filename before .png.")
    }
    return normalized
  }
  const extension = path.extname(name)
  if (extension !== "") {
    throw new Error(`The out argument must end in .png because the plugin writes PNG files; got "${extension}".`)
  }
  return `${normalized}${OUTPUT_EXTENSION}`
}

export function validateOutputPath(out) {
  if (typeof out !== "string" || out.length === 0 || out.includes("\0")) {
    throw new Error("The out argument must be a non-empty relative file path.")
  }
  if (path.isAbsolute(out) || path.win32.isAbsolute(out) || path.win32.parse(out).root !== "") {
    throw new Error("The out argument must be relative to .opencode/generated-images/.")
  }

  const platformPath = out.replace(/[\\/]/g, path.sep)
  const components = platformPath.split(path.sep).filter(Boolean)
  if (components.length === 0 || components.some((component) => component === "..")) {
    throw new Error("The out argument cannot contain path traversal.")
  }

  const normalized = path.normalize(platformPath)
  if (normalized === "." || normalized === path.sep || path.isAbsolute(normalized)) {
    throw new Error("The out argument must name a file inside .opencode/generated-images/.")
  }
  return ensureOutputExtension(normalized)
}

async function inspectOutputTarget(candidatePath, outputRoot) {
  let stats
  try {
    stats = await fs.lstat(candidatePath)
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return false
    throw filesystemError("The output destination could not be inspected", error)
  }

  if (stats.isSymbolicLink()) {
    let canonicalTarget
    try {
      canonicalTarget = await fs.realpath(candidatePath)
    } catch (error) {
      throw filesystemError("The output symlink target could not be resolved", error)
    }
    if (!isPathInside(outputRoot, canonicalTarget)) {
      throw new Error("The output destination symlink escapes .opencode/generated-images/.")
    }
    try {
      stats = await fs.stat(canonicalTarget)
    } catch (error) {
      throw filesystemError("The output symlink target could not be inspected", error)
    }
  }

  if (!stats.isFile()) throw new Error("The out argument must name a regular image file, not a directory or special file.")
  return true
}

export async function validateOutputDestination(out, projectDirectory) {
  const normalizedOut = validateOutputPath(out)
  const projectRoot = await resolveProjectRoot(projectDirectory)
  const outputRoot = path.join(projectRoot, ".opencode", "generated-images")
  const components = normalizedOut.split(path.sep).filter(Boolean)
  const directories = [path.join(projectRoot, ".opencode"), outputRoot]
  let parent = outputRoot
  for (const component of components.slice(0, -1)) {
    parent = path.join(parent, component)
    directories.push(parent)
  }

  for (const directory of directories) {
    let stats
    try {
      stats = await fs.lstat(directory)
    } catch (error) {
      if (isErrorCode(error, "ENOENT")) break
      throw filesystemError("The output directory could not be inspected", error)
    }
    if (stats.isSymbolicLink()) {
      throw new Error("Output directories must not be symlinks; choose a path inside .opencode/generated-images/.")
    }
    if (!stats.isDirectory()) throw new Error("The output path contains a non-directory component.")

    let canonicalPath
    try {
      canonicalPath = await fs.realpath(directory)
    } catch (error) {
      throw filesystemError("The output directory could not be resolved", error)
    }
    if (!isPathInside(projectRoot, canonicalPath)) {
      throw new Error("The output directory must remain inside the active project.")
    }
  }

  const candidatePath = path.join(outputRoot, normalizedOut)
  let canonicalOutputRoot
  try {
    canonicalOutputRoot = await fs.realpath(outputRoot)
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return normalizedOut
    throw filesystemError("The generated-images directory could not be resolved", error)
  }
  await inspectOutputTarget(candidatePath, canonicalOutputRoot)
  return normalizedOut
}

async function ensureContainedDirectory(candidate, containmentRoot, description) {
  try {
    await fs.mkdir(candidate, { mode: 0o700 })
  } catch (error) {
    if (!isErrorCode(error, "EEXIST")) throw filesystemError(`${description} could not be created`, error)
  }

  let linkStats
  try {
    linkStats = await fs.lstat(candidate)
  } catch (error) {
    throw filesystemError(`${description} could not be inspected`, error)
  }
  if (linkStats.isSymbolicLink()) throw new Error(`${description} must not be a symlink.`)

  let canonicalPath
  try {
    canonicalPath = await fs.realpath(candidate)
  } catch (error) {
    throw filesystemError(`${description} could not be resolved`, error)
  }
  if (!isPathInside(containmentRoot, canonicalPath)) {
    throw new Error(`${description} must remain inside the permitted output directory.`)
  }

  let stats
  try {
    stats = await fs.stat(canonicalPath)
  } catch (error) {
    throw filesystemError(`${description} could not be inspected`, error)
  }
  if (!stats.isDirectory()) throw new Error(`${description} is not a directory.`)
  return canonicalPath
}

async function ensureOutputRoot(projectRoot) {
  const opencodeDirectory = await ensureContainedDirectory(
    path.join(projectRoot, ".opencode"),
    projectRoot,
    "The project .opencode directory",
  )
  return ensureContainedDirectory(
    path.join(opencodeDirectory, "generated-images"),
    projectRoot,
    "The generated-images directory",
  )
}

function buildSavedMessage(savedPath, requestedPath, versioned) {
  const versionNote = versioned ? ` (the requested path ${requestedPath} already existed; saved a versioned copy)` : ""
  return `Generated image saved to ${savedPath}${versionNote}.`
}

export async function writeGeneratedImage(out, projectDirectory, imageBytes) {
  const normalizedOut = await validateOutputDestination(out, projectDirectory)
  if (!(imageBytes instanceof Uint8Array) || imageBytes.byteLength === 0) {
    throw new Error("The generated PNG data is empty or invalid.")
  }

  const projectRoot = await resolveProjectRoot(projectDirectory)
  const components = normalizedOut.split(path.sep).filter(Boolean)
  const filename = components.pop()
  if (!filename || filename === "." || filename === "..") {
    throw new Error("The out argument must name a file inside .opencode/generated-images/.")
  }

  const outputRoot = await ensureOutputRoot(projectRoot)
  let parent = outputRoot
  for (const component of components) {
    parent = await ensureContainedDirectory(path.join(parent, component), outputRoot, "An output subdirectory")
  }

  const extension = path.extname(filename)
  const stem = path.basename(filename, extension)
  const requestedPath = path.join(parent, filename)

  for (let version = 1; version <= MAX_OUTPUT_VERSION; version++) {
    const candidateName = version === 1 ? filename : `${stem}-v${version}${extension}`
    const candidatePath = path.join(parent, candidateName)
    if (await inspectOutputTarget(candidatePath, outputRoot)) continue
    let handle
    try {
      handle = await fs.open(candidatePath, "wx", 0o644)
    } catch (error) {
      if (isErrorCode(error, "EEXIST")) {
        await inspectOutputTarget(candidatePath, outputRoot)
        continue
      }
      throw filesystemError("The generated image file could not be created", error)
    }

    let writeFailure
    try {
      await handle.writeFile(imageBytes)
      await handle.sync()
    } catch (error) {
      writeFailure = error
    }
    try {
      await handle.close()
    } catch (error) {
      if (!writeFailure) writeFailure = error
    }

    if (writeFailure) {
      let cleanupFailure
      try {
        await fs.unlink(candidatePath)
      } catch (error) {
        if (!isErrorCode(error, "ENOENT")) cleanupFailure = error
      }
      if (cleanupFailure) {
        throw new Error("Generated image writing failed and cleanup of its partial file could not be confirmed.")
      }
      throw filesystemError("The generated image could not be written completely", writeFailure)
    }

    return {
      savedPath: candidatePath,
      requestedPath,
      versioned: version !== 1,
      message: buildSavedMessage(candidatePath, requestedPath, version !== 1),
    }
  }

  throw new Error("No free output filename was available (checked the requested name and versions v2 through v999).")
}

export async function resolveOpenAIOAuth(ctx) {
  const connectionApi = ctx?.integration?.connection
  if (typeof connectionApi?.active !== "function" || typeof connectionApi?.resolve !== "function") {
    throw new Error("This OpenCode runtime does not expose integration connections; OpenAI ChatGPT OAuth is required.")
  }

  const connection = await connectionApi.active("openai")
  if (!connection) {
    throw new Error("No active OpenAI connection. Connect OpenAI with ChatGPT/Codex OAuth, then retry.")
  }

  const credential = await connectionApi.resolve(connection)
  if (
    !credential ||
    typeof credential !== "object" ||
    credential.type !== "oauth" ||
    typeof credential.access !== "string" ||
    credential.access.length === 0
  ) {
    throw new Error("The active OpenAI connection is not ChatGPT/Codex OAuth. API-key credentials are not supported.")
  }

  const accountId = credential.metadata?.accountID ?? credential.accountId
  return {
    type: "oauth",
    access: credential.access,
    ...(typeof accountId === "string" && accountId.length > 0 ? { accountId } : {}),
  }
}

export function validateSize(size) {
  if (size === "auto") return size
  const match = typeof size === "string" ? SIZE_PATTERN.exec(size) : null
  if (!match) throw new Error("The size argument must be auto or WIDTHxHEIGHT, for example 1024x1024.")

  const width = Number(match[1])
  const height = Number(match[2])
  if (width % SIZE_DIMENSION_STEP !== 0 || height % SIZE_DIMENSION_STEP !== 0) {
    throw new Error("The size dimensions must both be multiples of 16.")
  }
  const longEdge = Math.max(width, height)
  const shortEdge = Math.min(width, height)
  if (longEdge > SIZE_MAX_EDGE) throw new Error("The size longest edge must be at most 3840 pixels.")
  if (longEdge > SIZE_MAX_ASPECT_RATIO * shortEdge) throw new Error("The size aspect ratio must be at most 3:1.")
  const pixels = width * height
  if (pixels < SIZE_MIN_PIXELS || pixels > SIZE_MAX_PIXELS) {
    throw new Error("The size must have between 655360 and 8294400 total pixels.")
  }
  return size
}

function validateGenerationArgs(args) {
  if (!args || typeof args !== "object" || Array.isArray(args)) {
    throw new Error("The gpt_imagegen arguments must be an object.")
  }
  if (typeof args.prompt !== "string" || args.prompt.trim().length === 0) {
    throw new Error("The prompt argument must contain a description of the image.")
  }
  if (typeof args.out !== "string") throw new Error("The out argument must be a relative file path.")
  if (!["low", "medium", "high", "auto"].includes(args.quality)) {
    throw new Error("The quality argument must be low, medium, high, or auto.")
  }
  if (args.size !== undefined) validateSize(args.size)
  if (args.images !== undefined && !Array.isArray(args.images)) {
    throw new Error("The images argument must be an array of file paths.")
  }
  return args
}

export function resolveCodexModel(env = process.env) {
  const configured = env?.[IMAGEGEN_MODEL_ENV]
  if (configured === undefined) return DEFAULT_CODEX_MODEL
  if (typeof configured !== "string" || configured.trim().length === 0) {
    throw new Error(`${IMAGEGEN_MODEL_ENV} must be a non-empty model slug when set.`)
  }
  const model = configured.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(model)) {
    throw new Error(`${IMAGEGEN_MODEL_ENV} contains an invalid model slug.`)
  }
  return model
}

export function buildCodexRequest(auth, args, referenceDataUrls = []) {
  if (!auth || auth.type !== "oauth" || typeof auth.access !== "string" || auth.access.length === 0) {
    throw new Error("A ChatGPT/Codex OAuth access token is required to build the request.")
  }
  if (!Array.isArray(referenceDataUrls)) throw new Error("Validated reference image data must be an array.")

  const userContent = [{ type: "input_text", text: args.prompt }]
  for (const dataUrl of referenceDataUrls) {
    if (typeof dataUrl !== "string" || !dataUrl.startsWith("data:image/")) {
      throw new Error("A reference image was not encoded as a validated image data URL.")
    }
    userContent.push({ type: "input_image", image_url: dataUrl })
  }

  const body = {
    model: resolveCodexModel(),
    instructions:
      "You are an image generation assistant running inside the Codex backend. " +
      "Always satisfy the request by invoking the image_generation tool exactly once. " +
      "Do not respond with text only.",
    input: [{ role: "user", content: userContent }],
    tools: [
      {
        type: "image_generation",
        output_format: "png",
        quality: args.quality,
        ...(args.size ? { size: args.size } : {}),
      },
    ],
    tool_choice: { type: "image_generation" },
    stream: true,
    store: false,
  }

  return {
    url: CODEX_RESPONSES_ENDPOINT,
    init: {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${auth.access}`,
        ...(auth.accountId ? { "ChatGPT-Account-Id": auth.accountId } : {}),
        originator: "opencode",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(body),
    },
  }
}

function parseSSEJson(data) {
  if (data === "[DONE]") return undefined
  try {
    return JSON.parse(data)
  } catch {
    throw new Error("The Codex image response contained malformed SSE data.")
  }
}

function describeFailureEvent(event) {
  const detail =
    event.error?.message ??
    event.message ??
    event.response?.error?.message ??
    event.response?.incomplete_details?.reason
  if (typeof detail !== "string") return undefined
  const text = detail.replace(/\s+/g, " ").trim()
  return text.length > 0 ? text.slice(0, MAX_FAILURE_DETAIL_CHARS) : undefined
}

export async function parseImageGenerationResultFromSSE(stream, { signal } = {}) {
  if (!stream || typeof stream.getReader !== "function") {
    throw new Error("The Codex image response did not provide a readable event stream.")
  }

  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let pending = ""
  let dataLines = []
  let imageResult
  let responseBytes = 0

  function dispatchEvent() {
    if (dataLines.length === 0) return
    const data = dataLines.join("\n")
    dataLines = []
    const event = parseSSEJson(data)
    if (!event || typeof event !== "object") return

    if (["error", "response.failed", "response.incomplete"].includes(event.type)) {
      const detail = describeFailureEvent(event)
      throw new Error(
        detail
          ? `The Codex image-generation request failed: ${detail}`
          : "The Codex image-generation request failed while processing the response.",
      )
    }
    if (event.type !== "response.output_item.done" || event.item?.type !== "image_generation_call") return
    if (typeof event.item.result !== "string" || event.item.result.length === 0) {
      throw new Error("The Codex image-generation event did not include image data.")
    }
    if (imageResult === undefined) imageResult = event.item.result
  }

  function processLine(line) {
    if (line === "") {
      dispatchEvent()
      return
    }
    if (line.startsWith(":")) return

    const colon = line.indexOf(":")
    const field = colon === -1 ? line : line.slice(0, colon)
    if (field !== "data") return
    let value = colon === -1 ? "" : line.slice(colon + 1)
    if (value.startsWith(" ")) value = value.slice(1)
    dataLines.push(value)
  }

  function consumeLines(final) {
    let start = 0
    for (let index = 0; index < pending.length; index++) {
      const character = pending[index]
      if (character !== "\n" && character !== "\r") continue
      if (character === "\r" && index === pending.length - 1 && !final) break
      processLine(pending.slice(start, index))
      if (character === "\r" && pending[index + 1] === "\n") index++
      start = index + 1
    }
    if (final && start < pending.length) {
      processLine(pending.slice(start))
      start = pending.length
    }
    pending = pending.slice(start)
  }

  let completed = false
  try {
    while (true) {
      if (signal?.aborted) throw new Error("Image generation was cancelled.")
      let chunk
      try {
        chunk = await reader.read()
      } catch {
        if (signal?.aborted) throw new Error("Image generation was cancelled.")
        throw new Error("The Codex image response stream failed before completion.")
      }

      if (!chunk.done) {
        responseBytes += chunk.value?.byteLength ?? 0
        if (responseBytes > MAX_CODEX_RESPONSE_BYTES) {
          await reader.cancel()
          throw new Error("The Codex image response exceeded the 72 MiB stream limit.")
        }
      }

      pending += chunk.done ? decoder.decode() : decoder.decode(chunk.value, { stream: true })
      consumeLines(chunk.done)
      if (chunk.done) break
    }
    completed = true
  } finally {
    // Release the upstream connection when parsing stops early (failure event, cancel, timeout).
    if (!completed) await reader.cancel().catch(() => {})
    reader.releaseLock()
  }

  dispatchEvent()
  if (typeof imageResult !== "string" || imageResult.length === 0) {
    throw new Error("The Codex response completed without an image-generation result.")
  }
  return imageResult
}

export function validateGeneratedPngEncodedLength(encodedLength) {
  const maxEncodedLength = Math.ceil(MAX_GENERATED_PNG_BYTES / 3) * 4
  if (!Number.isSafeInteger(encodedLength) || encodedLength < 0 || encodedLength > maxEncodedLength) {
    throw new Error("The generated PNG exceeded the 50 MiB output limit.")
  }
}

export function decodeGeneratedPng(encodedImage) {
  if (
    typeof encodedImage !== "string" ||
    !/^[A-Za-z0-9+/]+={0,2}$/.test(encodedImage) ||
    encodedImage.length % 4 === 1
  ) {
    throw new Error("The Codex image result was not valid base64 PNG data.")
  }
  validateGeneratedPngEncodedLength(encodedImage.length)

  const unpadded = encodedImage.replace(/=+$/, "")
  const bytes = Buffer.from(encodedImage, "base64")
  if (bytes.length === 0 || bytes.toString("base64").replace(/=+$/, "") !== unpadded) {
    throw new Error("The Codex image result was not valid base64 PNG data.")
  }
  if (bytes.byteLength > MAX_GENERATED_PNG_BYTES) {
    throw new Error("The generated PNG exceeded the 50 MiB output limit.")
  }
  if (bytes.length < PNG_SIGNATURE.length || !bytes.subarray(0, PNG_SIGNATURE.length).equals(PNG_SIGNATURE)) {
    throw new Error("The Codex image result did not contain a PNG image.")
  }
  return bytes
}

function describeHttpFailure(status) {
  if (status === 401 || status === 403) {
    return "ChatGPT rejected the OpenAI OAuth connection. Reconnect ChatGPT/Codex OAuth and retry."
  }
  if (status === 400 || status === 422) {
    return `ChatGPT rejected the image request (HTTP ${status}). Check the prompt, size, quality, and reference images; reconnecting OAuth will not fix this.`
  }
  if (status === 404) {
    return "The ChatGPT image endpoint was not found (HTTP 404). The undocumented endpoint may have changed; check for a plugin update."
  }
  if (status === 413) {
    return "ChatGPT rejected the image request as too large (HTTP 413). Use fewer or smaller reference images."
  }
  if (status === 429) {
    return "ChatGPT image generation is rate limited (HTTP 429). Wait before retrying."
  }
  if (Number.isInteger(status) && status >= 500) {
    return `ChatGPT image generation is temporarily unavailable (HTTP ${status}). Retry later.`
  }
  const label = Number.isInteger(status) ? `HTTP ${status}` : "an HTTP error"
  return `ChatGPT image generation returned ${label}. Retry later.`
}

async function readErrorExcerpt(response) {
  const reader = response?.body?.getReader?.()
  if (!reader) return ""
  const decoder = new TextDecoder()
  let text = ""
  try {
    while (text.length < MAX_ERROR_EXCERPT_CHARS) {
      const chunk = await reader.read()
      if (chunk.done) break
      text += decoder.decode(chunk.value, { stream: true })
    }
  } catch {
    // Keep whatever text arrived before the read failed.
  } finally {
    await reader.cancel().catch(() => {})
  }
  return text.replace(/\s+/g, " ").trim().slice(0, MAX_ERROR_EXCERPT_CHARS)
}

async function discardBody(response) {
  try {
    await response?.body?.cancel()
  } catch {
    // The body is already closed or unreadable, so there is nothing left to release.
  }
}

export async function requestGeneratedPng(
  auth,
  args,
  referenceDataUrls,
  { fetchImpl = globalThis.fetch, signal, timeoutMs = IMAGE_GENERATION_TIMEOUT_MS } = {},
) {
  if (typeof fetchImpl !== "function") throw new Error("This runtime does not provide fetch for the Codex request.")
  const request = buildCodexRequest(auth, args, referenceDataUrls)

  // One controller covers both the caller's cancellation and the time limit, including the
  // stream read, where a stalled response would otherwise hang the tool indefinitely.
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)
  const abortFromCaller = () => controller.abort()
  if (signal?.aborted) controller.abort()
  else signal?.addEventListener("abort", abortFromCaller, { once: true })

  try {
    let response
    try {
      response = await fetchImpl(request.url, {
        ...request.init,
        redirect: "error",
        signal: controller.signal,
      })
    } catch {
      throw new Error("Could not reach ChatGPT image generation. Check the network connection and retry.")
    }

    if (!response?.ok) {
      if (response?.status === 401 || response?.status === 403) {
        await discardBody(response)
        throw new Error(describeHttpFailure(response.status))
      }
      const excerpt = await readErrorExcerpt(response)
      const suffix = excerpt ? ` Backend response: ${excerpt}` : ""
      throw new Error(`${describeHttpFailure(response?.status)}${suffix}`)
    }
    if (!response.body) throw new Error("ChatGPT image generation returned no event stream.")

    const encodedImage = await parseImageGenerationResultFromSSE(response.body, { signal: controller.signal })
    return decodeGeneratedPng(encodedImage)
  } catch (error) {
    if (timedOut) throw new Error("ChatGPT image generation timed out before finishing. Retry later.")
    if (signal?.aborted) throw new Error("Image generation was cancelled.")
    throw error
  } finally {
    clearTimeout(timer)
    signal?.removeEventListener("abort", abortFromCaller)
  }
}

export default {
  id: "opencode-gpt-imagegen-project",
  async setup(ctx) {
    const projectDirectory = ctx?.location?.directory
    if (typeof projectDirectory !== "string" || projectDirectory.length === 0) {
      throw new Error("OpenCode did not provide the plugin's active project directory.")
    }

    await ctx.tool.transform((editor) => {
      editor.add({
        name: "gpt_imagegen",
        description: IMAGE_TOOL_DESCRIPTION,
        input: {
          type: "object",
          properties: {
            prompt: { type: "string", description: "Description of the image to generate." },
            out: {
              type: "string",
              description:
                "Relative output file path under .opencode/generated-images/, ending in .png (added when no extension is given).",
            },
            quality: { type: "string", enum: ["low", "medium", "high", "auto"] },
            size: {
              type: "string",
              description:
                "Optional size passed to image_generation: auto or WIDTHxHEIGHT with dimensions in multiples of 16, max edge 3840, ratio at most 3:1, and 655360 to 8294400 pixels.",
            },
            images: {
              type: "array",
              maxItems: MAX_REFERENCE_COUNT,
              items: { type: "string" },
              description: "Optional PNG, JPEG, WebP, or GIF reference paths inside the active project.",
            },
          },
          required: ["prompt", "out", "quality"],
          additionalProperties: false,
        },
        execute: async (input, executionContext) => {
          const args = validateGenerationArgs(input)
          const outputPath = await validateOutputDestination(args.out, projectDirectory)
          const auth = await resolveOpenAIOAuth(ctx)
          const referenceDataUrls = await readReferenceImages(args.images, projectDirectory)
          const imageBytes = await requestGeneratedPng(auth, args, referenceDataUrls, {
            signal: executionContext?.signal,
          })
          const saved = await writeGeneratedImage(outputPath, projectDirectory, imageBytes)
          return { content: saved.message }
        },
      })
    })
  },
}
