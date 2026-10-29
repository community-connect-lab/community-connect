# Controlled AWS deployment

The **Test** workflow runs Node 22 checks on pushes and pull requests. Publishing
source does not restart AWS. **Deploy AWS** is manual and can run only from `main`.

Before deployment, save working notes and disconnect every desk. The restart
interrupts calls and invalidates in-memory call and case receipts. Select
**Actions → Deploy AWS → Run workflow**, keep branch **main**, and check
`confirm_restart`. Its default is false, which runs tests without deploying.

Leave `commit` blank to deploy the main commit used to launch the workflow. For a
rollback, supply the full 40-character SHA of a known good ancestor of `main`.
The selected commit is tested again before AWS authentication. Deployment controls
always come from the main workflow commit, rather than the rollback commit.

## Required repository setup

The `aws-production` environment must restrict deployment branches to `main`.
Its GitHub OIDC trust must bind this environment, the immutable repository owner
and repository identifiers, and audience `sts.amazonaws.com`. Only the deploy job
has `id-token: write`; all jobs have `contents: read`. No backend secret belongs
in GitHub. Existing credentials remain in `/etc/community-connect/backend.env`.

Set these environment or repository variables:

| Variable | Value |
| --- | --- |
| `AWS_DEPLOY_ROLE_ARN` | Restricted deployment role ARN provisioned by the account owner |
| `AWS_DEPLOY_INSTANCE_ID` | The enrolled SSM managed node for the existing AWS VM |
| `AWS_DEPLOY_REGION` | `eu-west-2` |
| `AWS_DEPLOY_BUCKET` | `community-connect-deploy-814462560346-eu-west-2` |

The last two values have matching workflow defaults. The client rejects other
regions and buckets. The role needs conditional object uploads and reads only
under `releases/`, plus send/get access for **CommunityConnectDeploy** on
that one managed node. It cannot run arbitrary shell commands through another
SSM document. The account owner installs the server helper and restricted SSM
document separately. GitHub does not replace that helper or backend configuration.

## What a deployment verifies

`package-release.py` reads exactly 26 runtime files from Git objects at the tested
commit. It excludes working files, `.env`, Git history, private documents,
recordings and `node_modules`. A deterministic gzip/tar contains those files and
`release.json`: schema 1, the commit, and a SHA-256 map for the exact file set.

`deploy-aws.py` validates the archive, uploads it to
`releases/<commit>/app.tar.gz` with SHA-256 metadata, and refuses to overwrite a
different existing release. It sends one **CommunityConnectDeploy** command with
only `Commit` and `Digest` parameters. The host validates the digest, stages the
release, installs pinned dependencies without npm lifecycle scripts, refuses a
busy desk, switches the app and checks health. A failed host check restores the
previous release. See the adjacent server helper and SSM document for details.

The client polls the `DownloadRelease` and `DeployVerifiedRelease` SSM steps
individually, sharing one 15-minute deadline. A failed download stops verification
before the deploy step. After both steps succeed it checks
public HTTPS with normal certificate verification, validates `/health`, and
compares `/agent` and `/agent/case-desk.mjs` with the packaged file hashes. The
GitHub run summary records the selected commit, run URL, SSM command and server
URL. It does not repeat live Meta requests or claim that these checks prove a call.

## Failure and rollback

Never blindly rerun a deployment after a timeout or uncertain send. The command
may have started even if its response was lost. The client prints and saves the
SSM command ID as soon as it receives it and includes it in the run summary.
After the 15-minute timeout the client stops polling. It does not cancel the
command, which may still be running. Inspect that command and the host's current
release before retrying. No command or shell/provider output is copied to logs.

For an application rollback, run the same workflow from `main` with a previous
known good main-history SHA and `confirm_restart` enabled. It follows the same
tests, busy checks and verification. The workflow leaves the WhatsApp callback
and backend credentials in place. A public verification failure after a successful
SSM command requires inspection; it does not automatically dispatch a second command.

Offline deployment-control checks:

```sh
python3 -m unittest discover -s scripts/deploy/tests -v
python3 -m unittest discover -s scripts/deploy -p 'test_deploy_release.py' -v
```

Official actions are pinned to full release commit SHAs, checked 29 October 2026:

- [checkout v7.0.1](https://github.com/actions/checkout/releases/tag/v7.0.1)
- [setup-node v7.1.0](https://github.com/actions/setup-node/releases/tag/v7.1.0)
- [configure-aws-credentials v6.3.0](https://github.com/aws-actions/configure-aws-credentials/releases/tag/v6.3.0)
