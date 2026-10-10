# Pi CI and stable releases

Issue: [#13](https://github.com/mr-narender/Pi/issues/13).

`.github/workflows/pi.yml` checks every PR into main and every main push. The
single required-check candidate is **pi-quality**. It covers format, lint, source
types, test types, non-clean build, coverage contract, unit, integration, real Pi,
VS Code extension host and VSIX inspection, plus upstream RPC drift. PRs check
the exact PR head; main checks the exact pushed commit. Fork PR jobs have read-only
permissions and receive no publishing secret. Actions are pinned to full official
commit SHAs. Node **26.11.1**, Pi SDK **1.1.0** and VS Code **1.141.0** are pinned;
both the extension and isolated SDK dependency trees use committed lockfiles.
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
publishes those exact VSIX bytes to Marketplace, then publishes the GitHub draft.
Main pushes with an unchanged version relative to the event's **before** commit
skip publication, including multi-commit/rebase merges. Full checkout history
binds that before commit to main ancestry; initial/deleted/rewritten main histories
fail and require owner recovery. Rollbacks, prerelease
channels, wrong tag commits or conflicting remote checksums fail closed.

After partial failures, **rerun failed jobs** on the same workflow run: the
successful quality artifact is reused. Existing verified tags/assets/Marketplace
versions are retained and completed, never overwritten or force-pushed. Do not
rerun every job after a partial publication: ZIP timestamps can produce different
bytes even at the same commit. The artifact is retained for 30 days; after expiry,
recover the original package from the verified GitHub draft rather than rebuild
and silently overwrite a published version. Rapid main pushes share a
non-cancelling concurrency group with `queue: max`; pending main runs are queued
instead of replaced, and an active publication is not interrupted.

## Owner setup before merge

1. Add repository Actions secret **VSCE_PAT**, using the existing Azure DevOps
   Marketplace Manage PAT from Bitwarden **azure_token**. Enter the raw token
   value only, without the `AZURE_TOKEN=` assignment. GitHub's built-in
   `GITHUB_TOKEN` handles GitHub tags/releases; no GitHub PAT is needed.
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
3. Review and merge this PR. Its new version **0.2.28** publishes automatically
   only after the merged commit's quality job succeeds. A missing VSCE_PAT fails
   clearly and leaves the package unpublished; add the secret then rerun failed jobs.

Branch settings and secret configuration are owner operations, not activated by
this source PR. Registry policy must retain local gates until required status,
workflow integrity and runner trust are verified; the workflow alone proves none
of those server controls.

Node availability is verified against its [official 26.11.1 release](https://nodejs.org/en/blog/release/v26.11.1).
Microsoft announces global Azure DevOps PAT retirement on **December 1, 2026**:
prepare reviewed Microsoft Entra ID/OIDC publishing before that date using the
[official publishing guidance](https://code.visualstudio.com/api/working-with-extensions/publishing-extension).
This PR does not create identity/cloud infrastructure or change credentials.

The locally installed official actionlint **1.7.12** predates GitHub's supported
`queue: max` field. Validation ignores only that exact unknown-key diagnostic;
the field/value and `cancel-in-progress: false` are separately asserted by tests
against the [current official workflow syntax](https://docs.github.com/en/actions/reference/workflows-and-actions/workflow-syntax).
All other actionlint syntax diagnostics remain fatal.
