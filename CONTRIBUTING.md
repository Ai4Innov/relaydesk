# Contributing to Relay Desk

Thanks for helping improve Relay Desk. This guide explains how to set up the project, what we expect from changes, and the safety rules every contribution must respect.

## Ground rules

Relay Desk handles private professional communications, so a few product rules are non-negotiable. Pull requests that weaken them will not be merged.

- **Never send on the user's behalf.** No email sending, Slack posting, mailbox archiving/deletion or calendar deletion. Native drafts and calendar changes require an explicit, reviewed user action.
- **Consent first.** Account access, source selection and AI sharing are separate opt-ins and must be re-checked before every disclosure or write.
- **No credential scraping.** Do not read browser cookies, passwords or another app's tokens. Connectors use official APIs, user-owned relays or the visible paired browser.
- **Secrets stay local.** Tokens live in the encrypted vault and are never returned to the renderer, logged, or placed in prompts.
- **Untrusted content stays untrusted.** Message, attachment and web text must never be able to trigger tools, widen permissions or approve actions.

## Development setup

Requirements: Windows x64, macOS or Linux x64; official [Node.js 24](https://nodejs.org/) (`^24.13.0`; the MSYS/MinGW Node build is not supported on Windows); and Git. Linux also needs a Secret Service keyring (GNOME Keyring or KWallet). See [Getting started](docs/getting-started.md) for per-OS prerequisites.

CI runs typecheck, tests and packaging on Windows, macOS and Ubuntu. Keep code portable: use `host.path` and `insidePath` from `src/main/platform.ts` for filesystem paths instead of hard-coding `win32` or `/` separators, and add a case to `tests/platform.test.ts` when behaviour differs by OS.

If you change the UI, refresh the docs screenshots with `npm run package && npm run screenshots`.

```powershell
npm install
npm run doctor
npm run typecheck
npm start
```

### Tests

```powershell
npx vitest run tests/service.test.ts            # one file
npx vitest run tests/chat*.test.ts              # a group
npm test                                        # everything (CI runs this in batches)
```

- Use synthetic fixtures. **Never commit real messages, addresses, tokens or attachments.**
- Browser UI tests (`*-ui-browser.test.tsx`) drive headless Edge through Playwright and only run when `RELAY_UI_BROWSER_TEST=1` is set.
- After `npm run package`, the database module may have been rebuilt for Electron. Run `npm rebuild better-sqlite3-multiple-ciphers` before running Node-based tests again.

## Making a change

1. Open an issue first for larger features or behavior changes, so we can agree on scope.
2. Create a focused branch. Keep unrelated refactors out of the same pull request.
3. Add or update tests for any changed behavior, especially permission, consent and write paths.
4. Run `npm run typecheck` and the relevant tests.
5. Update `README.md` or `docs/` when user-visible behavior changes.
6. Open a pull request using the template and describe how you validated the change.

### Code layout and style

- `src/main/service.ts` orchestrates jobs and dispatches commands. Put new domain command handlers in `src/main/commands/`, accessing service state through `CommandContext`.
- Validate every IPC payload with the Zod schemas in `src/main/ipc/schema.ts` and `src/shared`.
- Use TypeScript strict mode, and prefer small pure helpers over adding to large files.
- Only comment where the intent is not obvious.

## Licensing of contributions

By submitting a contribution, you agree that it is licensed under the project's [Apache License 2.0](LICENSE), as described in Section 5 of that license. Only submit code you have the right to contribute.
