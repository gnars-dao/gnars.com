import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256 } from "viem";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../contracts/gnars-marketplace");
const lock = JSON.parse(await readFile(join(root, "upstream-lock.json"), "utf8"));
const sha256 = (data) => createHash("sha256").update(data).digest("hex");
const run = (cmd, args, cwd = root) => {
  const result = spawnSync(cmd, args, { cwd, stdio: "inherit" });
  assert.equal(result.status, 0, `${cmd} failed`);
};

// Refresh only with an explicit flag. Normal builds verify every vendored source byte.
if (process.argv.includes("--fetch")) {
  const temp = await mkdtemp(join(tmpdir(), "gnars-seaport-source-"));
  try {
    for (const source of lock.sources) {
      const response = await fetch(
        `https://codeload.github.com/${source.repository}/tar.gz/${source.commit}`,
      );
      assert(response.ok, `Source download failed: ${source.repository}`);
      const archive = join(temp, `${source.directory}.tar.gz`);
      await writeFile(archive, Buffer.from(await response.arrayBuffer()));
      const extracted = join(temp, source.directory);
      await mkdir(extracted);
      run("tar", ["-xzf", archive, "--strip-components=1", "-C", extracted]);
      const target = join(root, "vendor", source.directory);
      await mkdir(target, { recursive: true });
      await rm(join(target, "src"), { recursive: true, force: true });
      await cp(join(extracted, "src"), join(target, "src"), { recursive: true });
      await cp(join(extracted, "LICENSE"), join(target, "LICENSE"));
    }
  } finally {
    await rm(temp, { recursive: true, force: true });
  }
}

async function files(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const result = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result.sort();
}
const manifest = {};
for (const file of await files(join(root, "vendor"))) {
  manifest[file.slice(root.length + 1)] = sha256(await readFile(file));
}
const manifestPath = join(root, "source-hashes.json");
if (process.argv.includes("--fetch")) {
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
} else {
  assert.deepEqual(manifest, JSON.parse(await readFile(manifestPath, "utf8")), "Source changed");
}

run(process.env.FORGE_BIN ?? join(homedir(), ".foundry/bin/forge"), [
  "build",
  "--force",
  "--no-lint",
]);
const output = JSON.parse(await readFile(join(root, "out/Seaport.sol/Seaport.json"), "utf8"));
assert.equal(output.metadata.compiler.version, lock.compiler, "Unexpected compiler");
assert.equal(
  output.bytecode.linkReferences && Object.keys(output.bytecode.linkReferences).length,
  0,
);
const artifact = {
  contractName: "Seaport",
  contractVersion: "1.6",
  chainId: 8453,
  compiler: lock.compiler,
  source: "vendor/seaport-core/src/Seaport.sol",
  conduitController: lock.conduitController,
  abi: output.abi,
  creationBytecode: output.bytecode.object,
  deployedBytecode: output.deployedBytecode.object,
  immutableReferences: output.deployedBytecode.immutableReferences,
  creationBytecodeSha256: sha256(Buffer.from(output.bytecode.object.slice(2), "hex")),
  sourceManifestSha256: sha256(await readFile(manifestPath)),
  metadata: output.metadata,
};
await mkdir(join(root, "artifacts"), { recursive: true });
await writeFile(join(root, "artifacts/Seaport.json"), `${JSON.stringify(artifact, null, 2)}\n`);
const buildInfoDirectory = join(root, "out/build-info");
const buildInfoFiles = await readdir(buildInfoDirectory);
assert.equal(buildInfoFiles.length, 1, "Expected one clean build-info file");
const buildInfo = JSON.parse(await readFile(join(buildInfoDirectory, buildInfoFiles[0]), "utf8"));
const immutableNames = {};
function visit(node) {
  if (!node || typeof node !== "object") return;
  if (node.nodeType === "VariableDeclaration" && node.mutability === "immutable")
    immutableNames[node.id] = node.name;
  for (const value of Object.values(node))
    if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === "object") visit(value);
}
for (const source of Object.values(buildInfo.output.sources)) visit(source.ast);
const immutableReferences = {};
const maskedRuntime = Buffer.from(artifact.deployedBytecode.slice(2), "hex");
for (const [id, slots] of Object.entries(artifact.immutableReferences)) {
  assert(immutableNames[id], `Missing immutable AST name ${id}`);
  immutableReferences[immutableNames[id]] = slots;
  for (const { start, length } of slots) maskedRuntime.fill(0, start, start + length);
}
await writeFile(
  join(root, "artifacts/runtime-manifest.json"),
  `${JSON.stringify(
    {
      version: lock.version,
      conduitController: lock.conduitController,
      runtimeBytes: maskedRuntime.length,
      maskedRuntimeKeccak256: keccak256(`0x${maskedRuntime.toString("hex")}`),
      immutableReferences,
    },
    null,
    2,
  )}\n`,
);
if (buildInfo.input) {
  await writeFile(
    join(root, "artifacts/standard-input.json"),
    `${JSON.stringify(buildInfo.input, null, 2)}\n`,
  );
}
console.log(`Built unmodified Seaport ${lock.version}; ${artifact.creationBytecodeSha256}`);
