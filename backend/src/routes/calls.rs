//! Private, short-lived call wake-up support.
//!
//! The relay only stores encrypted SDP/ICE envelopes for a minute so an installed
//! PWA can open after a push. Media and readable chat content never enter here.

use std::{env, time::Duration};

use axum::{Json, extract::Extension, extract::State};
use base64::{Engine, engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD}};
use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use tracing::warn;
use uuid::Uuid;
use web_push::{ContentEncoding, IsahcWebPushClient, SubscriptionInfo, Urgency, VapidSignatureBuilder, WebPushClient, WebPushError, WebPushMessageBuilder};

use crate::{AppState, auth::AuthUser, error::ApiError};

/// How long an unanswered call stays pickup-able.
///
/// Generous on purpose: a push wakes a device whose vault is locked, and the
/// recipient has to unlock it before the call can be answered. At 60s the call
/// routinely expired during the PIN derivation and the walk to the phone.
pub const CALL_TTL_SECONDS: i64 = 150;

#[derive(Clone)]
pub struct SealedCallSignal {
    pub version: i16,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
}

#[derive(Deserialize)]
pub struct PushSubscriptionInput {
    pub endpoint: String,
    pub keys: PushKeys,
}

#[derive(Deserialize)]
pub struct PushKeys {
    pub p256dh: String,
    pub auth: String,
}

#[derive(Deserialize)]
pub struct DeletePushSubscriptionInput {
    pub endpoint: String,
}

#[derive(FromRow)]
struct PushSubscriptionRow {
    endpoint: String,
    p256dh: String,
    auth: String,
}

#[derive(FromRow)]
struct PendingCallRow {
    call_id: Uuid,
    conversation_id: Uuid,
    caller_id: Uuid,
    media: String,
    expires_at: DateTime<Utc>,
    username: String,
}

#[derive(FromRow)]
struct PendingSignalRow {
    sender_id: Uuid,
    kind: String,
    envelope_version: i16,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
}

#[derive(Serialize)]
pub struct PendingCall {
    call_id: Uuid,
    conversation_id: Uuid,
    from: Uuid,
    username: String,
    media: String,
    expires_at: DateTime<Utc>,
    signals: Vec<PendingSignal>,
}

#[derive(Serialize)]
pub struct PendingSignal {
    from: Uuid,
    kind: String,
    envelope_version: i16,
    nonce: String,
    ciphertext: String,
}

fn valid_push_subscription(input: &PushSubscriptionInput) -> bool {
    let endpoint = reqwest::Url::parse(&input.endpoint);
    endpoint.is_ok_and(|url| {
        let host = url.host_str().unwrap_or_default();
        // Push endpoints are provider infrastructure, never arbitrary user URLs.
        // This avoids turning subscription registration into an HTTPS SSRF primitive.
        let approved_host = matches!(host, "fcm.googleapis.com" | "updates.push.services.mozilla.com" | "push.services.mozilla.com" | "web.push.apple.com")
            || host.ends_with(".push.apple.com")
            || host.ends_with(".notify.windows.com");
        url.scheme() == "https" && approved_host && url.username().is_empty() && url.password().is_none()
    }) && input.endpoint.len() <= 2048
        && input.keys.p256dh.len() <= 512
        && input.keys.auth.len() <= 256
}

pub async fn upsert_push_subscription(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<PushSubscriptionInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !valid_push_subscription(&input) {
        return Err(ApiError::BadRequest("That browser notification subscription is invalid.".into()));
    }
    if !state.limits.allow("push-subscription", user.id, 8, Duration::from_secs(60 * 60)).await {
        return Err(ApiError::TooManyRequests("Too many notification changes. Try again later.".into()));
    }
    sqlx::query(
        "INSERT INTO push_subscriptions (endpoint, user_id, p256dh, auth) VALUES ($1, $2, $3, $4) \
         ON CONFLICT (endpoint) DO UPDATE SET user_id = EXCLUDED.user_id, p256dh = EXCLUDED.p256dh, auth = EXCLUDED.auth, updated_at = NOW()",
    )
    .bind(input.endpoint)
    .bind(user.id)
    .bind(input.keys.p256dh)
    .bind(input.keys.auth)
    .execute(&state.db)
    .await?;
    Ok(Json(serde_json::json!({ "saved": true })))
}

pub async fn delete_push_subscription(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<DeletePushSubscriptionInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = $1 AND user_id = $2")
        .bind(input.endpoint)
        .bind(user.id)
        .execute(&state.db)
        .await?;
    Ok(Json(serde_json::json!({ "deleted": true })))
}

pub async fn get_pending_calls(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<PendingCall>>, ApiError> {
    if !state.limits.allow("pending-calls", user.id, 20, Duration::from_secs(60)).await {
        return Err(ApiError::TooManyRequests("Too many call checks. Try again shortly.".into()));
    }
    cleanup_expired_calls(&state).await;
    let calls = sqlx::query_as::<_, PendingCallRow>(
        "SELECT c.call_id, c.conversation_id, c.caller_id, c.media, c.expires_at, p.username \
         FROM pending_calls c JOIN profiles p ON p.id = c.caller_id \
         WHERE c.recipient_id = $1 AND c.expires_at > NOW() ORDER BY c.created_at ASC",
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;
    let mut output = Vec::with_capacity(calls.len());
    for call in calls {
        let signals = sqlx::query_as::<_, PendingSignalRow>(
            "SELECT sender_id, kind, envelope_version, nonce, ciphertext FROM pending_call_signals WHERE call_id = $1 ORDER BY id ASC",
        )
        .bind(call.call_id)
        .fetch_all(&state.db)
        .await?
        .into_iter()
        .map(|signal| PendingSignal {
            from: signal.sender_id,
            kind: signal.kind,
            envelope_version: signal.envelope_version,
            nonce: BASE64.encode(signal.nonce),
            ciphertext: BASE64.encode(signal.ciphertext),
        })
        .collect();
        output.push(PendingCall { call_id: call.call_id, conversation_id: call.conversation_id, from: call.caller_id, username: call.username, media: call.media, expires_at: call.expires_at, signals });
    }
    Ok(Json(output))
}

pub async fn start_pending_call(state: &AppState, call_id: Uuid, conversation_id: Uuid, caller: Uuid, recipient: Uuid, media: &str, signal: SealedCallSignal) -> Result<(), ApiError> {
    let expires_at = Utc::now() + chrono::Duration::seconds(CALL_TTL_SECONDS);
    let mut tx = state.db.begin().await?;
    sqlx::query("INSERT INTO pending_calls (call_id, conversation_id, caller_id, recipient_id, media, expires_at) VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (call_id) DO NOTHING")
        .bind(call_id).bind(conversation_id).bind(caller).bind(recipient).bind(media).bind(expires_at)
        .execute(&mut *tx).await?;
    sqlx::query("INSERT INTO pending_call_signals (call_id, sender_id, kind, envelope_version, nonce, ciphertext) VALUES ($1, $2, 'offer', $3, $4, $5) ON CONFLICT DO NOTHING")
        .bind(call_id).bind(caller).bind(signal.version).bind(signal.nonce).bind(signal.ciphertext)
        .execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(())
}

pub async fn store_pending_signal(state: &AppState, call_id: Uuid, conversation_id: Uuid, sender: Uuid, kind: &str, signal: SealedCallSignal) -> Result<(), ApiError> {
    // The SELECT list writes the row; the WHERE only authorises it. They use
    // different parameters, so the columns are $1, $3..$7 while the guard reuses
    // $1..$3. Getting this wrong made every answer and ICE candidate fail to
    // store, and the `?` below then returned before the relay could publish
    // them -- so no call could ever connect.
    let inserted = sqlx::query(
        "INSERT INTO pending_call_signals (call_id, sender_id, kind, envelope_version, nonce, ciphertext) \
         SELECT $1, $3, $4, $5, $6, $7 WHERE EXISTS (SELECT 1 FROM pending_calls WHERE call_id = $1 AND conversation_id = $2 AND expires_at > NOW() AND (caller_id = $3 OR recipient_id = $3))",
    )
    .bind(call_id).bind(conversation_id).bind(sender).bind(kind).bind(signal.version).bind(signal.nonce).bind(signal.ciphertext)
    .execute(&state.db).await?;
    if inserted.rows_affected() == 0 { return Err(ApiError::NotFound("That call is no longer available.".into())); }
    Ok(())
}

pub async fn require_pending_recipient(state: &AppState, call_id: Uuid, conversation_id: Uuid, user_id: Uuid) -> Result<(), ApiError> {
    let accepted: bool = sqlx::query_scalar(
        "SELECT EXISTS (SELECT 1 FROM pending_calls WHERE call_id = $1 AND conversation_id = $2 AND recipient_id = $3 AND expires_at > NOW())",
    )
    .bind(call_id).bind(conversation_id).bind(user_id).fetch_one(&state.db).await?;
    if !accepted { return Err(ApiError::NotFound("That call is no longer available.".into())); }
    Ok(())
}

pub async fn delete_pending_call(state: &AppState, call_id: Uuid) {
    if let Err(error) = sqlx::query("DELETE FROM pending_calls WHERE call_id = $1").bind(call_id).execute(&state.db).await {
        warn!(%error, "Could not remove pending call");
    }
}

pub async fn cleanup_expired_calls(state: &AppState) {
    if let Err(error) = sqlx::query("DELETE FROM pending_calls WHERE expires_at <= NOW()").execute(&state.db).await {
        warn!(%error, "Could not remove expired calls");
    }
}

/// Whether background alerts can be sent at all.
///
/// Checked once at startup because the failure is otherwise invisible: without
/// these variables every push is skipped silently, users get nothing when the
/// app is closed, and there is no log line anywhere saying why.
pub fn push_configured() -> bool {
    vapid_configuration().is_some()
}

fn vapid_configuration() -> Option<(String, String)> {
    let private_key = env::var("WEB_PUSH_VAPID_PRIVATE_KEY")
        .ok()
        .map(|key| key.trim().to_owned())
        .filter(|key| !key.is_empty())?;
    let subject = env::var("WEB_PUSH_VAPID_SUBJECT")
        .ok()
        .map(|value| value.trim().to_owned())
        .filter(|value| value.starts_with("mailto:") || value.starts_with("https://"))?;
    Some((private_key, subject))
}

/// Send a lock-screen-safe incoming-call alert. A `true` result means a push
/// service accepted at least one notification; it does not reveal delivery data.
/// A call is the urgent case: high urgency, and a topic keyed to the call so a
/// second alert for the same call replaces the first rather than stacking.
pub async fn send_call_push(state: &AppState, recipient: Uuid, call_id: Uuid, username: &str, media: &str) -> bool {
    let payload = serde_json::json!({
        "type": "incoming-call", "callId": call_id, "username": username, "media": media,
    });
    send_push(state, recipient, &payload, CALL_TTL_SECONDS as u32, Urgency::High, Some(call_id.simple().to_string())).await
}

/// A friend request, or the acceptance of one.
///
/// Normal urgency and a day of TTL: unlike a call there is nothing to miss by
/// arriving late, and it should still be waiting when the device wakes up. The
/// payload carries a username and nothing else -- the same shape as the call
/// push, and never anything from a conversation.
pub async fn send_friend_push(state: &AppState, recipient: Uuid, kind: &str, username: &str) -> bool {
    let payload = serde_json::json!({ "type": kind, "username": username });
    send_push(state, recipient, &payload, 60 * 60 * 24, Urgency::Normal, None).await
}

/// A message arrived for someone with no live socket.
///
/// The payload is a conversation id and a username. It deliberately carries no
/// message content, no preview and no count -- the relay could not read the
/// ciphertext even if it wanted to, and the push provider learns only that a
/// message arrived. `topic` is the conversation, so ten messages in one thread
/// replace each other rather than stacking ten notifications.
pub async fn send_message_push(
    state: &AppState,
    recipient: Uuid,
    conversation_id: Uuid,
    username: &str,
) -> bool {
    let payload = message_push_payload(conversation_id, username);
    send_push(
        state,
        recipient,
        &payload,
        60 * 60 * 12,
        Urgency::Normal,
        // RFC 8030 limits Topic to 32 bytes. Keep a message prefix and use
        // the first 31 ASCII UUID characters so call and message topics cannot
        // replace one another.
        Some(message_push_topic(conversation_id)),
    )
    .await
}

/// The only message data a push provider may receive. Keep this as a small
/// pure builder so the privacy boundary is covered by a unit test as well as
/// by the call site.
fn message_push_payload(conversation_id: Uuid, username: &str) -> serde_json::Value {
    serde_json::json!({
        "type": "message",
        "conversationId": conversation_id,
        "username": username,
    })
}

fn message_push_topic(conversation_id: Uuid) -> String {
    let compact = conversation_id.simple().to_string();
    format!("m{}", &compact[..31])
}

/// Build a VAPID signature from either supported key representation.
///
/// The web-push crate's `from_base64` constructor expects the literal 32-byte
/// private scalar encoded as URL-safe base64. OpenSSL commonly produces a
/// PKCS#8/SEC1 DER document instead, also base64 encoded. The latter was in the
/// deployment environment and used to make every notification silently skip its
/// signature. Accepting both keeps existing deployments working while retaining
/// the documented raw-key format.
fn vapid_signature(
    private_key: &str,
    subject: &str,
    info: &SubscriptionInfo,
) -> Option<web_push::VapidSignature> {
    let decoded = URL_SAFE_NO_PAD.decode(private_key.as_bytes()).ok()?;
    // `from_base64` ultimately converts into a fixed-size 32-byte array and
    // can panic on a DER document, so choose the constructor from the decoded
    // length before calling it.
    let mut builder = if decoded.len() == 32 {
        VapidSignatureBuilder::from_base64(private_key, info).ok()?
    } else {
        match VapidSignatureBuilder::from_der(decoded.as_slice(), info) {
            Ok(builder) => builder,
            // OpenSSL's default `genpkey` output is PKCS#8. The crate accepts
            // that representation through its PEM reader, so wrap the same
            // decoded bytes without ever logging or persisting the key.
            Err(_) => {
                let encoded = BASE64.encode(&decoded);
                let wrapped = encoded
                    .as_bytes()
                    .chunks(64)
                    .map(std::str::from_utf8)
                    .collect::<Result<Vec<_>, _>>()
                    .ok()?
                    .join("\n");
                let pem = format!(
                    "-----BEGIN PRIVATE KEY-----\n{wrapped}\n-----END PRIVATE KEY-----\n",
                );
                VapidSignatureBuilder::from_pem(pem.as_bytes(), info).ok()?
            }
        }
    };
    builder.add_claim("sub", subject);
    builder.build().ok()
}

/// Fan a payload out to every device this account has registered.
///
/// Endpoints that the provider reports as dead are deleted as we go, so a
/// stale subscription cannot accumulate forever.
async fn send_push(
    state: &AppState,
    recipient: Uuid,
    payload: &serde_json::Value,
    ttl_seconds: u32,
    urgency: Urgency,
    topic: Option<String>,
) -> bool {
    let Some((private_key, subject)) = vapid_configuration() else { return false; };
    let subscriptions = match sqlx::query_as::<_, PushSubscriptionRow>("SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = $1")
        .bind(recipient).fetch_all(&state.db).await {
        Ok(rows) => rows,
        Err(error) => { warn!(%error, "Could not load push subscriptions"); return false; }
    };
    let client = match IsahcWebPushClient::new() { Ok(client) => client, Err(_) => return false };
    let payload = payload.to_string();
    let mut delivered = false;
    for subscription in subscriptions {
        let info = SubscriptionInfo::new(subscription.endpoint.clone(), subscription.p256dh, subscription.auth);
        let mut builder = WebPushMessageBuilder::new(&info);
        builder.set_payload(ContentEncoding::Aes128Gcm, payload.as_bytes());
        builder.set_ttl(ttl_seconds);
        builder.set_urgency(urgency);
        if let Some(topic) = topic.clone() {
            builder.set_topic(topic);
        }
        let Some(signature) = vapid_signature(&private_key, subject.as_str(), &info) else { continue; };
        builder.set_vapid_signature(signature);
        let message = match builder.build() {
            Ok(message) => message,
            Err(_) => continue,
        };
        match client.send(message).await {
            Ok(()) => delivered = true,
            Err(WebPushError::EndpointNotValid(_) | WebPushError::EndpointNotFound(_)) => {
                let _ = sqlx::query("DELETE FROM push_subscriptions WHERE endpoint = $1").bind(subscription.endpoint).execute(&state.db).await;
            }
            Err(error) => warn!(kind = error.short_description(), "Push was not accepted"),
        }
    }
    delivered
}

#[cfg(test)]
mod tests {
    use super::*;

    fn subscription(endpoint: &str) -> PushSubscriptionInput {
        PushSubscriptionInput {
            endpoint: endpoint.into(),
            keys: PushKeys { p256dh: "a".repeat(32), auth: "b".repeat(16) },
        }
    }

    #[test]
    fn accepts_only_known_https_push_providers() {
        assert!(valid_push_subscription(&subscription("https://fcm.googleapis.com/fcm/send/example")));
        assert!(valid_push_subscription(&subscription("https://web.push.apple.com/Q2hhbmdlTWU")));
        assert!(!valid_push_subscription(&subscription("https://127.0.0.1/push")));
        assert!(!valid_push_subscription(&subscription("https://example.com/push")));
    }

    #[test]
    fn message_push_payload_contains_sender_and_thread_only() {
        let conversation = Uuid::new_v4();
        let payload = message_push_payload(conversation, "ada");
        assert_eq!(payload["type"], "message");
        assert_eq!(payload["conversationId"], conversation.to_string());
        assert_eq!(payload["username"], "ada");
        assert!(payload.get("body").is_none());
        assert!(payload.get("plaintext").is_none());
    }

    #[test]
    fn message_push_topic_is_bounded_and_conversation_specific() {
        let topic = message_push_topic(Uuid::new_v4());
        assert_eq!(topic.len(), 32);
        assert!(topic.starts_with('m'));
    }

    #[test]
    fn vapid_signing_accepts_raw_and_openssl_der_keys() {
        let info = SubscriptionInfo::new(
            "https://fcm.googleapis.com/fcm/send/test",
            "BH1HTeKM7-NwaLGHEqxeu2IamQaVVLkcsFHPIHmsCnqxcBHPQBprF41bEMOr3O1hUQ2jU1opNEm1F_lZV_sxMP8",
            "sBXU5_tIYz-5w7G2B25BEw",
        );
        let raw = "IQ9Ur0ykXoHS9gzfYX0aBjy9lvdrjx_PFUXmie9YRcY";
        let sec1_der = "MHcCAQEEIMwug_U2ds75hkEIeou9s0kj1ziCJETswt5S9ztJ2L5SoAoGCCqGSM49AwEHoUQDQgAEyjUeooXqyQxljKSu17126pjAEPTyYNApO6dGQl0PexMn0T7LI3qwmU9ZOko2Gn7LYp5LqgA0cX6rfDftsKVvtQ";
        // Throwaway PKCS#8 fixture; never use a deployment credential in tests.
        let pkcs8_der = "MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgX8Nrn1IS76-2OQuMVgIcZQFqQEvWZbGJ-MLasLNIVxKhRANCAAQ2CCLWIMleF2scv3amCA-ZQPY2ZshkBF3YNwmI48spXtiVMMpHy-KlXF-VytoDiF-bBcV5U8MDBpIpEfzPjSqo";
        assert!(vapid_signature(raw, "mailto:test@example.com", &info).is_some());
        assert!(vapid_signature(sec1_der, "mailto:test@example.com", &info).is_some());
        assert!(vapid_signature(pkcs8_der, "mailto:test@example.com", &info).is_some());
    }
}

#[cfg(test)]
mod push_config_tests {
    /// The startup warning is the only signal that background alerts are off.
    /// If this ever stops reflecting the environment, users get silence and the
    /// logs say nothing about why.
    #[test]
    fn push_is_reported_as_configured_only_with_both_variables() {
        // SAFETY: single-threaded test, restored before returning.
        unsafe {
            std::env::remove_var("WEB_PUSH_VAPID_PRIVATE_KEY");
            std::env::remove_var("WEB_PUSH_VAPID_SUBJECT");
        }
        assert!(!super::push_configured(), "no variables means no push");

        unsafe { std::env::set_var("WEB_PUSH_VAPID_PRIVATE_KEY", "a-key") };
        assert!(!super::push_configured(), "a key alone is not enough");

        unsafe { std::env::set_var("WEB_PUSH_VAPID_SUBJECT", "not-a-uri") };
        assert!(!super::push_configured(), "the subject must be mailto: or https:");

        unsafe { std::env::set_var("WEB_PUSH_VAPID_SUBJECT", "mailto:ops@example.com") };
        assert!(super::push_configured(), "both present and well formed");

        unsafe {
            std::env::remove_var("WEB_PUSH_VAPID_PRIVATE_KEY");
            std::env::remove_var("WEB_PUSH_VAPID_SUBJECT");
        }
    }
}
