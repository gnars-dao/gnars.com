# Morpheus Stake Recovery

The Ethereum stETH and USDC staking dialog uses three explicit transaction steps:
token approval, deposit, and rewards receiver configuration. A confirmed deposit
is not reported as fully configured until `claimReceiver(0, account)` matches the
deterministic split for the signer and rider.

## Ownership

- `src/lib/morpheus-stake-flow.ts`: injectable transaction controller, validated
  local journal, transaction identity checks, and receipt reconciliation.
- `src/hooks/use-morpheus-stake-flow.ts`: thirdweb signing adapter, Ethereum reads,
  account-scoped controller lifecycle, and existing-position discovery.
- `src/components/stake/MorpheusStakeProgress.tsx`: step status, explorer links,
  explicit continuation, status checks, and manual transaction hash verification.
- `src/components/stake/StakeDialog.tsx`: displays unfinished Ethereum flows when
  the dialog opens, including positions created before journals were introduced.

## Recovery Rules

- Journals are versioned and scoped to Ethereum, the actual signing account, and
  deposit pool. Amount, rider, and claim lock belong to the saved attempt.
- A returned hash is saved before receipt checks. Receipt success alone is not
  sufficient: account, target, calldata, and chain must match the intended step.
  Supported smart-account bundles also require the matching user-operation result.
- A timeout or an ambiguous wallet error never automatically resends a deposit.
  A user can check status or supply the existing transaction hash for validation.
- Closing the dialog does not cancel a wallet request or broadcast transaction.
  An unresolved attempt cannot be discarded through the UI.
- A funded position with the selected rider as its stored referrer and an
  incorrect receiver offers receiver-only recovery. An existing balance never
  proves that an attempted top-up succeeded.
- Read failures remain failures, not zero balances or permission to repeat an
  uncertain transaction. Completion requires a verified receiver.
- Cross-tab journal updates use Web Locks in a secure browser context. Browsers
  without this API fail closed instead of allowing concurrent signing requests.

This change does not modify vault staking, claim/withdrawal economics, reward
percentages, or deployed contracts. Clearing browser storage loses local attempt
history; an unknown deposit must still be checked against wallet history before
another deposit is initiated. Automated verification uses simulated signatures
and receipts, never live fund-moving transactions.
