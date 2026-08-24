# Changelog

Every release is generated from the Conventional Commits on `main`.

## 1.0.0 — 2026-08-24

Baseline. Timber's backend and frontend previously carried separate, unmanaged
version numbers (`0.1.0` and `0.0.0`) and the repository had no tags. This
establishes a single version for the whole app.

Releases from here are automatic: every push to `main` that passes CI bumps the
version, appends to this file, tags, and publishes. See
[CONTRIBUTING.md](CONTRIBUTING.md) for how the bump is chosen.
