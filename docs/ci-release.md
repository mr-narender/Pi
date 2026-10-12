# Pi CI and stable releases

Issue: [#13](https://github.com/mr-narender/Pi/issues/13).

`.github/workflows/pi.yml` checks every PR into main and every main push. The
single required-check candidate is **pi-quality**. It covers format, lint, source
types, test types, non-clean build, coverage contract, unit, integration, real Pi,
VS Code extension host and VSIX inspection, plus upstream RPC drift. PRs check
the exact PR head; main checks the exact pushed commit. Fork PR jobs have read-only
permissions and receive no publishing secret. Actions are pinned to full official
commit SHAs. Node **26.11.1**, Pi SDK **1.1.0** and VS Code **1.141.0** are pinned.
The pinned checkout/setup/artifact actions use their native Node 24 runtimes
(Actions Runner 2.327.1 or newer), separately from the project's Node version.
Upload v6 and download v7 retain the immutable named artifact transfer used here.
Azure login alone receives `AZURE_CORE_OUTPUT=json` because its private CLI
version probe parses JSON. The release job and publishing children retain
`AZURE_CORE_OUTPUT=none`; permissions and OIDC scope are unchanged.
Both the extension and isolated SDK dependency trees use committed lockfiles.
The isolated SDK lock uses npm's nested layout to keep the existing native test
permission boundary limited to that SDK package; it does not grant parent-directory
read access for hoisted dependencies.
The SDK pin is only for testing; product configured-executable/PATH precedence
and opt-in managed installation are unchanged.

The version must increase in package.json, package-lock.json and CHANGELOG in the
reviewed PR. A successful main run inspects one stable VSIX, stores its SHA256,
source commit and bundle hashes, and passes that exact artifact to publication.
The release job validates the receipt/source/package again without rebuilding,
creates a draft GitHub release/tag at that commit, uploads the VSIX and receipt,
publishes those exact VSIX bytes to Marketplace, then waits for the stable version
listing, exact approved VSIX SHA256 and versioned Details README asset to agree
before publishing the GitHub draft. README bytes are checked against the approved
VSIX, including during recovery. Propagation polling has a ten-minute deadline,
with exponential delays starting at two seconds and capped at thirty seconds;
public HTTP requests share the remaining deadline. Missing assets, stale metadata
or README content, rate limits and transient service failures are retried.
Authorization, wrong package bytes, channel conflicts and newer versions fail
immediately. An approved package already visible at its versioned URL is never
republished just because the version listing is stale. A propagation timeout
retains the GitHub draft: rerun failed jobs with the same verified artifact.
Main pushes with an unchanged version relative to the event's **before** commit
skip publication, including multi-commit/rebase merges. Full checkout history
binds that before commit to main ancestry; initial/deleted/rewritten main histories
fail and require owner recovery. Rollbacks, prerelease
channels, wrong tag commits or conflicting remote checksums fail closed.

Marketplace authentication uses GitHub main-only OIDC and pinned `azure/login`,
with no subscription required. Only the trusted main release job receives
`id-token: write`; PRs receive neither Azure login nor identity secrets. VSCE uses
`--azure-credential` and the isolated Azure CLI session; there is no PAT fallback.
GitHub's built-in token handles release assets and read-only original quality proof.
Git/unzip receive no release credentials; Azure/VSCE children receive only benign
runtime settings and the isolated Azure config directory, never GitHub, OIDC
runtime, client-secret or PAT environment variables.

After source/artifact validation, main runs read the Marketplace profile using
`az rest` and display only its validated UUID. This does not publish or require
publisher Contributor access. Unchanged-version pushes still display that ID and
skip publication. Child output, credentials, HTTP bodies and assertion values stay
private; failures expose only fixed stages/categories and bounded HTTP/exit numbers.

After partial failures, **rerun failed jobs** on the same workflow run: the
successful quality artifact is reused. Existing verified tags/assets/Marketplace
versions are retained and completed, never overwritten or force-pushed. Do not
rerun every job after a partial publication: ZIP timestamps can produce different
bytes even at the same commit. The artifact is retained for 30 days; after expiry,
recover the original package from the verified GitHub draft rather than rebuild
and silently overwrite a published version. Rapid main pushes share a
non-cancelling concurrency group with `queue: max`; pending main runs are queued
instead of replaced, and an active publication is not interrupted.

For the pending approved **0.2.28** draft from
`348242035cbe410d35fc3c83eedde671e8badb50`, merging this authentication correction
does not publish a replacement package or change its version. The original VSIX
SHA256 is `1d4c8a710e81652be563eba03bb736e130b48b72850d240dc8f4952b8cf358e8`.
After granting the displayed profile ID Contributor access, run **Pi** manually
on **main**, choosing **retry-pending-release**. Older workflow runs retain their
old authentication source and cannot recover through the new OIDC flow.

Manual **profile** (the default) only reads the ID. **retry-pending-release** accepts
only the existing draft for the current package version, with no SHA/artifact
input. It validates its tag, source ancestry, original successful main **pi-quality**,
unique asset hashes, downloaded receipt/package, original packaged source and
its match to reviewed current main, including current quality bundle hashes and
CHANGELOG source. The draft must contain exactly its receipt and VSIX assets. All sorted archive entry
names and every entry's content hash must equal the validated current quality VSIX;
ZIP container hashes may differ because of metadata such as timestamps.
It runs only reviewed current scripts; old source is inspected without executing its scripts or hooks. The original source parent must have an
older version. It preserves original receipt bytes and package checksums and
uses the existing idempotent release stages. An absent/already completed draft or
any mismatch fails closed; this is a finite pending-draft recovery route.

## Owner setup before merge

1. Set repository Actions **secrets** **AZURE_CLIENT_ID** and **AZURE_TENANT_ID**
   for the already configured identity. Federation must use issuer
   `https://token.actions.githubusercontent.com`, audience `api://AzureADTokenExchange`
   and exact subject `repo:mr-narender/Pi:ref:refs/heads/main`. Do not broaden it to
   PRs, branches or environments. No subscription, client secret or PAT is required.
   After merge, copy the displayed **Marketplace profile ID** into publisher
   **mr-narender**'s members and grant **Contributor**. This is the profile UUID,
   not the Entra object ID or client ID. Profile lookup alone does not establish
   publishing permission. Identity/federation/member changes remain owner operations.
2. The owner can separately require check **pi-quality** from GitHub Actions,
   up-to-date branches and restricted direct pushes/bypasses. Independent required
   PR/code-owner review needs an approved reviewer route first: the only verified
   collaborator is **mr-narender**, also the approved PR author, and GitHub forbids
   authors approving their own PRs. Enabling sole-owner required review now would
   deadlock these PRs. `.github/CODEOWNERS` names **@mr-narender** for future
   independent-author routing; it activates no setting. Keep local quality/security
   enforcement until an owner-selected independent reviewer or approved bot route
   and all CI trust prerequisites are verified. Do not self-approve, bypass controls
   or create a new account. Human owner review and merge remain required by shared
   workflow governance.
3. Review and merge. Future reviewed version increases publish automatically
   after **pi-quality** succeeds and the identity has Contributor access. This
   unchanged-version OIDC correction first provides the profile ID; then use
   the manual pending-draft retry above for **0.2.28**.

Branch settings and secret configuration are owner operations, not activated by
this source PR. Registry policy must retain local gates until required status,
workflow integrity and runner trust are verified; the workflow alone proves none
of those server controls.

Node availability is verified against its [official 26.11.1 release](https://nodejs.org/en/blog/release/v26.11.1).
OIDC/profile authorization follows the
[official publishing guidance](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)
and [Azure login guidance](https://github.com/Azure/login).
This PR does not create identity/cloud infrastructure or grant publisher access.

The locally installed official actionlint **1.7.12** predates GitHub's supported
`queue: max` field. Validation ignores only that exact unknown-key diagnostic;
the field/value and `cancel-in-progress: false` are separately asserted by tests
against the [current official workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).
All other actionlint syntax diagnostics remain fatal.
