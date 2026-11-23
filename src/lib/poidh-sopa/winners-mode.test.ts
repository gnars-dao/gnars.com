import { describe, expect, it } from "vitest";
import { allowedWinnersModes } from "./winners-mode";

describe("allowedWinnersModes", () => {
  it("solo bounties can only pay", () => {
    expect(allowedWinnersModes({ isOpenBounty: false, everHadExternalContributor: false })).toEqual(
      ["pay"],
    );
  });

  it("open bounties funded only by the creator can pay or go to a vote", () => {
    expect(allowedWinnersModes({ isOpenBounty: true, everHadExternalContributor: false })).toEqual([
      "pay",
      "vote",
    ]);
  });

  it("open bounties that ever had outside money must go to a vote", () => {
    expect(allowedWinnersModes({ isOpenBounty: true, everHadExternalContributor: true })).toEqual([
      "vote",
    ]);
  });

  it("a solo bounty never offers a vote, whatever the contributor flag says", () => {
    expect(allowedWinnersModes({ isOpenBounty: false, everHadExternalContributor: true })).toEqual([
      "pay",
    ]);
  });
});
