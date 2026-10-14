/**
 * PoidhSopa ABI (functions, events, errors), copied from the fork's Foundry build
 * (PoidhSopa.json artifact). Regenerate on contract change.
 */
export const POIDH_SOPA_ABI = [
  {
    type: "constructor",
    inputs: [
      {
        name: "_poidhNft",
        type: "address",
        internalType: "address",
      },
      {
        name: "_poidhTreasury",
        type: "address",
        internalType: "address",
      },
      {
        name: "_sopaTreasury",
        type: "address",
        internalType: "address",
      },
      {
        name: "_startClaimIndex",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "_minBountyAmount",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "_minContribution",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "nonpayable",
  },
  {
    type: "receive",
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "BPS_DENOM",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "ETH",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MAX_CATEGORY_LENGTH",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MAX_PARTICIPANTS",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MAX_TOTAL_FEE_BPS",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MAX_WINNERS",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MIN_BOUNTY_AMOUNT",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "MIN_CONTRIBUTION",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "acceptClaims",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "claimIds",
        type: "uint256[]",
        internalType: "uint256[]",
      },
      {
        name: "sharesBps",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "acceptOwnership",
    inputs: [],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "accounted",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "bounties",
    inputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "issuer",
        type: "address",
        internalType: "address",
      },
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "name",
        type: "string",
        internalType: "string",
      },
      {
        name: "description",
        type: "string",
        internalType: "string",
      },
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "claimer",
        type: "address",
        internalType: "address",
      },
      {
        name: "createdAt",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "bountyClaims",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "claimIds",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "bountyCounter",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "bountyFees",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "poidhBps",
        type: "uint16",
        internalType: "uint16",
      },
      {
        name: "sopaBps",
        type: "uint16",
        internalType: "uint16",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "bountyVotingTracker",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "yes",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "no",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "deadline",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "cancelOpenBounty",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "cancelSoloBounty",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claimCounter",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "claimRefundFromCancelledOpenBounty",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "claims",
    inputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "id",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "issuer",
        type: "address",
        internalType: "address",
      },
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "bountyIssuer",
        type: "address",
        internalType: "address",
      },
      {
        name: "name",
        type: "string",
        internalType: "string",
      },
      {
        name: "description",
        type: "string",
        internalType: "string",
      },
      {
        name: "createdAt",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "accepted",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "createClaim",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "name",
        type: "string",
        internalType: "string",
      },
      {
        name: "description",
        type: "string",
        internalType: "string",
      },
      {
        name: "uri",
        type: "string",
        internalType: "string",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "createOpenBounty",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "name",
        type: "string",
        internalType: "string",
      },
      {
        name: "description",
        type: "string",
        internalType: "string",
      },
      {
        name: "category",
        type: "string",
        internalType: "string",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "createSoloBounty",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "name",
        type: "string",
        internalType: "string",
      },
      {
        name: "description",
        type: "string",
        internalType: "string",
      },
      {
        name: "category",
        type: "string",
        internalType: "string",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "everHadExternalContributor",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "hadExternalContributor",
        type: "bool",
        internalType: "bool",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getBounties",
    inputs: [
      {
        name: "offset",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        internalType: "struct PoidhSopa.Bounty[]",
        components: [
          {
            name: "id",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "issuer",
            type: "address",
            internalType: "address",
          },
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "name",
            type: "string",
            internalType: "string",
          },
          {
            name: "description",
            type: "string",
            internalType: "string",
          },
          {
            name: "amount",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "claimer",
            type: "address",
            internalType: "address",
          },
          {
            name: "createdAt",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getBountiesByUser",
    inputs: [
      {
        name: "user",
        type: "address",
        internalType: "address",
      },
      {
        name: "offset",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        internalType: "struct PoidhSopa.Bounty[]",
        components: [
          {
            name: "id",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "issuer",
            type: "address",
            internalType: "address",
          },
          {
            name: "token",
            type: "address",
            internalType: "address",
          },
          {
            name: "name",
            type: "string",
            internalType: "string",
          },
          {
            name: "description",
            type: "string",
            internalType: "string",
          },
          {
            name: "amount",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "claimer",
            type: "address",
            internalType: "address",
          },
          {
            name: "createdAt",
            type: "uint256",
            internalType: "uint256",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getBountiesLength",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getClaimsByBountyId",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "offset",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        internalType: "struct PoidhSopa.Claim[]",
        components: [
          {
            name: "id",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "issuer",
            type: "address",
            internalType: "address",
          },
          {
            name: "bountyId",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "bountyIssuer",
            type: "address",
            internalType: "address",
          },
          {
            name: "name",
            type: "string",
            internalType: "string",
          },
          {
            name: "description",
            type: "string",
            internalType: "string",
          },
          {
            name: "createdAt",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "accepted",
            type: "bool",
            internalType: "bool",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getClaimsByUser",
    inputs: [
      {
        name: "user",
        type: "address",
        internalType: "address",
      },
      {
        name: "offset",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "tuple[]",
        internalType: "struct PoidhSopa.Claim[]",
        components: [
          {
            name: "id",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "issuer",
            type: "address",
            internalType: "address",
          },
          {
            name: "bountyId",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "bountyIssuer",
            type: "address",
            internalType: "address",
          },
          {
            name: "name",
            type: "string",
            internalType: "string",
          },
          {
            name: "description",
            type: "string",
            internalType: "string",
          },
          {
            name: "createdAt",
            type: "uint256",
            internalType: "uint256",
          },
          {
            name: "accepted",
            type: "bool",
            internalType: "bool",
          },
        ],
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getCurrentProposal",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "claimIds",
        type: "uint256[]",
        internalType: "uint256[]",
      },
      {
        name: "sharesBps",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getParticipants",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "",
        type: "address[]",
        internalType: "address[]",
      },
      {
        name: "",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getParticipantsPaged",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "offset",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "limit",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "addrs",
        type: "address[]",
        internalType: "address[]",
      },
      {
        name: "amts",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "getWinners",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "claimIds",
        type: "uint256[]",
        internalType: "uint256[]",
      },
      {
        name: "sharesBps",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "joinOpenBounty",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "payable",
  },
  {
    type: "function",
    name: "owner",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "participantAmounts",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "participantContributionAmounts",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "participants",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "participantAddresses",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pendingOwner",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "pendingWithdrawals",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "poidhFeeBps",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint16",
        internalType: "uint16",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "poidhNft",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "contract IPoidhClaimNFT",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "poidhTreasury",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "renounceOwnership",
    inputs: [],
    outputs: [],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "resetVotingPeriod",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "resolveVote",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setFees",
    inputs: [
      {
        name: "_poidhFeeBps",
        type: "uint16",
        internalType: "uint16",
      },
      {
        name: "_sopaFeeBps",
        type: "uint16",
        internalType: "uint16",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setPoidhTreasury",
    inputs: [
      {
        name: "_treasury",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "setSopaTreasury",
    inputs: [
      {
        name: "_treasury",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "sopaFeeBps",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint16",
        internalType: "uint16",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "sopaTreasury",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "address",
        internalType: "address",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "submitWinnersForVote",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "claimIds",
        type: "uint256[]",
        internalType: "uint256[]",
      },
      {
        name: "sharesBps",
        type: "uint256[]",
        internalType: "uint256[]",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "transferOwnership",
    inputs: [
      {
        name: "newOwner",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "userBounties",
    inputs: [
      {
        name: "user",
        type: "address",
        internalType: "address",
      },
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "bountyIds",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "userClaims",
    inputs: [
      {
        name: "user",
        type: "address",
        internalType: "address",
      },
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "claimIds",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "voteClaim",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "vote",
        type: "bool",
        internalType: "bool",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "voteRound",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [
      {
        name: "roundId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "voteWeightSnapshot",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
      {
        name: "participant",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [
      {
        name: "weight",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "votingPeriod",
    inputs: [],
    outputs: [
      {
        name: "",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    stateMutability: "view",
  },
  {
    type: "function",
    name: "withdraw",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "withdrawFromOpenBounty",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        internalType: "uint256",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "function",
    name: "withdrawTo",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        internalType: "address payable",
      },
    ],
    outputs: [],
    stateMutability: "nonpayable",
  },
  {
    type: "event",
    name: "BountyCancelled",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "issuer",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "issuerRefund",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "round",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "BountyCreated",
    inputs: [
      {
        name: "id",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "issuer",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "token",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "title",
        type: "string",
        indexed: false,
        internalType: "string",
      },
      {
        name: "description",
        type: "string",
        indexed: false,
        internalType: "string",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "createdAt",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "isOpenBounty",
        type: "bool",
        indexed: false,
        internalType: "bool",
      },
      {
        name: "category",
        type: "string",
        indexed: false,
        internalType: "string",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "BountyJoined",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "participant",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "latestBountyBalance",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "round",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "BountyPaid",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "token",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "bountyAmount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "poidhFee",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "sopaFee",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "winners",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "round",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ClaimAccepted",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "claimId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "claimIssuer",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "bountyIssuer",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "shareBps",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "payout",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "round",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "ClaimCreated",
    inputs: [
      {
        name: "id",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "issuer",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "bountyId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "bountyIssuer",
        type: "address",
        indexed: false,
        internalType: "address",
      },
      {
        name: "title",
        type: "string",
        indexed: false,
        internalType: "string",
      },
      {
        name: "description",
        type: "string",
        indexed: false,
        internalType: "string",
      },
      {
        name: "createdAt",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "imageUri",
        type: "string",
        indexed: false,
        internalType: "string",
      },
      {
        name: "round",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "FeesUpdated",
    inputs: [
      {
        name: "poidhFeeBps",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "sopaFeeBps",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OwnershipTransferStarted",
    inputs: [
      {
        name: "previousOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "newOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "OwnershipTransferred",
    inputs: [
      {
        name: "previousOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "newOwner",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "PoidhTreasuryUpdated",
    inputs: [
      {
        name: "treasury",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "RefundClaimed",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "participant",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "round",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "SopaTreasuryUpdated",
    inputs: [
      {
        name: "treasury",
        type: "address",
        indexed: true,
        internalType: "address",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "VoteCast",
    inputs: [
      {
        name: "voter",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "bountyId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "support",
        type: "bool",
        indexed: false,
        internalType: "bool",
      },
      {
        name: "weight",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "round",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "VotingResolved",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "passed",
        type: "bool",
        indexed: false,
        internalType: "bool",
      },
      {
        name: "yes",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "no",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "round",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "VotingStarted",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "claimIds",
        type: "uint256[]",
        indexed: false,
        internalType: "uint256[]",
      },
      {
        name: "sharesBps",
        type: "uint256[]",
        indexed: false,
        internalType: "uint256[]",
      },
      {
        name: "deadline",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "issuerYesWeight",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "round",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "WithdrawFromOpenBounty",
    inputs: [
      {
        name: "bountyId",
        type: "uint256",
        indexed: true,
        internalType: "uint256",
      },
      {
        name: "participant",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "latestBountyAmount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
      {
        name: "round",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "Withdrawal",
    inputs: [
      {
        name: "user",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "token",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "event",
    name: "WithdrawalTo",
    inputs: [
      {
        name: "user",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "token",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "to",
        type: "address",
        indexed: true,
        internalType: "address",
      },
      {
        name: "amount",
        type: "uint256",
        indexed: false,
        internalType: "uint256",
      },
    ],
    anonymous: false,
  },
  {
    type: "error",
    name: "AlreadyVoted",
    inputs: [],
  },
  {
    type: "error",
    name: "AmountMismatch",
    inputs: [],
  },
  {
    type: "error",
    name: "BountyClaimed",
    inputs: [],
  },
  {
    type: "error",
    name: "BountyClosed",
    inputs: [],
  },
  {
    type: "error",
    name: "BountyNotFound",
    inputs: [],
  },
  {
    type: "error",
    name: "ClaimAlreadyAccepted",
    inputs: [],
  },
  {
    type: "error",
    name: "ClaimNotFound",
    inputs: [],
  },
  {
    type: "error",
    name: "DirectEtherNotAccepted",
    inputs: [],
  },
  {
    type: "error",
    name: "DuplicateWinner",
    inputs: [],
  },
  {
    type: "error",
    name: "FeeTooHigh",
    inputs: [
      {
        name: "totalBps",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "InsufficientBalance",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidCategory",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidMinBountyAmount",
    inputs: [
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "InvalidMinContribution",
    inputs: [
      {
        name: "amount",
        type: "uint256",
        internalType: "uint256",
      },
    ],
  },
  {
    type: "error",
    name: "InvalidPoidhNft",
    inputs: [
      {
        name: "poidhNft",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "InvalidStartClaimIndex",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidToken",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "InvalidTreasury",
    inputs: [
      {
        name: "treasury",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "InvalidWinners",
    inputs: [],
  },
  {
    type: "error",
    name: "InvalidWithdrawTo",
    inputs: [
      {
        name: "to",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "IssuerCannotClaim",
    inputs: [],
  },
  {
    type: "error",
    name: "IssuerCannotWithdraw",
    inputs: [],
  },
  {
    type: "error",
    name: "MaxParticipantsReached",
    inputs: [],
  },
  {
    type: "error",
    name: "MinimumBountyNotMet",
    inputs: [],
  },
  {
    type: "error",
    name: "MinimumContributionNotMet",
    inputs: [],
  },
  {
    type: "error",
    name: "NoEther",
    inputs: [],
  },
  {
    type: "error",
    name: "NoVotingPeriodSet",
    inputs: [],
  },
  {
    type: "error",
    name: "NotActiveParticipant",
    inputs: [],
  },
  {
    type: "error",
    name: "NotCancelledOpenBounty",
    inputs: [],
  },
  {
    type: "error",
    name: "NotOpenBounty",
    inputs: [],
  },
  {
    type: "error",
    name: "NotSoloBounty",
    inputs: [],
  },
  {
    type: "error",
    name: "NothingToWithdraw",
    inputs: [],
  },
  {
    type: "error",
    name: "OwnableInvalidOwner",
    inputs: [
      {
        name: "owner",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "OwnableUnauthorizedAccount",
    inputs: [
      {
        name: "account",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "ReentrancyGuardReentrantCall",
    inputs: [],
  },
  {
    type: "error",
    name: "RenounceDisabled",
    inputs: [],
  },
  {
    type: "error",
    name: "SafeERC20FailedOperation",
    inputs: [
      {
        name: "token",
        type: "address",
        internalType: "address",
      },
    ],
  },
  {
    type: "error",
    name: "SharesMustSumToDenom",
    inputs: [],
  },
  {
    type: "error",
    name: "TransferFailed",
    inputs: [],
  },
  {
    type: "error",
    name: "UnexpectedEther",
    inputs: [],
  },
  {
    type: "error",
    name: "VoteWouldPass",
    inputs: [],
  },
  {
    type: "error",
    name: "VotingEnded",
    inputs: [],
  },
  {
    type: "error",
    name: "VotingOngoing",
    inputs: [],
  },
  {
    type: "error",
    name: "WrongCaller",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroAmount",
    inputs: [],
  },
  {
    type: "error",
    name: "ZeroShare",
    inputs: [],
  },
] as const;

/** Minimal claim NFT surface: the tokenURI holds the claim's media URI. */
export const POIDH_CLAIM_NFT_ABI = [
  {
    type: "function",
    name: "tokenURI",
    stateMutability: "view",
    inputs: [{ name: "tokenId", type: "uint256" }],
    outputs: [{ name: "", type: "string" }],
  },
] as const;
