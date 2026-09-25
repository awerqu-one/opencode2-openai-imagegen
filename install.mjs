#!/usr/bin/env node

import { constants as fsConstants } from "node:fs"
import { lstat, mkdir, open, readFile, realpath, stat } from "node:fs/promises"
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path"
import { fileURLToPath } from "node:url"

const PACKAGE_ROOT = dirname(fileURLToPath(import.meta.url))
const MANAGED_FILES = [
  {
    source: [".opencode", "plugins", "gpt-imagegen.js"],
    destination: [".opencode", "plugins", "gpt-imagegen.js"],
  },
  {
    source: [".opencode", "skills", "gpt-imagegen", "SKILL.md"],
    destination: [".opencode", "skills", "gpt-imagegen", "SKILL.md"],
  },
]
const NOFOLLOW = fsConstants.O_NOFOLLOW ?? 0

function usage() {
  return [
    "Usage: node install.mjs <existing-project-path> [--force]",
    "Copies the ImageGen plugin and skill into a project's .opencode directory.",
    "Different existing files are preserved unless --force is explicitly supplied.",
  ].join("\n")
}

function parseArgs(args) {
  let projectPath
  let force = false
  let help = false

  for (const arg of args) {
    if (arg === "--help" || arg === "-h") {
      help = true
      continue
    }
    if (arg === "--force") {
      if (force) throw new Error("--force may only be supplied once.")
      force = true
      continue
    }
    if (arg.startsWith("-")) throw new Error(`Unknown option: ${arg}`)
    if (projectPath) throw new Error("Provide exactly one target project path.")
    if (arg.includes("\0")) throw new Error("The target project path contains a null byte.")
    projectPath = arg
  }

  if (help) return { help: true }
  if (!projectPath) throw new Error(usage())
  return { help: false, force, projectPath }
}

function isInside(root, candidate) {
  const relativePath = relative(root, candidate)
  return relativePath === "" || (
    relativePath !== ".." &&
    !relativePath.startsWith(`..${sep}`) &&
    !isAbsolute(relativePath)
  )
}

async function lstatOrMissing(path) {
  try {
    return await lstat(path)
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") return undefined
    throw error
  }
}

async function resolveProjectRoot(projectPath) {
  let projectRoot
  try {
    projectRoot = await realpath(resolve(process.cwd(), projectPath))
  } catch (error) {
    if (error && typeof error === "object" && error.code === "ENOENT") {
      throw new Error(`Target project does not exist: ${projectPath}`)
    }
    throw new Error(`Cannot resolve target project: ${projectPath}`)
  }

  let projectStats
  try {
    projectStats = await stat(projectRoot)
  } catch {
    throw new Error(`Cannot inspect target project: ${projectPath}`)
  }
  if (!projectStats.isDirectory()) throw new Error(`Target project is not a directory: ${projectPath}`)
  return projectRoot
}

async function directoryStats(candidate, create) {
  let stats = await lstatOrMissing(candidate)
  if (stats || !create) return stats

  try {
    await mkdir(candidate)
  } catch (error) {
    if (!(error && typeof error === "object" && error.code === "EEXIST")) {
      throw new Error(`Cannot create directory: ${candidate}`)
    }
  }
  stats = await lstatOrMissing(candidate)
  return stats
}

async function validateDirectory(projectRoot, candidate, stats) {
  const relativePath = relative(projectRoot, candidate)
  if (stats.isSymbolicLink()) throw new Error(`Refusing symlinked destination directory: ${relativePath}`)
  if (!stats.isDirectory()) throw new Error(`Destination path component is not a directory: ${relativePath}`)

  let canonicalPath
  try {
    canonicalPath = await realpath(candidate)
  } catch {
    throw new Error(`Cannot resolve destination directory: ${relativePath}`)
  }
  if (!isInside(projectRoot, canonicalPath)) {
    throw new Error(`Destination directory escapes the target project: ${relativePath}`)
  }
  return canonicalPath
}

async function inspectDirectoryChain(projectRoot, components, create) {
  let current = projectRoot
  for (const component of components) {
    const candidate = join(current, component)
    const stats = await directoryStats(candidate, create)
    if (!stats) return undefined
    current = await validateDirectory(projectRoot, candidate, stats)
  }
  return current
}

async function inspectDestination(projectRoot, item) {
  const destinationDirectory = await inspectDirectoryChain(
    projectRoot,
    item.destination.slice(0, -1),
    false,
  )
  if (!destinationDirectory) return { ...item, status: "missing" }

  const destinationPath = join(destinationDirectory, item.destination.at(-1))
  const destinationStats = await lstatOrMissing(destinationPath)
  if (!destinationStats) return { ...item, destinationDirectory, destinationPath, status: "missing" }
  if (destinationStats.isSymbolicLink()) {
    throw new Error(`Refusing symlinked destination file: ${relative(projectRoot, destinationPath)}`)
  }
  if (!destinationStats.isFile()) {
    throw new Error(`Destination is not a regular file: ${relative(projectRoot, destinationPath)}`)
  }

  const existing = await readFile(destinationPath)
  return {
    ...item,
    destinationDirectory,
    destinationPath,
    status: existing.equals(item.contents) ? "same" : "conflict",
  }
}

async function writeFileContents(destinationPath, destinationName, contents, flags) {
  let handle
  let failure
  try {
    handle = await open(destinationPath, flags, 0o644)
    const openedStats = await handle.stat()
    if (!openedStats.isFile()) throw new Error(`Destination is not a regular file: ${destinationName}`)
    await handle.writeFile(contents)
    await handle.sync()
  } catch (error) {
    failure = error
  }
  if (handle) {
    try {
      await handle.close()
    } catch (error) {
      failure ??= error
    }
  }
  if (!failure) return
  if (failure instanceof Error && failure.message.startsWith("Destination is not a regular file:")) throw failure
  throw new Error(`Cannot write ${destinationName}; it may have changed during installation.`)
}

async function writeManagedFile(projectRoot, item, force) {
  const destinationDirectory = await inspectDirectoryChain(projectRoot, item.destination.slice(0, -1), true)
  const destinationPath = join(destinationDirectory, item.destination.at(-1))
  const destinationStats = await lstatOrMissing(destinationPath)
  const destinationName = item.destination.join("/")

  if (destinationStats?.isSymbolicLink()) throw new Error(`Refusing symlinked destination file: ${destinationName}`)
  if (destinationStats && !destinationStats.isFile()) throw new Error(`Destination is not a regular file: ${destinationName}`)

  if (destinationStats) {
    const existing = await readFile(destinationPath)
    if (existing.equals(item.contents)) {
      console.log(`Up to date: ${destinationName}`)
      return
    }
    if (!force) throw new Error(`Destination changed during install: ${destinationName}; refusing to overwrite.`)
  }

  const flags = destinationStats
    ? fsConstants.O_WRONLY | fsConstants.O_TRUNC | NOFOLLOW
    : fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | NOFOLLOW
  await writeFileContents(destinationPath, destinationName, item.contents, flags)

  console.log(`${destinationStats ? "Updated" : "Installed"}: ${destinationName}`)
}

async function install(projectPath, force) {
  const projectRoot = await resolveProjectRoot(projectPath)
  const sources = await Promise.all(MANAGED_FILES.map(async (item) => ({
    ...item,
    contents: await readFile(join(PACKAGE_ROOT, ...item.source)),
  })))
  const plan = await Promise.all(sources.map((item) => inspectDestination(projectRoot, item)))
  const conflicts = plan.filter((item) => item.status === "conflict")

  if (conflicts.length && !force) {
    const paths = conflicts.map((item) => item.destination.join("/")).join(", ")
    throw new Error(`Conflicting files already exist: ${paths}. No files were changed; review them before using --force.`)
  }

  for (const item of plan) {
    if (item.status === "same") {
      console.log(`Up to date: ${item.destination.join("/")}`)
      continue
    }
    await writeManagedFile(projectRoot, item, force)
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    console.log(usage())
    return
  }
  await install(args.projectPath, args.force)
}

main().catch((error) => {
  console.error(`ImageGen install failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exitCode = 1
})
