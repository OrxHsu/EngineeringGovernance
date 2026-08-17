# Security Policy

## Supported Versions

Security fixes are prepared for the latest `2.1.x` release line. Older beta,
release-candidate, and unreleased snapshots are not supported security targets.

## Reporting A Vulnerability

Do not open a public issue for a suspected vulnerability. Once this repository
is public, use GitHub private vulnerability reporting or a private security
advisory for `OrxHsu/EngineeringGovernance`. Include the affected version,
reproduction steps, impact, and any suggested mitigation. Do not include
credentials, private keys, or user data in a report.

The project may not provide a guaranteed response time. Reports are reviewed
before public disclosure and fixes are released with a versioned changelog.

## Scope

The governance CLI is a local workflow tool. It does not authenticate human or
AI identity, replace repository permissions, or authorize production,
deployment, billing, or other external operations. Report claims that the CLI
accepts forged evidence, bypasses a frozen authorization, executes an
unapproved command, or writes outside its managed local paths.
