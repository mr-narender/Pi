# Pi CI and stable releases

Issue: [#13](https://github.com/mr-narender/Pi/issues/13).

`.github/workflows/pi.yml` checks every PR into main and every main push. The
single required-check candidate is **pi-quality**, which remains present for every
event. Format, lint, source/test types and the coverage contract always run.
Workflow, infrastructure, documentation and test-only changes run CI/release
regressions and changed unit/integration tests directly, without an extension
build, VSIX package or Azure login. Helper-only edits receive static checks and
CI/release regressions; the build-dependent optional-module test and extension
host are reserved for the full runtime gate.

Changes under `src/`, `host/`, `media/`, `resources/`, root `package.json`/`package-lock.json`,
`.vscodeignore`, `tsconfig.json` or `scripts/build.mjs` run the full non-clean
build, unit, integration, real Pi, VS Code extension host, host drift and VSIX
inspection. README, CHANGELOG, NOTICE, LICENSE and new infrastructure paths are
validation-only. PR scope uses the checked-out head against its base merge-base;
push scope uses the whole before-to-after range. NUL-delimited Git paths retain
deletions and both sides of renames. An unavailable baseline conservatively runs
the full gate with publication disabled. PRs check
the exact PR head; main checks the exact pushed commit. Fork PR jobs have read-only
permissions and receive no publishing secret. Actions are pinned to full official
commit SHAs. Node **26.11.1**, Pi SDKs **1.2.0 and 1.3.0** and VS Code **1.141.0** are pinned.
The pinned checkout/setup/artifact actions use their native Node 24 runtimes
(Actions Runner 2.327.1 or newer), separately from the project's Node version.
Upload v6 and download v7 retain the immutable named artifact transfer used here.
Azure login alone receives `AZURE_CORE_OUTPUT=json` because its private CLI
version probe parses JSON. The release job and publishing children retain
`AZURE_CORE_OUTPUT=none`; permissions and OIDC scope are unchanged.
The extension and both isolated SDK dependency trees use committed lockfiles.
The isolated SDK locks use npm's nested layout to keep the existing native test
permission boundary limited to that SDK package; it does not grant parent-directory
read access for hoisted dependencies.
The SDK pin is only for testing; product configured-executable/PATH precedence
and opt-in managed installation are unchanged.

For local native qualification, install both test-only fixtures with
`npm ci --prefix .github/pi-sdk --install-strategy=nested` and
`npm ci --prefix .github/pi-sdk-13 --install-strategy=nested`, then run tests with
`PATH="$PWD/.github/pi-sdk-13/node_modules/.bin:$PATH" npm run test:integration`.
CI uses that same 1.3.0 PATH selection; backward-compatibility fixtures explicitly
resolve the separate `.github/pi-sdk` 1.2.0 installation. Neither fixture installs
or replaces the Pi executable used by the extension. The upstream drift check
retains the 1.2.0 source pin; its audited RPC source is identical in 1.3.0.

Stable Git tags and their GitHub release assets track released versions outside
the source tree. Runtime main pushes automatically choose the next patch above
the highest numeric stable tag, including tags reserved for pending drafts.
An explicit higher source version remains a supported release floor. The reviewed
0.2.40 manifest/changelog marked the initial transition; subsequent code PRs need no manual
version bump. CI stamps only the manifest version, lockfile root versions and a
deterministic CHANGELOG entry before tests and packaging. These generated changes
stay in the runner; CI never commits to main or opens automatic version PRs.
The VSIX still contains the exact version required by VS Code and Marketplace.

Runtime paths and production manifest/dependency changes publish automatically.
Package scripts, development dependencies, development-only lock changes and
JSON key reordering do not publish. Workflow, test, documentation and release
automation changes alone do not publish. The explicit 0.2.40 bump was the initial
transition for the already merged Quiet Footer change; current runtime releases
use the stable-tag ledger described above.
A successful main run inspects one stable VSIX, stores its SHA256,
source commit and bundle hashes, and passes that exact artifact to publication.
The release job independently chooses the same version from the stable tag
ledger and recreates only those deterministic metadata edits from a clean source
checkout. Other tracked edits or untracked files fail validation. It validates
the receipt/source/package again without rebuilding,
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
Full checkout history binds the event's **before** commit to main ancestry;
initial/deleted/rewritten main histories and a missing stable-tag baseline fail
and require owner recovery. Rollbacks, prerelease
channels, wrong tag commits or conflicting remote checksums fail closed.
Automatic Azure login/publication runs only when a main push changes a release
input. Runtime changes with an unchanged source version receive the next patch
automatically. Explicit manual **profile** and
**retry-pending-release** operations retain their existing full quality/artifact
proof and main-only authorization route.

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
publisher Contributor access. Child output, credentials, HTTP bodies and assertion values stay
private; failures expose only fixed stages/categories and bounded HTTP/exit numbers.

After partial failures, **rerun failed jobs** on the same workflow run: the
successful quality artifact is reused. Existing verified tags/assets/Marketplace
versions are retained and completed, never overwritten or force-pushed. Prefer
rerunning only failed jobs after partial publication. If all jobs are
rerun, an existing tag for that source reuses its reserved version and retrieves
the original digest-checked VSIX and receipt from the draft or completed release.
Fresh ZIP timestamps never replace original bytes. A crash after VSIX upload can
regenerate only its missing receipt after exact source/archive verification;
missing original VSIX bytes fail closed. The artifact is retained for 30 days;
GitHub release assets remain the recovery source after expiry. Manual retry uses
the latest reserved ancestor version, even after later infrastructure commits.
Rapid main pushes share a
non-cancelling concurrency group with `queue: max`; pending main runs are queued
instead of replaced, and an active publication is not interrupted.
Queued older source runs skip publication when a newer descendant is already
tagged; unrelated tagged source fails ancestry validation instead of reusing a
version. The source/tag match, bundle hashes and original quality proof remain
required during recovery.

Manual **profile** (the default) only reads the ID. **retry-pending-release** accepts
only the latest reserved stable ancestor release, with no SHA/artifact
input. It validates its tag, source ancestry, original successful main **pi-quality**,
unique asset hashes, downloaded receipt/package, original packaged source and
its match to reviewed current main, including current quality bundle hashes and
the deterministically stamped CHANGELOG source. The original VSIX is required;
only its missing receipt may be reconstructed. No other assets are accepted. All sorted archive entry
names and every entry's content hash must equal the validated current quality VSIX;
ZIP container hashes may differ because of metadata such as timestamps.
It runs only reviewed current scripts; old source is inspected without executing
its scripts or hooks. The reserved version must exceed its prior stable tag.
It preserves original receipt bytes and package checksums and uses the existing
idempotent release stages. A completed release is reverified without replacing
its assets. Missing proof or any mismatch fails closed.

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
3. Review and merge. Future reviewed runtime changes publish automatically
   after **pi-quality** succeeds and the identity has Contributor access.
   Version allocation follows the stable tag ledger; infrastructure-only changes
   validate without publication.

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
