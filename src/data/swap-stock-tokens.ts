import { getAddress } from "viem";
import type { SwapDirectoryToken } from "@/lib/swap-token-directory";

// Official Base B20 registry; decimals, symbols, names and contractURI verified on Base 2026-09-07.
const sourceUrl =
  "https://docs.base.org/specifications/b20/tokenized-stocks-on-base#contract-addresses";
const registry = [
  [
    "AAPLc",
    "Apple Inc.",
    "0xb200000000000000000000C2e324d24d7eEcd1fb",
    "873819f4b14efe44b94abecbc8e8864d2998163abd0ca55b449ee6eb07d0d94c",
  ],
  [
    "AMZNc",
    "Amazon.com Inc.",
    "0xb200000000000000000000d9192b6B456483C2E8",
    "06d3c2cac2c89e3a8bc4b2fe40ff259f104b55244321dea400e44b22f215896b",
  ],
  [
    "COINc",
    "Coinbase Global Inc.",
    "0xb200000000000000000000c85a31389D71F3ecfb",
    "fe40327c3d69c3c210e6d2b0819e69514f5be58dff6605507583170b7bb14790",
  ],
  [
    "CRCLc",
    "Circle Internet Group Inc.",
    "0xB20000000000000000000019f6E7C675b73C2e4D",
    "f217835f2637739f460cc9335a59ec96011c1b9510a40cee3243aeef50eb7a45",
  ],
  [
    "GOOGLc",
    "Alphabet Inc.",
    "0xb2000000000000000000002D0BA3164cc74f58B7",
    "0e80e31df40f7c42b49a3c7f6d23c6351625d73f235aeb69006ddee9221702b0",
  ],
  [
    "INTCc",
    "Intel Corporation",
    "0xB2000000000000000000004AFF16039bA04bdFBc",
    "cc2d84b704e34b83b5fc1f3b0e89c67e5ccc9142e666a50a5cbde261cf09e2aa",
  ],
  [
    "METAc",
    "Meta Platforms Inc.",
    "0xb2000000000000000000008bC8786B856E61707C",
    "1cedbfb3caee9498470945ff5041715b8c90921d904b3567a43bc4df82069e66",
  ],
  [
    "MSFTc",
    "Microsoft Corporation",
    "0xB200000000000000000000Ab99cFa739E253872B",
    "e90930ade985016f48816c6bd9fd1e8274b28507f4833881b3a16c77c2a3e2e7",
  ],
  [
    "MSTRc",
    "Strategy Inc.",
    "0xb2000000000000000000004884b426556b92883d",
    "496024423dd795f8b547ffa0668f12a1e6bf09af247534754546a1a6661c7969",
  ],
  [
    "NVDAc",
    "NVIDIA Corporation",
    "0xb20000000000000000000078ee7ce2fE4908108C",
    "1fee9b7a44e800d438dd9d96c3283e05784c925c2c871a48ff735950740b551a",
  ],
  [
    "SNDKc",
    "Sandisk Corporation",
    "0xb200000000000000000000397293Cb8cda9a10c5",
    "495de6bc9902690826d533b9506494890f59d611d10f04231c00936f659bb0cb",
  ],
  [
    "SPCXc",
    "Space Exploration Technologies Corp.",
    "0xb2000000000000000000007b9fcbd005511aCBd5",
    "79fa65beabbe27c7b84a38b8f67a492793a0c203a5312c8feddc23e4b7c66b79",
  ],
  [
    "TSLAc",
    "Tesla Inc.",
    "0xb2000000000000000000001e800a7f5189430cD0",
    "a3b67028295d0e9fa3182c867b8a9afed5ebcbd8c012de3a46e160ae5e490980",
  ],
] as const;

export const VERIFIED_BASE_STOCK_TOKENS: readonly SwapDirectoryToken[] = registry.map(
  ([symbol, name, address, image]) => ({
    address: getAddress(address),
    symbol,
    name,
    decimals: 8,
    logo: `https://metadata.coinbase.com/equity_icons/${image}.png`,
    category: "stock",
    source: "coinbase",
    sourceUrl,
  }),
);
