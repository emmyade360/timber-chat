//! Realtime transport.
//!
//! One socket per user, not per conversation. The client keeps a local encrypted
//! copy of every chat, so it has to receive messages for all of them in the
//! background -- a per-room socket would leave every other conversation stale until
//! it was opened.
//!
//! Events carry sealed envelopes. This module routes and persists ciphertext and
//! never inspects it.

use std::time::Duration;

use axum::{
    extract::{
        State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::{HeaderMap, header::{ORIGIN, SEC_WEBSOCKET_PROTOCOL}},
    response::Response,
};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use futures_util::{sink::SinkExt, stream::StreamExt};
use serde::{Deserialize, Serialize, de::DeserializeOwned};
use serde_json::{Value, json};
use tokio::sync::broadcast;
use tracing::{error, warn};
use uuid::Uuid;

use crate::{
    AppState,
    auth::{AuthUser, consume_ws_ticket},
    error::ApiError,
    models::{MessageRow, StoredMessage},
    routes::{conversations::require_participant, friends::are_friends},
    growth,
};

const NONCE_BYTES: usize = 24;
const MAX_CIPHERTEXT_BYTES: usize = 8192;
const MAX_CALL_SDP_BYTES: usize = 32 * 1024;
const MAX_ICE_CANDIDATE_BYTES: usize = 2048;

/// Who should receive an event.
///
/// Participants are resolved at the publish site, where they are already known, so
/// fanning out never needs a database lookup.
#[derive(Clone, Copy)]
pub enum EventTarget {
    User(Uuid),
    Pair(Uuid, Uuid),
}

impl EventTarget {
    fn includes(&self, user_id: Uuid) -> bool {
        match *self {
            Self::User(id) => id == user_id,
            Self::Pair(first, second) => first == user_id || second == user_id,
        }
    }
}

#[derive(Clone, Serialize)]
pub struct WireEvent {
    #[serde(rename = "type")]
    kind: String,
    payload: Value,
}

#[derive(Clone)]
pub struct PublishedEvent {
    target: EventTarget,
    event: WireEvent,
}

pub fn publish(state: &AppState, target: EventTarget, kind: &str, payload: Value) {
    // A send error only means nobody is currently listening, which is normal.
    let _ = state.events.send(PublishedEvent {
        target,
        event: WireEvent {
            kind: kind.to_owned(),
            payload,
        },
    });
}

const WS_PROTOCOL: &str = "timber-v1";

#[derive(Deserialize)]
struct ClientEvent {
    #[serde(rename = "type")]
    kind: String,
    payload: Value,
}

#[derive(Deserialize)]
struct SendMessageInput {
    conversation_id: Uuid,
    envelope_version: i16,
    nonce: String,
    ciphertext: String,
    /// Echoed back so the sender can match the stored message to its optimistic copy.
    client_id: Option<String>,
    /// Opaque staging id. The encrypted envelope still carries the attachment
    /// details; this field only lets the relay authorize private blob retrieval.
    attachment_id: Option<Uuid>,
    /// Optional expiry for an encrypted attachment. The relay learns only this
    /// retention deadline, never whether the blob is voice, image, or a file.
    attachment_expires_at: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
struct ScheduleMessageInput {
    conversation_id: Uuid,
    envelope_version: i16,
    nonce: String,
    ciphertext: String,
    client_id: Option<String>,
    /// The explicit server-visible delivery-time metadata for an otherwise
    /// opaque envelope. No plaintext or message type is sent alongside it.
    deliver_after: DateTime<Utc>,
}

#[derive(sqlx::FromRow)]
struct ScheduledMessageRow {
    id: Uuid,
    conversation_id: Uuid,
    sender_id: Uuid,
    envelope_version: i16,
    nonce: Vec<u8>,
    ciphertext: Vec<u8>,
    client_id: Option<String>,
}

#[derive(Deserialize)]
struct TypingInput {
    conversation_id: Uuid,
}

#[derive(Deserialize)]
struct ReadReceiptInput {
    conversation_id: Uuid,
    message_id: Uuid,
}

#[derive(Clone, Copy, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
enum CallMedia {
    Audio,
    Video,
}

#[derive(Deserialize)]
struct CallOfferInput {
    conversation_id: Uuid,
    call_id: Uuid,
    media: CallMedia,
    sdp: String,
}

#[derive(Deserialize)]
struct CallAnswerInput {
    conversation_id: Uuid,
    call_id: Uuid,
    sdp: String,
}

#[derive(Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct IceCandidateInput {
    candidate: String,
    sdp_mid: Option<String>,
    sdp_m_line_index: Option<u16>,
    username_fragment: Option<String>,
}

#[derive(Deserialize)]
struct CallIceCandidateInput {
    conversation_id: Uuid,
    call_id: Uuid,
    candidate: IceCandidateInput,
}

#[derive(Deserialize)]
struct CallEndInput {
    conversation_id: Uuid,
    call_id: Uuid,
    reason: Option<String>,
}

pub async fn websocket_handler(
    State(state): State<AppState>,
    headers: HeaderMap,
    websocket: WebSocketUpgrade,
) -> Result<Response, ApiError> {
    let origin = headers
        .get(ORIGIN)
        .and_then(|value| value.to_str().ok())
        .ok_or(ApiError::Unauthorized)?;
    if !state.allowed_origins.contains(origin) {
        return Err(ApiError::Forbidden("This origin is not allowed to open a socket.".into()));
    }

    // Browser WebSockets cannot use Authorization. The client presents a fresh
    // one-time ticket in Sec-WebSocket-Protocol; the selected protocol is only
    // the stable application name and never echoes the credential.
    let offered: Vec<&str> = headers
        .get(SEC_WEBSOCKET_PROTOCOL)
        .and_then(|value| value.to_str().ok())
        .map(|value| value.split(',').map(str::trim).collect())
        .ok_or(ApiError::Unauthorized)?;
    if !offered.contains(&WS_PROTOCOL) {
        return Err(ApiError::Unauthorized);
    }
    let ticket = offered
        .iter()
        .find(|value| **value != WS_PROTOCOL && !value.is_empty())
        .ok_or(ApiError::Unauthorized)?;
    let user = consume_ws_ticket(&state.db, ticket).await?;
    Ok(websocket
        .protocols([WS_PROTOCOL])
        .on_upgrade(move |socket| handle_socket(socket, state, user)))
}

async fn handle_socket(socket: WebSocket, state: AppState, user: AuthUser) {
    let (mut socket_tx, mut socket_rx) = socket.split();
    let mut events_rx = state.events.subscribe();

    if mark_user_connected(&state, user.id).await {
        publish_presence(&state, user.id, true).await;
    }

    loop {
        tokio::select! {
            incoming = socket_rx.next() => {
                match incoming {
                    Some(Ok(Message::Text(text))) => {
                        if let Err(error) = process_socket_event(&state, &user, text.as_str()).await {
                            warn!(?error, user_id = %user.id, "Rejected WebSocket event");
                        }
                    }
                    Some(Ok(Message::Close(_))) | None | Some(Err(_)) => break,
                    Some(Ok(_)) => {}
                }
            }
            event = events_rx.recv() => {
                match event {
                    Ok(published) if published.target.includes(user.id) => {
                        match serde_json::to_string(&published.event) {
                            Ok(text) => {
                                if socket_tx.send(Message::Text(text.into())).await.is_err() {
                                    break;
                                }
                            }
                            Err(error) => error!(%error, "Could not serialize WebSocket event"),
                        }
                    }
                    Ok(_) => {}
                    Err(broadcast::error::RecvError::Lagged(skipped)) => {
                        warn!(%skipped, user_id = %user.id, "WebSocket client lagged behind");
                    }
                    Err(broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    if mark_user_disconnected(&state, user.id).await {
        publish_presence(&state, user.id, false).await;
    }
}

/// Presence is private social metadata: only accepted friends learn a transition.
async fn publish_presence(state: &AppState, user_id: Uuid, online: bool) {
    let friends: Result<Vec<Uuid>, _> = sqlx::query_scalar(
        r#"
        SELECT CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END
        FROM friend_requests
        WHERE status = 'accepted' AND (sender_id = $1 OR receiver_id = $1)
        "#,
    )
    .bind(user_id)
    .fetch_all(&state.db)
    .await;
    match friends {
        Ok(friends) => {
            for friend in friends {
                publish(
                    state,
                    EventTarget::User(friend),
                    if online { "presence.online" } else { "presence.offline" },
                    json!({ "user_id": user_id }),
                );
            }
        }
        Err(error) => warn!(%error, %user_id, "Could not resolve friends for presence update"),
    }
}

fn deserialize_payload<T: DeserializeOwned>(payload: Value) -> Result<T, ApiError> {
    serde_json::from_value(payload).map_err(|error| ApiError::BadRequest(error.to_string()))
}

async fn process_socket_event(
    state: &AppState,
    user: &AuthUser,
    raw_event: &str,
) -> Result<(), ApiError> {
    let event: ClientEvent =
        serde_json::from_str(raw_event).map_err(|error| ApiError::BadRequest(error.to_string()))?;

    let (scope, max, window) = match event.kind.as_str() {
        "message.send" => ("ws-message", 30, Duration::from_secs(60)),
        "message.schedule" => ("ws-schedule", 12, Duration::from_secs(60 * 60)),
        "typing.start" | "typing.stop" => ("ws-typing", 20, Duration::from_secs(10)),
        "receipt.read" => ("ws-receipt", 60, Duration::from_secs(60)),
        // SDP is small, ephemeral setup metadata; offers are intentionally rare.
        "call.offer" => ("ws-call-offer", 4, Duration::from_secs(60)),
        "call.answer" => ("ws-call-answer", 8, Duration::from_secs(60)),
        // ICE trickling legitimately emits several candidates for a single call.
        "call.ice-candidate" => ("ws-call-ice", 160, Duration::from_secs(60)),
        "call.end" => ("ws-call-end", 20, Duration::from_secs(60)),
        _ => return Err(ApiError::BadRequest("Unknown WebSocket event type.".into())),
    };
    if !state.limits.allow(scope, user.id, max, window).await {
        return Err(ApiError::TooManyRequests("Too many realtime events. Slow down and try again.".into()));
    }

    match event.kind.as_str() {
        "message.send" => send_message(state, user, deserialize_payload(event.payload)?).await,
        "message.schedule" => schedule_message(state, user, deserialize_payload(event.payload)?).await,
        "call.offer" => relay_call_offer(state, user, deserialize_payload(event.payload)?).await,
        "call.answer" => relay_call_answer(state, user, deserialize_payload(event.payload)?).await,
        "call.ice-candidate" => relay_call_ice_candidate(state, user, deserialize_payload(event.payload)?).await,
        "call.end" => relay_call_end(state, user, deserialize_payload(event.payload)?).await,
        "typing.start" | "typing.stop" => {
            let input: TypingInput = deserialize_payload(event.payload)?;
            let peer = require_participant(&state.db, input.conversation_id, user.id).await?;
            publish(
                state,
                // Only the other participant; echoing to the typist is noise.
                EventTarget::User(peer),
                &event.kind,
                json!({
                    "conversation_id": input.conversation_id,
                    "user_id": user.id,
                    "username": user.username,
                }),
            );
            Ok(())
        }
        "receipt.read" => {
            let input: ReadReceiptInput = deserialize_payload(event.payload)?;
            let peer = require_participant(&state.db, input.conversation_id, user.id).await?;
            let inserted = sqlx::query(
                r#"
                INSERT INTO read_receipts (message_id, user_id)
                SELECT $1, $2
                WHERE EXISTS (SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $3)
                ON CONFLICT DO NOTHING
                "#,
            )
            .bind(input.message_id)
            .bind(user.id)
            .bind(input.conversation_id)
            .execute(&state.db)
            .await?;

            if inserted.rows_affected() > 0 {
                publish(
                    state,
                    EventTarget::User(peer),
                    "receipt.read",
                    json!({
                        "conversation_id": input.conversation_id,
                        "message_id": input.message_id,
                        "user_id": user.id,
                    }),
                );
            }
            Ok(())
        }
        _ => unreachable!("event type was validated before dispatch"),
    }
}

/// Call signalling is never persisted. These checks make the WebSocket a
/// narrowly scoped relay: only accepted friends in an existing 1:1 conversation
/// can exchange setup metadata, and neither caller can signal after a removal.
async fn call_peer(
    state: &AppState,
    user: &AuthUser,
    conversation_id: Uuid,
) -> Result<Uuid, ApiError> {
    let peer = require_participant(&state.db, conversation_id, user.id).await?;
    if !are_friends(&state.db, user.id, peer).await? {
        return Err(ApiError::Forbidden("You can only call accepted friends.".into()));
    }
    Ok(peer)
}

fn validate_sdp(sdp: &str) -> Result<(), ApiError> {
    if sdp.len() > MAX_CALL_SDP_BYTES || !sdp.is_ascii() {
        return Err(ApiError::BadRequest("Invalid call session description.".into()));
    }
    if !sdp.starts_with("v=0") || !sdp.contains("\nm=") {
        return Err(ApiError::BadRequest("Invalid call session description.".into()));
    }
    Ok(())
}

fn validate_candidate(candidate: &IceCandidateInput) -> Result<(), ApiError> {
    if candidate.candidate.is_empty()
        || candidate.candidate.len() > MAX_ICE_CANDIDATE_BYTES
        || !candidate.candidate.starts_with("candidate:")
        || candidate.sdp_mid.as_deref().is_some_and(|value| value.len() > 64)
    {
        return Err(ApiError::BadRequest("Invalid ICE candidate.".into()));
    }
    Ok(())
}

async fn relay_call_offer(
    state: &AppState,
    user: &AuthUser,
    input: CallOfferInput,
) -> Result<(), ApiError> {
    validate_sdp(&input.sdp)?;
    let peer = call_peer(state, user, input.conversation_id).await?;
    publish(
        state,
        EventTarget::User(peer),
        "call.offer",
        json!({
            "conversation_id": input.conversation_id,
            "call_id": input.call_id,
            "media": input.media,
            "sdp": input.sdp,
            "from": user.id,
            "username": user.username,
        }),
    );
    Ok(())
}

async fn relay_call_answer(
    state: &AppState,
    user: &AuthUser,
    input: CallAnswerInput,
) -> Result<(), ApiError> {
    validate_sdp(&input.sdp)?;
    let peer = call_peer(state, user, input.conversation_id).await?;
    publish(
        state,
        EventTarget::User(peer),
        "call.answer",
        json!({
            "conversation_id": input.conversation_id,
            "call_id": input.call_id,
            "sdp": input.sdp,
            "from": user.id,
        }),
    );
    Ok(())
}

async fn relay_call_ice_candidate(
    state: &AppState,
    user: &AuthUser,
    input: CallIceCandidateInput,
) -> Result<(), ApiError> {
    validate_candidate(&input.candidate)?;
    let peer = call_peer(state, user, input.conversation_id).await?;
    publish(
        state,
        EventTarget::User(peer),
        "call.ice-candidate",
        json!({
            "conversation_id": input.conversation_id,
            "call_id": input.call_id,
            "candidate": input.candidate,
            "from": user.id,
        }),
    );
    Ok(())
}

async fn relay_call_end(
    state: &AppState,
    user: &AuthUser,
    input: CallEndInput,
) -> Result<(), ApiError> {
    let peer = call_peer(state, user, input.conversation_id).await?;
    let reason = input.reason.unwrap_or_else(|| "hangup".into());
    if !matches!(reason.as_str(), "hangup" | "declined" | "busy" | "unavailable" | "failed") {
        return Err(ApiError::BadRequest("Invalid call end reason.".into()));
    }
    publish(
        state,
        EventTarget::User(peer),
        "call.end",
        json!({
            "conversation_id": input.conversation_id,
            "call_id": input.call_id,
            "reason": reason,
            "from": user.id,
        }),
    );
    Ok(())
}

async fn send_message(
    state: &AppState,
    user: &AuthUser,
    input: SendMessageInput,
) -> Result<(), ApiError> {
    let peer = require_participant(&state.db, input.conversation_id, user.id).await?;

    // Re-checked on every send rather than only at conversation creation, so
    // removing a friend stops delivery immediately.
    if !are_friends(&state.db, user.id, peer).await? {
        return Err(ApiError::Forbidden(
            "You can only message accepted friends.".into(),
        ));
    }

    let (nonce, ciphertext) = validate_envelope(input.envelope_version, &input.nonce, &input.ciphertext)?;
    if let Some(expires_at) = input.attachment_expires_at
        && (expires_at <= Utc::now() || expires_at > Utc::now() + ChronoDuration::days(7))
    {
        return Err(ApiError::BadRequest("Attachment expiry must be within the next seven days.".into()));
    }

    let mut tx = state.db.begin().await?;
    if let Some(attachment_id) = input.attachment_id {
        let attached: Option<Uuid> = sqlx::query_scalar(
            "SELECT id FROM attachments WHERE id = $1 AND owner_id = $2 AND message_id IS NULL AND expires_at > NOW() FOR UPDATE",
        )
        .bind(attachment_id)
        .bind(user.id)
        .fetch_one(&mut *tx)
        .await?;
        if attached.is_none() {
            return Err(ApiError::BadRequest("That attachment is unavailable or does not belong to you.".into()));
        }
    }

    let row = sqlx::query_as::<_, MessageRow>(
        r#"
        INSERT INTO messages (conversation_id, sender_id, envelope_version, nonce, ciphertext)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, conversation_id, sender_id, envelope_version, nonce, ciphertext, created_at
        "#,
    )
    .bind(input.conversation_id)
    .bind(user.id)
    .bind(input.envelope_version)
    .bind(&nonce)
    .bind(&ciphertext)
    .fetch_one(&mut *tx)
    .await?;

    if let Some(attachment_id) = input.attachment_id {
        sqlx::query("UPDATE attachments SET message_id = $1, expires_at = COALESCE($3, 'infinity'::timestamptz) WHERE id = $2")
            .bind(row.id)
            .bind(attachment_id)
            .bind(input.attachment_expires_at)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    let stored = StoredMessage::from(row);
    let mut payload = serde_json::to_value(&stored)
        .map_err(|error| ApiError::Internal(error.to_string()))?;
    if let Some(client_id) = input.client_id {
        payload["client_id"] = Value::String(client_id);
    }

    publish(
        state,
        EventTarget::Pair(user.id, peer),
        "message.new",
        payload,
    );

    // The first intentional conversation activity of a day can advance connection
    // growth. Message quantity and time online never affect it.
    let growth_awards = growth::touch_connection(&state.db, user.id).await?;
    let promoted = growth_awards.iter().find_map(|entry| entry.promoted_to);
    if let Some(level) = promoted {
        publish(
            state,
            EventTarget::User(user.id),
            "growth.stage_reached",
            json!({ "level": level, "name": crate::models::level_name(level) }),
        );
    }

    Ok(())
}

fn validate_envelope(version: i16, nonce_b64: &str, ciphertext_b64: &str) -> Result<(Vec<u8>, Vec<u8>), ApiError> {
    if !matches!(version, 1 | 2) {
        return Err(ApiError::BadRequest("Unsupported message format.".into()));
    }
    let nonce = BASE64.decode(nonce_b64)
        .map_err(|_| ApiError::BadRequest("nonce is not valid base64".into()))?;
    if nonce.len() != NONCE_BYTES {
        return Err(ApiError::BadRequest("nonce must be 24 bytes".into()));
    }
    let ciphertext = BASE64.decode(ciphertext_b64)
        .map_err(|_| ApiError::BadRequest("ciphertext is not valid base64".into()))?;
    if ciphertext.is_empty() || ciphertext.len() > MAX_CIPHERTEXT_BYTES {
        return Err(ApiError::BadRequest("That message is too long to send.".into()));
    }
    Ok((nonce, ciphertext))
}

/// Store a sealed envelope until its requested delivery time. A scheduled
/// envelope is never exposed by message history or events before it is due.
async fn schedule_message(
    state: &AppState,
    user: &AuthUser,
    input: ScheduleMessageInput,
) -> Result<(), ApiError> {
    let peer = require_participant(&state.db, input.conversation_id, user.id).await?;
    if !are_friends(&state.db, user.id, peer).await? {
        return Err(ApiError::Forbidden("You can only message accepted friends.".into()));
    }
    let now = Utc::now();
    if input.deliver_after < now + ChronoDuration::seconds(30)
        || input.deliver_after > now + ChronoDuration::days(7)
    {
        return Err(ApiError::BadRequest("Schedule delivery from 30 seconds to 7 days from now.".into()));
    }
    let (nonce, ciphertext) = validate_envelope(input.envelope_version, &input.nonce, &input.ciphertext)?;
    let id: Uuid = sqlx::query_scalar(
        r#"INSERT INTO scheduled_messages
          (conversation_id, sender_id, envelope_version, nonce, ciphertext, client_id, deliver_after)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          RETURNING id"#,
    )
    .bind(input.conversation_id)
    .bind(user.id)
    .bind(input.envelope_version)
    .bind(nonce)
    .bind(ciphertext)
    .bind(input.client_id.clone())
    .bind(input.deliver_after)
    .fetch_one(&state.db)
    .await?;
    publish(
        state,
        EventTarget::User(user.id),
        "message.scheduled",
        json!({ "id": id, "client_id": input.client_id, "conversation_id": input.conversation_id, "deliver_after": input.deliver_after }),
    );
    Ok(())
}

/// Called by a small in-process scheduler. Row locking makes it safe if a
/// deployment accidentally has more than one API process; only one can claim a
/// due item, then atomically insert the normal message row before publishing it.
pub async fn deliver_due_scheduled_messages(state: &AppState) -> Result<(), ApiError> {
    let mut tx = state.db.begin().await?;
    let due = sqlx::query_as::<_, ScheduledMessageRow>(
        r#"SELECT id, conversation_id, sender_id, envelope_version, nonce, ciphertext, client_id
           FROM scheduled_messages
           WHERE delivered_at IS NULL AND deliver_after <= NOW()
           ORDER BY deliver_after ASC
           LIMIT 50 FOR UPDATE SKIP LOCKED"#,
    )
    .fetch_all(&mut *tx)
    .await?;
    let mut deliveries = Vec::new();
    for scheduled in due {
        let peer = require_participant(&state.db, scheduled.conversation_id, scheduled.sender_id).await?;
        // Do not resurrect a connection that was removed between scheduling and
        // delivery. The envelope is discarded without ever being delivered.
        if !are_friends(&state.db, scheduled.sender_id, peer).await? {
            sqlx::query("DELETE FROM scheduled_messages WHERE id = $1")
                .bind(scheduled.id).execute(&mut *tx).await?;
            continue;
        }
        let row = sqlx::query_as::<_, MessageRow>(
            r#"INSERT INTO messages (conversation_id, sender_id, envelope_version, nonce, ciphertext)
               VALUES ($1, $2, $3, $4, $5)
               RETURNING id, conversation_id, sender_id, envelope_version, nonce, ciphertext, created_at"#,
        )
        .bind(scheduled.conversation_id)
        .bind(scheduled.sender_id)
        .bind(scheduled.envelope_version)
        .bind(&scheduled.nonce)
        .bind(&scheduled.ciphertext)
        .fetch_one(&mut *tx)
        .await?;
        sqlx::query("UPDATE scheduled_messages SET delivered_at = NOW() WHERE id = $1")
            .bind(scheduled.id).execute(&mut *tx).await?;
        deliveries.push((scheduled.sender_id, peer, scheduled.client_id, row));
    }
    tx.commit().await?;
    for (sender, peer, client_id, row) in deliveries {
        let mut payload = serde_json::to_value(StoredMessage::from(row))
            .map_err(|error| ApiError::Internal(error.to_string()))?;
        if let Some(client_id) = client_id { payload["client_id"] = Value::String(client_id); }
        publish(state, EventTarget::Pair(sender, peer), "message.new", payload);
    }
    Ok(())
}

/// Reference-counted so multiple tabs do not flip a user offline on the first close.
async fn mark_user_connected(state: &AppState, user_id: Uuid) -> bool {
    let first_connection = {
        let mut users = state.online_users.lock().await;
        let count = users.entry(user_id).or_insert(0);
        *count += 1;
        *count == 1
    };
    if first_connection
        && let Err(error) = sqlx::query("UPDATE profiles SET is_online = true WHERE id = $1")
            .bind(user_id)
            .execute(&state.db)
            .await
    {
        warn!(%error, %user_id, "Could not mark user as online");
    }
    first_connection
}

async fn mark_user_disconnected(state: &AppState, user_id: Uuid) -> bool {
    let last_connection = {
        let mut users = state.online_users.lock().await;
        match users.get_mut(&user_id) {
            Some(count) if *count > 1 => {
                *count -= 1;
                false
            }
            Some(_) => {
                users.remove(&user_id);
                true
            }
            None => false,
        }
    };
    if last_connection
        && let Err(error) =
            sqlx::query("UPDATE profiles SET is_online = false, last_seen = NOW() WHERE id = $1")
                .bind(user_id)
                .execute(&state.db)
                .await
    {
        warn!(%error, %user_id, "Could not mark user as offline");
    }
    last_connection
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_user_target_reaches_only_that_user() {
        let ada = Uuid::new_v4();
        let tobi = Uuid::new_v4();
        assert!(EventTarget::User(ada).includes(ada));
        assert!(!EventTarget::User(ada).includes(tobi));
    }

    #[test]
    fn a_pair_target_reaches_both_participants_and_nobody_else() {
        let ada = Uuid::new_v4();
        let tobi = Uuid::new_v4();
        let eve = Uuid::new_v4();
        let target = EventTarget::Pair(ada, tobi);
        assert!(target.includes(ada));
        assert!(target.includes(tobi));
        assert!(!target.includes(eve));
    }

    #[test]
    fn a_presence_target_can_be_scoped_to_a_single_friend() {
        let friend = Uuid::new_v4();
        let outsider = Uuid::new_v4();
        assert!(EventTarget::User(friend).includes(friend));
        assert!(!EventTarget::User(friend).includes(outsider));
    }

    #[test]
    fn call_setup_rejects_malformed_sdp_and_ice_candidates() {
        assert!(validate_sdp("v=0\r\no=- 1 1 IN IP4 127.0.0.1\r\nm=audio 9 UDP/TLS/RTP/SAVPF 111\r\n").is_ok());
        assert!(validate_sdp("not a session description").is_err());
        assert!(validate_candidate(&IceCandidateInput {
            candidate: "candidate:1 1 udp 1 192.0.2.1 1234 typ host".into(),
            sdp_mid: Some("0".into()),
            sdp_m_line_index: Some(0),
            username_fragment: None,
        }).is_ok());
        assert!(validate_candidate(&IceCandidateInput {
            candidate: "not-a-candidate".into(),
            sdp_mid: None,
            sdp_m_line_index: None,
            username_fragment: None,
        }).is_err());
    }
}
