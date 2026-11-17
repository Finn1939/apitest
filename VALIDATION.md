# Validation

`npm test`: 132 tests passed, 0 failures, 0 skipped. Includes database-dependent tests and 31 action/authentication tests covering validation, unsupported operations, explicit addressing, authorization, hierarchy, role creation/assignment, permission escalation, partial failures, ban audit reasons, mention suppression, approval, cancellation, expiry, permission revocation, chat fallback, disabled mode and dedicated pin permissions.

`node --check src/index.js` and `node --check src/actions.js` passed. ZIP integrity checked after packaging.

Test runtime: Node.js 24.22.1, discord.js 14.28.0 from the repository lockfile. Native SQLite binding rebuilt locally for testing; it is not bundled. Node.js 22 remains the recommended setup version for this dependency set. Install dependencies on the deployment host with npm ci.

Discord calls in the new tests are mocks. No bot login, real moderation action, live provider action-planning call, or complete live end-to-end Discord test was performed. These tests do not establish that every Discord server feature/permission configuration works. Test in a private server first.

Direct Commands Edition regression coverage additionally verifies exact user-ID allowlists, blank allowlists denying commands, public chat fallback, immediate role assignment/ban/rename without components, delete-only approval, mixed-plan cancellation, no post-command cooldown, and memory-deletion requester approval. Personality changes were reviewed but not live-tested with a model; subjective fidelity is not guaranteed.
