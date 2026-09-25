import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { spawnSync } from "node:child_process"

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..")
const INSTALLER = join(REPO_ROOT, "install.mjs")
const FILES = [
  ".opencode/plugins/gpt-imagegen.js",
  ".opencode/skills/gpt-imagegen/SKILL.md",
]

async function makeProject(t) {
  const parent = await mkdtemp(join(tmpdir(), "gpt-imagegen-install-test-"))
  t.after(() => rm(parent, { recursive: true, force: true }))
  const project = join(parent, "project")
  await mkdir(project)
  return { parent, project }
}

function runInstaller(project, args = []) {
  return spawnSync(process.execPath, [INSTALLER, project, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  })
}

function assertSuccess(result) {
  assert.equal(result.error, undefined, result.error?.message)
  assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`)
}

describe("project installer", { concurrency: false }, () => {
  it("copies the plugin and skill into an existing project", async (t) => {
    const { project } = await makeProject(t)
    const marker = join(project, "keep-me.txt")
    await writeFile(marker, "unrelated user file")

    const result = runInstaller(project)
    assertSuccess(result)

    for (const relativePath of FILES) {
      assert.deepEqual(
        await readFile(join(project, relativePath)),
        await readFile(join(REPO_ROOT, relativePath)),
      )
    }
    assert.equal(await readFile(marker, "utf8"), "unrelated user file")
  })

  it("treats a repeated install of identical files as a no-op", async (t) => {
    const { project } = await makeProject(t)
    assertSuccess(runInstaller(project))

    const secondRun = runInstaller(project)
    assertSuccess(secondRun)
    assert.match(secondRun.stdout, /Up to date/)
  })

  it("refuses conflicts before copying any missing file", async (t) => {
    const { project } = await makeProject(t)
    const pluginPath = join(project, FILES[0])
    await mkdir(dirname(pluginPath), { recursive: true })
    await writeFile(pluginPath, "user-owned plugin")

    const result = runInstaller(project)
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /conflict|--force/i)
    assert.equal(await readFile(pluginPath, "utf8"), "user-owned plugin")
    await assert.rejects(readFile(join(project, FILES[1])), { code: "ENOENT" })
    await assert.rejects(readdir(join(project, ".opencode", "skills")), { code: "ENOENT" })
  })

  it("overwrites only managed files when --force is explicit", async (t) => {
    const { project } = await makeProject(t)
    const pluginPath = join(project, FILES[0])
    const skillPath = join(project, FILES[1])
    const marker = join(project, "keep-me.txt")
    await mkdir(dirname(pluginPath), { recursive: true })
    await mkdir(dirname(skillPath), { recursive: true })
    await writeFile(pluginPath, "old plugin")
    await writeFile(skillPath, "old skill")
    await writeFile(marker, "unrelated user file")

    const result = runInstaller(project, ["--force"])
    assertSuccess(result)
    for (const relativePath of FILES) {
      assert.deepEqual(
        await readFile(join(project, relativePath)),
        await readFile(join(REPO_ROOT, relativePath)),
      )
    }
    assert.equal(await readFile(marker, "utf8"), "unrelated user file")
  })

  it("rejects a missing target project", async (t) => {
    const { parent } = await makeProject(t)
    const result = runInstaller(join(parent, "missing"))
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /directory|exist|target/i)
  })

  it("rejects a target that is a file rather than a project directory", async (t) => {
    const { parent } = await makeProject(t)
    const fileTarget = join(parent, "not-a-project")
    await writeFile(fileTarget, "not a directory")

    const result = runInstaller(fileTarget)
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /not a directory/i)
  })

  it("rejects a symlinked managed directory", async (t) => {
    const { parent, project } = await makeProject(t)
    const outside = join(parent, "outside")
    await mkdir(join(project, ".opencode"), { recursive: true })
    await mkdir(outside)
    try {
      await symlink(outside, join(project, ".opencode", "plugins"), "dir")
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
        return t.skip(`symlinks unavailable: ${error.code}`)
      }
      throw error
    }

    const result = runInstaller(project)
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /symlink/i)
    assert.deepEqual(await readdir(outside), [])
  })

  it("refuses a symlinked destination file even with --force", async (t) => {
    const { parent, project } = await makeProject(t)
    const pluginDirectory = join(project, ".opencode", "plugins")
    const outsideFile = join(parent, "outside-plugin.js")
    await mkdir(pluginDirectory, { recursive: true })
    await writeFile(outsideFile, "outside user file")
    try {
      await symlink(outsideFile, join(pluginDirectory, "gpt-imagegen.js"))
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes(error.code)) {
        return t.skip(`symlinks unavailable: ${error.code}`)
      }
      throw error
    }

    const result = runInstaller(project, ["--force"])
    assert.notEqual(result.status, 0)
    assert.match(`${result.stdout}\n${result.stderr}`, /symlink/i)
    assert.equal(await readFile(outsideFile, "utf8"), "outside user file")
    await assert.rejects(readFile(join(project, FILES[1])), { code: "ENOENT" })
  })
})
