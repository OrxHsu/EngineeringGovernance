# Global Workflow Implementation Plan Map

The approved design is implemented in dependency order:

1. [Governance core](2026-07-29-governance-core-implementation.md)
2. [Agent adapters](2026-07-29-agent-adapters-implementation.md)
3. [Existing project adoption](2026-07-29-project-adoption-implementation.md)

## Design coverage

| Design area | Owning plan |
|---|---|
| Authority, canonical policy, versioning | Governance core Tasks 1-3, 9 |
| Risk levels and exceptions | Governance core Task 3 |
| Ownership and state machine | Governance core Task 4 and Task 7 |
| Task/evidence/review artifacts | Governance core Tasks 2, 5, 7 |
| Implementation/evidence commit identity | Governance core Task 5 |
| Safe project mutation | Governance core Task 6 |
| CLI and templates | Governance core Task 7 |
| Health metrics | Governance core Task 8 |
| Adversarial and package verification | Governance core Task 9 |
| Codex/Qoder/Cursor/Claude adapters | Agent adapters Tasks 1-3 |
| Codex delivery-sop Skill | Agent adapters Task 4 |
| Global installation | Agent adapters Task 5; adoption Task 2 |
| Portable CI/project gate | Agent adapters Task 6 |
| ProjTrav and NoMe integration | Existing project adoption Tasks 1-4 |
| R1/R2/R3 pilots and release | Existing project adoption Task 5 |

The plans do not authorize pushes, publishing, deployments, migrations,
production writes, Simulator/device use, or destructive Git operations.
