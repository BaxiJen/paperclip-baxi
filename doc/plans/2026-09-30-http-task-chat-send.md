# Task replies on private HTTP installations

Both task composers called `crypto.randomUUID()` before posting a comment.
Browsers expose that method only in secure contexts. On a non-loopback HTTP
origin, the call throws before the API request. The error path restores the
draft, so Send appears to do nothing. This is distinct from the pending pause
query fixed in upstream [PR 13562](https://github.com/paperclipai/paperclip/pull/13562).

Use `browserUuid()` for the two composers, inline image receipt IDs, and the
task page's default comment request ID. It prefers native `randomUUID()` and
otherwise builds UUID v4 from `crypto.getRandomValues()`. It does not use weak
randomness or change request identity, retry, pause, or approval semantics.
See the browser documentation for [randomUUID](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/randomUUID)
and [getRandomValues](https://developer.mozilla.org/en-US/docs/Web/API/Crypto/getRandomValues).

## Verification

- Two composer regressions remove only `randomUUID`, retain Web Crypto, click
  Send, and assert a real callback with a UUID plus a cleared editor. Both fail
  before the fix because the callback is never called.
- The composer and UUID suites pass: 181 tests. The task page suite passes:
  118 tests, including pause-state behavior.
- UI typecheck, production build, token gates, module boundaries, and forbidden
  token checks pass.
- Verify in a browser on a non-loopback private HTTP origin, using a diagnostic
  task assigned to the board user. A reply must persist once after reload and
  must not wake an agent. Keep operational receipts outside the public repo.

This change needs only static UI assets. It requires no database migration,
authentication change, service restart, or network change. Preserve old hashed
assets for open tabs and publish the new index only after all new assets exist.
Rollback restores the previous index and non-hashed files from the UI backup.

Repository-wide typecheck/build/test and hosted CI are not certified by these
targeted checks. Keep the pull request in draft until those gates are complete.
