// Account creation and sign-in.
//
// Both are the same three steps: ask the server for a nonce, sign it with the key
// derived from the recovery phrase, and exchange the signature for a session token.
// No password is ever chosen, transmitted, or stored.

import api, { WAKE_TIMEOUT_MS, apiError, setSessionRefresher, setToken } from "./api.js";
import { base64ToBytes } from "../crypto/bytes.js";
import { publicIdentity, signChallenge, signKexKeyBinding } from "../crypto/identity.js";
import { currentIdentity, isUnlocked } from "../crypto/session.js";

async function challenge(identity) {
  const pub = publicIdentity(identity);
  const { data } = await api.post(
    "/auth/challenge",
    { identity_pk: pub.identity_pk },
    // First contact: this is the request that pays for a cold start.
    { timeout: WAKE_TIMEOUT_MS },
  );
  return { pub, nonce: data.nonce, registered: data.registered };
}

/** Does this phrase already have an account? Decides sign-in vs claim-a-username. */
export async function hasAccount(identity) {
  try {
    return (await challenge(identity)).registered;
  } catch (error) {
    throw apiError(error, "Could not reach Timber.");
  }
}

export async function signIn(identity) {
  try {
    const { pub, nonce } = await challenge(identity);
    const { data } = await api.post("/auth/login", {
      identity_pk: pub.identity_pk,
      signature: signChallenge(identity, base64ToBytes(nonce)),
    }, { timeout: WAKE_TIMEOUT_MS });
    setToken(data.token);
    // Accounts created before key attestation are repaired only with a
    // signature made by the recovery phrase; the server cannot choose a key.
    await api.post("/api/users/me/kex-key", {
      kex_pk: pub.kex_pk,
      kex_key_signature: signKexKeyBinding(identity),
    });
    return data;
  } catch (error) {
    throw apiError(error, "Could not sign in.");
  }
}

export async function register(identity, username, inviteCode = null) {
  try {
    const { pub, nonce } = await challenge(identity);
    const { data } = await api.post("/auth/register", {
      identity_pk: pub.identity_pk,
      kex_pk: pub.kex_pk,
      kex_key_signature: signKexKeyBinding(identity),
      username,
      signature: signChallenge(identity, base64ToBytes(nonce)),
      invite_code: inviteCode,
    }, { timeout: WAKE_TIMEOUT_MS });
    setToken(data.token);
    return data;
  } catch (error) {
    throw apiError(error, "Could not create your account.");
  }
}

/**
 * Get a session for an identity, creating the account only if asked to.
 * Used on unlock, where the account is known to exist already.
 */
export async function resumeSession(identity) {
  return signIn(identity);
}

setSessionRefresher(async () => {
  if (!isUnlocked()) throw new Error("The app is locked.");
  await signIn(currentIdentity());
});
