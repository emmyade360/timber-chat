# Anonymous signup

Anonymous accounts use a chosen alias without an email address or phone number.
This is account privacy, not network anonymity. They use the existing signed-key
authentication and key-derived UUID. Possession of a UUID does not grant access.

## User experience

- **Continue anonymously** opens a username form with the device-loss notice
  visible before submission. Usernames retain their existing permanent rules.
- The account opens without a PIN or recovery-phrase confirmation. Returning on
  the same browser reopens the same device keys.
- Automatic backup reminders and optional usage analytics are disabled. Manual
  security, backup, and device-transfer controls remain available.
- Username search, accepted friendships, and encrypted messaging work normally.
  Public Explore visibility remains explicitly opt-in.

## Interrupted signup

Both signup paths seal the phrase, username, mode, and invitation in IndexedDB
before requesting registration. One read/write transaction chooses the pending
identity for the browser origin; another tab must adopt those keys. A conflicting
username can be edited without replacing the identity.

Retries check whether the identity already exists and sign in with its keys if
it does. The server's username is authoritative. A successful response promotes
the pending keys into the active vault and removes the pending record in one
transaction. The app opens only after that transaction succeeds. Failure retains
the pending record, including when the server already created the account.

The pending record has its own discriminator and cannot be used as a session
resume token. Both signup paths refuse to replace an existing active identity.
Persistent browser storage is requested where available, with denial nonfatal;
explicitly clearing browser data can still remove access.

## Privacy gate

`is_anonymous` is returned by registration, login, and the authenticated owner's
profile. Public profiles and search omit it. Vault updates, PIN wrapping, and
device transfers preserve the flag.

Optional analytics require an active session whose identity matches a known
standard account. Unknown state and onboarding stay disabled. The SDK's live
`beforeSend` callback also drops events after logout or account changes if a
script from an earlier standard session remains loaded.

## Local verification

Automated coverage includes competing pending identities, duplicate submissions,
username conflicts, invitations, lost responses, storage failures before and
after account creation, authoritative usernames, PIN wrapping, mode switching,
and analytics script suppression. Backend database tests apply real migrations
to the database specified by `TEST_DATABASE_URL`; use a disposable database.

A browser check against a local backend and disposable TLS PostgreSQL database
verified signup, reload, clean browser shutdown/restart, unchanged UUID, username
search without private metadata, accepted friendship, and a message decrypted by
a separate standard account. No optional analytics requests were observed for
the anonymous account. A UUID-only login payload was rejected.

Screens captured from that local app:

- [Welcome](frontend/.stitch/timbachat-anonymous-welcome.png)
- [Anonymous username](frontend/.stitch/timbachat-anonymous-signup.png)
- [Owner profile](frontend/.stitch/timbachat-anonymous-profile.png)
- [Encrypted conversation](frontend/.stitch/timbachat-anonymous-chat.png)

## Release order

Deploy backend commit `b2df56b` or a later commit containing migration 0011 and
`POST /auth/register/anonymous` before publishing the frontend to production.
Startup applies the additive migration. Confirm `/health` and that an empty JSON
POST to the new route returns a validation error rather than a missing route.
The deployment details are in [DEPLOYMENT.md](DEPLOYMENT.md).

## References

- [RFC 9562 security considerations](https://www.rfc-editor.org/rfc/rfc9562.html#section-8)
- [Browser persistent storage](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/persist)
- [Vercel Analytics beforeSend](https://vercel.com/docs/analytics/package#beforesend)
