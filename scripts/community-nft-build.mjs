import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../contracts/gnars-community-nft");
const lock = JSON.parse(await readFile(join(root, "upstream-lock.json"), "utf8"));
const hashes = {};
const hash = (value) => createHash("sha256").update(value).digest("hex");
if (process.argv.includes("--fetch")) {
  const response = await fetch(
    `https://raw.githubusercontent.com/${lock.repository}/${lock.commit}/LICENSE`,
  );
  assert(response.ok);
  await mkdir(join(root, "vendor/openzeppelin"), { recursive: true });
  await writeFile(join(root, "vendor/openzeppelin/LICENSE"), await response.text());
}
async function vendor(path) {
  if (hashes[path]) return;
  const target = join(root, "vendor/openzeppelin", path);
  let content;
  if (process.argv.includes("--fetch")) {
    const response = await fetch(
      `https://raw.githubusercontent.com/${lock.repository}/${lock.commit}/contracts/${path}`,
    );
    assert(response.ok, `Cannot fetch ${path}`);
    content = await response.text();
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  } else content = await readFile(target, "utf8");
  hashes[path] = hash(content);
  for (const match of content.matchAll(/import\s+(?:[^;]*?from\s+)?["']([^"']+)["'];/g)) {
    await vendor(posix.normalize(posix.join(posix.dirname(path), match[1])));
  }
}
await vendor("token/ERC721/extensions/ERC721URIStorage.sol");
await vendor("token/common/ERC2981.sol");
await vendor("utils/ReentrancyGuard.sol");
const manifest = join(root, "source-hashes.json");
if (process.argv.includes("--fetch"))
  await writeFile(manifest, JSON.stringify(hashes, null, 2) + "\n");
else assert.deepEqual(hashes, JSON.parse(await readFile(manifest, "utf8")));
const built = spawnSync(join(homedir(), ".foundry/bin/forge"), ["build", "--force"], {
  cwd: root,
  stdio: "inherit",
});
assert.equal(built.status, 0);
const output = JSON.parse(
  await readFile(join(root, "out/GnarsCommunityNFT.sol/GnarsCommunityNFT.json"), "utf8"),
);
assert.equal(output.metadata.compiler.version, lock.compiler);
await mkdir(join(root, "artifacts"), { recursive: true });
await writeFile(
  join(root, "artifacts/GnarsCommunityNFT.json"),
  JSON.stringify(
    {
      abi: output.abi,
      creationBytecode: output.bytecode.object,
      deployedBytecode: output.deployedBytecode.object,
      immutableReferences: output.deployedBytecode.immutableReferences,
      creationBytecodeSha256: hash(Buffer.from(output.bytecode.object.slice(2), "hex")),
      metadata: output.metadata,
    },
    null,
    2,
  ) + "\n",
);
