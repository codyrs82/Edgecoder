# Security Policy

## Reporting a vulnerability

Please **don't** open a public issue, discussion or PR for a security problem.

Report it privately through GitHub: **Security → Report a vulnerability** on this repository ([private vulnerability reporting](https://github.com/codyrs82/Edgecoder/security/advisories/new)).
If that option isn't available, email **support@edgecoder.io** with `SECURITY` in the subject, and leave the details out of the first message if you prefer; we'll reply with a private channel.

Please include:

- the affected component (portal, coordinator, inference, control plane, worker, desktop, iOS, IDE extension) and the version or commit
- steps to reproduce, or a proof of concept
- the impact you expect, and any suggested fix

## What to expect

- An acknowledgement within 3 business days.
- An initial assessment and severity within 10 business days.
- Updates as the fix goes in, and credit in the advisory if you'd like it.
- Please give us a reasonable time to ship a fix before you disclose publicly. We aim for 90 days or less.

## Supported versions

Only the latest release and `main` get security fixes.

## Scope

In scope: this repository's code, its default configuration, and the published desktop, iOS and IDE builds.
Out of scope: denial of service through volume alone, issues in third-party dependencies without an EdgeCoder-specific impact (report those upstream), and social engineering.
