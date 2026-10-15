# Security policy

Relay Desk stores private communications and connector credentials locally, so we take security reports seriously.

## Reporting a vulnerability

**Do not open a public issue for security problems.** Instead, use GitHub's [private vulnerability reporting](https://github.com/Ai4Innov/relaydesk/security/advisories/new) for this repository.

Please include:

- the affected version or commit;
- the component (for example main process, renderer, browser companion, Apps Script relay, or a connector);
- reproduction steps or a proof of concept using **synthetic** data only;
- the impact you expect, such as credential disclosure, consent bypass, unreviewed writes, or prompt-injection-triggered actions.

We aim to acknowledge reports within 5 business days and to agree on a disclosure timeline with you. Please give us reasonable time to release a fix before any public disclosure.

## Scope

In scope:

- exposure of tokens, the archive key or archive content;
- bypassing account, source or AI consent checks;
- actions taken without the required user confirmation, such as sending, drafting, calendar writes, shell or file writes;
- prompt injection from message, attachment or web content that triggers tools or widens access;
- IPC, preload or renderer isolation escapes;
- browser-companion pairing or bridge authentication weaknesses;
- Apps Script relay token handling.

Out of scope:

- issues that require malware already running as the signed-in Windows user. Local encryption cannot protect against that, as documented.
- vulnerabilities in GitHub Copilot, Google, Microsoft, Slack or WhatsApp services themselves. Report those to the vendor.

## Supported versions

Security fixes are applied to the latest release on the default branch.

## Handling your own secrets

If you accidentally commit a credential (an OAuth client secret, relay token or Slack token), revoke or rotate it with the provider immediately. Removing it from Git history is not enough.
