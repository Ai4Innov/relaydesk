## Summary

<!-- What does this change do and why? Link the related issue (e.g. Closes #123). -->

## Validation

<!-- Commands you ran and what you checked manually. -->

- [ ] `npm run typecheck`
- [ ] Relevant tests (`npx vitest run tests/...` or `npm run test:ci`)
- [ ] Browser UI tests with `RELAY_UI_BROWSER_TEST=1` (if UI changed)

## Safety checklist

- [ ] No email sending, Slack posting, or mailbox or calendar deletion was introduced.
- [ ] Writes still require an explicit, reviewed user action.
- [ ] Account, source and AI consent are re-checked before disclosure or writes.
- [ ] No secrets, tokens or real personal data in code, tests, fixtures or logs.
- [ ] Docs updated for user-visible changes.
