# Cross-OS Validation Matrix

Target OS:
- Debian
- Ubuntu
- Windows
- macOS

## Critical Path Checks

1. Local provider endpoint starts and responds.
2. Interactive agent run completes for Python and JavaScript.
3. Coordinator registration/heartbeat/pull/push flow works.
4. Control-plane mode toggle and local-model toggle work.
5. Manifest fetch and signature/checksum verification path works.

## Notes

- CI should run Linux (Debian/Ubuntu) first.
- Windows/macOS validation can be run in nightly matrix jobs.
