# Branch protection

The public `main` branch should require:

- pull request review before merge;
- the `public-gate` CI job;
- up-to-date branch state before merge;
- no force pushes or direct pushes from unreviewed local branches.

Release tags must point at a commit that passed the same gate. The npm publish
workflow uses GitHub OIDC and npm provenance; it does not store an npm token in
the repository.
