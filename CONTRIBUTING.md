# Contributing to Timber

## Versioning

Timber has **one version number** for the whole app. The backend and the
frontend deploy together and a browser only ever talks to one relay, so a shared
number is what makes a bug report answerable: "1.4.2" identifies exactly one
build of both halves.

That number lives in [`VERSION`](VERSION) at the repository root. Everything else
is a copy of it, written only by [`scripts/version.mjs`](scripts/version.mjs):

| File | Why it has to stay in step |
| --- | --- |
| `backend/Cargo.toml` | compiled into the binary as `CARGO_PKG_VERSION` |
| `backend/Cargo.lock` | `cargo build --locked` fails if it disagrees |
| `frontend/package.json` | injected into the bundle as `__APP_VERSION__` |
| `frontend/package-lock.json` | `npm ci` fails if it disagrees |

**Never edit these by hand.** Edit `VERSION` only if you are deliberately
jumping the number (for example, declaring 2.0.0 ahead of the commits that would
have earned it); the next release picks up from whatever it says.

### How the next version is chosen

Every push to `main` that passes CI produces a release. The size of the bump is
derived from the [Conventional Commits](https://www.conventionalcommits.org)
since the last tag:

| Commit | Bump | Example |
| --- | --- | --- |
| `feat!:` or a `BREAKING CHANGE:` footer | major | `1.4.2` → `2.0.0` |
| `feat:` | minor | `1.4.2` → `1.5.0` |
| `fix:`, `perf:`, `docs:`, anything else | patch | `1.4.2` → `1.4.3` |
| no recognised prefix | patch | `1.4.2` → `1.4.3` |

That last row is deliberate. An unlabelled commit still moves the patch digit,
so **no two builds can ever claim to be the same version** — which is the whole
point of the exercise. The commit is still listed in the changelog, under
"Other", rather than being silently dropped.

### Writing a commit

```
<type>(<optional scope>): <description>

<optional body>

<optional BREAKING CHANGE: footer>
```

Types: `feat`, `fix`, `perf`, `refactor`, `docs`, `test`, `build`, `ci`,
`chore`, `style`, `revert`.

```
feat(chat): three-state delivery receipts
fix(people): keep search results visible under the grain overlay
refactor(crypto): fold envelope opening into one path
feat(api)!: drop support for v1 envelopes
```

CI checks this on **pull requests only**, where a message can still be reworded
(`git rebase -i`). It does not gate `main`: a badly worded commit that reaches
`main` still releases, as a patch. The check is there to keep the changelog
readable, not to block a deploy.

Run it locally before opening a PR:

```sh
node scripts/lint-commits.mjs origin/main HEAD
```

### What a release does

On a green push to `main`, the `release` job:

1. bumps `VERSION` and every manifest above,
2. prepends a section to [`CHANGELOG.md`](CHANGELOG.md),
3. commits as `chore(release): X.Y.Z [skip ci]`,
4. tags `vX.Y.Z` and pushes,
5. publishes a GitHub release with that changelog section as its notes.

`[skip ci]` stops the release commit re-entering the workflow. Render is
**not** skipped: the release commit is the one carrying the new version, so it
is the one that should end up running in production.

Preview what the next release would be, without touching anything:

```sh
node scripts/version.mjs dry-run
```

### The first run

On a repository with no tags, the release job does not invent a release from
history written before this convention existed. It tags the current commit at
whatever `VERSION` says and stops. The push after that is the first real
release.

### Seeing the version at runtime

- **Relay:** `GET /health` returns `{"status":"ok","version":"1.4.2"}`.
- **App:** Settings → About shows both this device's build and the relay's.

They can legitimately differ for a while: an installed PWA serves a cached shell
until the service worker picks up the new one.
