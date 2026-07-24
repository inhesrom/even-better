import assert from "node:assert/strict";
import fs from "node:fs";
import { mkdtemp, mkdir, rm, symlink, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import { OwnedWorkspaceCatalog, parseWorkspaceRoots } from "../src/owned-workspaces.js";

const scratch = await mkdtemp(path.join(os.tmpdir(), "even-better-owned-workspaces-"));
after(() => rm(scratch, { recursive: true, force: true }));

test("workspace roots require existing canonical absolute directories", async () => {
  const root = path.join(scratch, "root");
  await mkdir(root);
  const alias = path.join(scratch, "root-link");
  await symlink(root, alias);
  assert.deepEqual(parseWorkspaceRoots(`${root}${path.delimiter}${alias}`), [fs.realpathSync(root)]);
  assert.deepEqual(parseWorkspaceRoots(undefined, root), [fs.realpathSync(root)]);
  assert.throws(() => parseWorkspaceRoots("relative"), /must be absolute/);
  assert.throws(() => parseWorkspaceRoots(path.join(scratch, "missing")), /not an accessible directory/);
});

test("directory resolution accepts shown, absolute, and uniquely root-relative paths", async () => {
  const root = path.join(scratch, "resolve-root");
  const project = path.join(root, "project");
  await mkdir(project, { recursive: true });
  const catalog = new OwnedWorkspaceCatalog([fs.realpathSync(root)]);
  assert.equal(catalog.resolve(project, [project]), fs.realpathSync(project));
  assert.equal(catalog.resolve(project), fs.realpathSync(project));
  assert.equal(catalog.resolve("project"), fs.realpathSync(project));
  assert.throws(() => catalog.resolve(path.join(scratch, "missing")), /not an accessible directory/);
  assert.throws(() => catalog.resolve(scratch), /outside WORKSPACE_ROOTS/);
});

test("relative paths must resolve to exactly one approved directory", async () => {
  const first = path.join(scratch, "ambiguous-a");
  const second = path.join(scratch, "ambiguous-b");
  await mkdir(path.join(first, "same"), { recursive: true });
  await mkdir(path.join(second, "same"), { recursive: true });
  const catalog = new OwnedWorkspaceCatalog([fs.realpathSync(first), fs.realpathSync(second)]);
  assert.throws(() => catalog.resolve("same"), /ambiguous/);
  assert.throws(() => catalog.resolve("absent"), /not an approved accessible directory/);
});

test("real paths prevent symlink escapes while allowing links that remain under a root", async () => {
  const root = path.join(scratch, "links-root");
  const inside = path.join(root, "inside");
  const outside = path.join(scratch, "outside");
  await mkdir(inside, { recursive: true });
  await mkdir(outside);
  await symlink(inside, path.join(root, "safe-link"));
  await symlink(outside, path.join(root, "escape-link"));
  const catalog = new OwnedWorkspaceCatalog([fs.realpathSync(root)]);
  assert.equal(catalog.resolve(path.join(root, "safe-link")), fs.realpathSync(inside));
  assert.throws(() => catalog.resolve(path.join(root, "escape-link")), /outside WORKSPACE_ROOTS/);
  assert.ok(!catalog.choices().includes(fs.realpathSync(outside)));
});

test("choices use MRU before modification time and include only roots and immediate children", async () => {
  const root = path.join(scratch, "rank-root");
  const older = path.join(root, "older");
  const newer = path.join(root, "newer");
  const nested = path.join(newer, "nested");
  await mkdir(older, { recursive: true });
  await mkdir(nested, { recursive: true });
  const now = Date.now() / 1000;
  await utimes(older, now - 100, now - 100);
  await utimes(newer, now, now);
  const catalog = new OwnedWorkspaceCatalog([fs.realpathSync(root)]);
  const choices = catalog.choices(10);
  assert.ok(choices.indexOf(newer) < choices.indexOf(older));
  assert.ok(!choices.includes(nested));
  catalog.touch(older);
  assert.equal(catalog.choices(1)[0], older);
  catalog.touch(nested);
  assert.equal(catalog.choices(1)[0], nested);
});
