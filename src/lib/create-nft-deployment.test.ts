import { describe, expect, it } from "vitest";
import {
  canOriginateNftDeployment,
  isLocalNftDeploymentHost,
  isLocalNftDeploymentRequest,
  isNftWalletRejection,
} from "@/lib/create-nft-deployment";

describe("local NFT deployment safety", () => {
  it("never enables the deployment API in production", () => {
    expect(isLocalNftDeploymentHost("localhost:3100", "production")).toBe(false);
    expect(isLocalNftDeploymentHost("www.gnars.com", "development")).toBe(false);
    expect(isLocalNftDeploymentHost("localhost:3100", "development")).toBe(true);
  });
  it("rejects cross-origin local requests", () => {
    expect(
      isLocalNftDeploymentRequest(
        new Request("http://localhost:3100/api/local-nft-deploy", {
          headers: { host: "localhost:3100", origin: "https://evil.example" },
        }),
        "development",
      ),
    ).toBe(false);
  });
  it("allows EOA and 7702 origin but not smart-contract origin", () => {
    expect(canOriginateNftDeployment("0x")).toBe(true);
    expect(canOriginateNftDeployment(`0xef0100${"ab".repeat(20)}`)).toBe(true);
    expect(canOriginateNftDeployment("0x60806040")).toBe(false);
  });
  it("does not unlock unknown requests from guessed provider error messages", () => {
    expect(isNftWalletRejection(new Error("Transaction rejected after broadcast"))).toBe(false);
    expect(isNftWalletRejection({ cause: { code: 4001 } })).toBe(true);
  });
});
