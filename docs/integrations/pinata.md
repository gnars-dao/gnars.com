# Pinata IPFS Upload Integration

Proposal banners, droposal media, propdate attachments, and bounty claim media upload
directly from the browser to Pinata. File bytes do not pass through a Vercel Function.
Uploads require a connected wallet and a signature authorizing the file metadata.

## Configuration

- Set the server-only `PINATA_JWT` with permission to create upload URLs through
  `https://uploads.pinata.cloud/v3/files/sign` (`org:files:write`). Never expose this JWT
  through a `NEXT_PUBLIC_*` variable or client code.
- Uploaded files use Pinata's public network. Stored references are `ipfs://{CID}`;
  the display gateway is `https://ipfs.skatehive.app/ipfs/{CID}`.
- Production Vercel WAF limits `POST /api/pinata/signed-url` to **60 requests per hour
  per IP**. The rule was published and verified during the repository audit. Preserve
  it when changing the firewall; the function's local counters are not a replacement.

See [Pinata's signed URL API](https://docs.pinata.cloud/api-reference/endpoint/create-signed-upload-url)
for the upstream size and MIME restriction fields, and
[Vercel quota strategy](../architecture/vercel-quota-strategy.md) for the other deployed
API rate limits.

## Request Flow

1. A component calls `usePinataUpload()` with a `File`, optional name, and optional
   progress callback. The hook uses the current `useWriteAccount()` signer.
2. `src/lib/pinata.ts` validates the name, explicit MIME type, and declared byte size.
3. The wallet signs a canonical request message binding the Gnars audience, Base chain,
   POST method, API path, file metadata digest, wallet address, issue time, and nonce.
4. The browser sends `{ upload, authorization }` as small JSON to
   `POST /api/pinata/signed-url`.
5. The server validates the payload and signature, then requests a Pinata URL with an
   exact MIME allowlist and `max_file_size` equal to the signed declared size.
6. The browser sends the multipart file directly to that URL. The result is converted
   into the existing `{ success, data: { cid, ipfsUrl, gatewayUrl, ... } }` shape.

The server uses viem's public-client signature verification, supporting EOA signatures
and ERC-1271/ERC-6492 smart wallets on Base. Authorizations expire after five minutes;
future issue times have at most 30 seconds of clock-skew tolerance. A nonce distinguishes
requests but is not persisted as a globally single-use token.

## Limits

| Control                              | Limit                                               | Enforcement                                                                      |
| ------------------------------------ | --------------------------------------------------- | -------------------------------------------------------------------------------- |
| Images and audio                     | 100 MiB per file                                    | Client schema, server schema, Pinata signed size cap                             |
| Video                                | 500 MiB per file                                    | Client schema, server schema, Pinata signed size cap                             |
| MIME type                            | Explicit `image/*`, `video/*`, or `audio/*` subtype | Server rejects empty/wildcard/arbitrary types; Pinata receives the exact subtype |
| Filename                             | 1-255 characters after trimming                     | Client and server schema                                                         |
| Signing request body                 | 24,000 bytes                                        | Streamed server byte limit                                                       |
| Signed upload URL                    | 60-second expiry                                    | Pinata                                                                           |
| URL requests per IP                  | 60 per hour                                         | Distributed Vercel WAF; secondary local counter                                  |
| URL requests per wallet              | 20 per hour                                         | Secondary process-local counter                                                  |
| Authorized declared bytes per wallet | 1 GiB per hour                                      | Secondary process-local counter                                                  |

Wallet counters reset on cold starts and are independent across function instances.
They are **not global wallet quotas**. The byte counter measures URL authorizations,
not completed upstream storage usage, and failed upload attempts still consume it.
Treat a signed URL as a short-lived bearer capability; do not publish it or log it.

## API Behavior

- Invalid metadata: `400`; missing/invalid/expired wallet authorization: `401`.
- Oversized JSON: `413`; exhausted local limit: `429` with `Retry-After`.
- Missing upload configuration or signature-verification outage: `503`.
- Pinata authorization failure: `502`.
- Signed URL responses and errors use `Cache-Control: no-store`.
- The retired `POST /api/pinata/upload` endpoint returns **410**. Do not send files
  there; its old multipart workflow cannot support large files on Vercel.

## Code and Verification

- `src/hooks/use-pinata-upload.ts`: wallet-aware component helper.
- `src/lib/pinata.ts`: authorization request, direct upload, progress, response parsing.
- `src/lib/pinata-policy.ts`: shared file constraints.
- `src/lib/wallet-authorization.ts`, `src/lib/server/request-security.ts`: signed
  request format, signature verification, streamed body limits, local counters.
- `src/app/api/pinata/signed-url/route.ts`: secured URL issuance.

Unit tests cover unsigned rejection without upstream access, byte/MIME limits, signed
provider constraints, signature expiry, and request binding. Runtime acceptance should
exercise a connected EOA and smart wallet, a small image, a video larger than 4.5 MB,
progress display, and all four upload surfaces. Automated tests mock upstream calls;
they do not consume Pinata storage.
