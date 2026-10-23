import { deriveIdentity } from "../crypto/identity.js";
import { finishRegistration, stageRegistration } from "../crypto/registration.js";
import { hasAccount, register, registerAnonymous, signIn } from "./auth.js";

let inFlight = null;

async function complete(draft) {
  // Storage failure stops here, before a request can create a server account.
  const pending = await stageRegistration(draft);
  const identity = deriveIdentity(pending.mnemonic);
  let account;
  let created = false;
  if (await hasAccount(identity)) {
    account = await signIn(identity);
  } else {
    try {
      account = await (pending.isAnonymous ? registerAnonymous : register)(identity, pending.username, pending.inviteCode);
      created = true;
    } catch (original) {
      // The server may have committed before the response was lost, or another
      // tab may have completed the same pending signup. Never mint new keys.
      const exists = await hasAccount(identity).catch(() => false);
      if (!exists) throw original;
      account = await signIn(identity);
    }
  }
  await finishRegistration(pending, account);
  try {
    // Best effort: a browser may refuse persistence or not implement this API.
    void globalThis.navigator?.storage?.persist?.().catch(() => {});
  } catch { /* optional browser permission */ }
  return { mnemonic: pending.mnemonic, account, created };
}

export function completeRegistration(draft) {
  if (!inFlight) {
    const run = () => complete(draft);
    inFlight = (globalThis.navigator?.locks
      ? navigator.locks.request("timber-registration", run)
      : run()).finally(() => { inFlight = null; });
  }
  return inFlight;
}
