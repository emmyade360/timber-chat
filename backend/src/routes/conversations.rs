//! Conversations and message history.
//!
//! Every row returned here is ciphertext. The handlers authorise access and page
//! the data; they have no way to read it, and nothing in this file tries to.

use axum::{
    Json,
    extract::{Extension, Path, Query, State},
};
use chrono::{DateTime, Duration as ChronoDuration, Utc};
use serde::Deserialize;
use sqlx::PgPool;
use std::time::Duration;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    error::ApiError,
    models::{
        Conversation, ConversationRow, HistoryQuery, MessageReceipt, MessageRow, StoredMessage,
    },
};

const DEFAULT_PAGE: i64 = 50;
const MAX_PAGE: i64 = 200;
/// A receipt row is ~120 bytes, so a generous cap is still a small response.
const MAX_RECEIPTS: i64 = 500;
/// Receipts older than this are settled; re-checking them forever is waste.
const RECEIPT_WINDOW_DAYS: i64 = 7;

#[derive(Deserialize)]
pub struct ReceiptQuery {
    pub since: Option<DateTime<Utc>>,
}

#[derive(Deserialize)]
pub struct MarkReadInput {
    pub message_ids: Vec<Uuid>,
}

/// Confirm the caller is one of the two participants, and return the other one.
pub async fn require_participant(
    db: &PgPool,
    conversation_id: Uuid,
    user_id: Uuid,
) -> Result<Uuid, ApiError> {
    sqlx::query_scalar::<_, Uuid>(
        r#"
        SELECT CASE WHEN user_a = $2 THEN user_b ELSE user_a END
        FROM conversations
        WHERE id = $1 AND (user_a = $2 OR user_b = $2)
        "#,
    )
    .bind(conversation_id)
    .bind(user_id)
    .fetch_optional(db)
    .await?
    .ok_or_else(|| ApiError::Forbidden("This conversation is not yours.".into()))
}

pub async fn list_conversations(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Vec<Conversation>>, ApiError> {
    let rows = sqlx::query_as::<_, ConversationRow>(
        r#"
        SELECT
            c.id,
            c.created_at,
            p.id AS peer_id,
            p.username AS peer_username,
            p.avatar_url AS peer_avatar_url,
            p.is_online AS peer_is_online,
            p.level AS peer_level,
            p.kex_pk AS peer_kex_pk,
            p.identity_pk AS peer_identity_pk,
            p.kex_key_signature AS peer_kex_key_signature,
            (SELECT MAX(m.created_at) FROM messages m WHERE m.conversation_id = c.id)
                AS last_message_at
        FROM conversations c
        JOIN profiles p
            ON p.id = CASE WHEN c.user_a = $1 THEN c.user_b ELSE c.user_a END
        WHERE c.user_a = $1 OR c.user_b = $1
        ORDER BY last_message_at DESC NULLS LAST, c.created_at DESC
        "#,
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows.into_iter().map(Conversation::from).collect()))
}

/// A page of sealed messages, oldest first within the page.
///
/// `before` pages backwards for infinite scroll. The client normally reads from its
/// own encrypted store and only calls this to backfill a new device or catch up on
/// messages that arrived while it was offline.
pub async fn get_messages(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Path(conversation_id): Path<Uuid>,
    Query(query): Query<HistoryQuery>,
) -> Result<Json<Vec<StoredMessage>>, ApiError> {
    require_participant(&state.db, conversation_id, user.id).await?;
    let limit = query.limit.unwrap_or(DEFAULT_PAGE).clamp(1, MAX_PAGE);

    let mut rows = sqlx::query_as::<_, MessageRow>(
        r#"
        SELECT m.id, m.conversation_id, m.sender_id, m.envelope_version, m.nonce,
               m.ciphertext, m.created_at, m.delivered_at,
               (
                   SELECT r.created_at FROM read_receipts r
                   WHERE r.message_id = m.id AND r.user_id <> m.sender_id
                   LIMIT 1
               ) AS read_at
        FROM messages m
        WHERE m.conversation_id = $1
          AND ($2::timestamptz IS NULL OR m.created_at < $2)
        ORDER BY m.created_at DESC
        LIMIT $3
        "#,
    )
    .bind(conversation_id)
    .bind(query.before)
    .bind(limit)
    .fetch_all(&state.db)
    .await?;

    rows.reverse();
    Ok(Json(rows.into_iter().map(StoredMessage::from).collect()))
}

/// Receipt state for the caller's own recent messages.
///
/// History deliberately skips messages a device already holds, which is exactly
/// the set whose receipts need repairing after the sender was offline while the
/// peer read them. This is the only path by which those ticks catch up. It
/// returns ids and two timestamps -- no ciphertext, nothing about content.
pub async fn get_receipts(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Path(conversation_id): Path<Uuid>,
    Query(query): Query<ReceiptQuery>,
) -> Result<Json<Vec<MessageReceipt>>, ApiError> {
    require_participant(&state.db, conversation_id, user.id).await?;
    let since = query
        .since
        .unwrap_or_else(|| Utc::now() - ChronoDuration::days(RECEIPT_WINDOW_DAYS));

    let rows = sqlx::query_as::<_, MessageReceipt>(
        r#"
        SELECT m.id, m.delivered_at,
               (
                   SELECT r.created_at FROM read_receipts r
                   WHERE r.message_id = m.id AND r.user_id <> m.sender_id
                   LIMIT 1
               ) AS read_at
        FROM messages m
        WHERE m.conversation_id = $1
          AND m.sender_id = $2
          AND m.created_at > $3
        ORDER BY m.created_at DESC
        LIMIT $4
        "#,
    )
    .bind(conversation_id)
    .bind(user.id)
    .bind(since)
    .bind(MAX_RECEIPTS)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(rows))
}

/// Mark messages read and tell the sender.
///
/// Batched, and durable in a way the WebSocket is not: this is what the client
/// falls back to when the socket is down, where a receipt would otherwise be
/// lost with no way to retry it.
pub async fn mark_read(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Path(conversation_id): Path<Uuid>,
    Json(input): Json<MarkReadInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    if !state
        .limits
        .allow("http-receipt", user.id, 30, Duration::from_secs(60))
        .await
    {
        return Err(ApiError::TooManyRequests(
            "Too many read receipts. Try again shortly.".into(),
        ));
    }
    if input.message_ids.is_empty() {
        return Ok(Json(serde_json::json!({ "success": true })));
    }
    if input.message_ids.len() > MAX_RECEIPTS as usize {
        return Err(ApiError::BadRequest(
            "Too many read receipts in one batch.".into(),
        ));
    }
    let peer = require_participant(&state.db, conversation_id, user.id).await?;
    let read =
        crate::ws::record_read_receipts(&state.db, conversation_id, user.id, &input.message_ids)
            .await?;

    if !read.is_empty() {
        crate::ws::publish(
            &state,
            crate::ws::EventTarget::User(peer),
            "receipt.read",
            serde_json::json!({
                "conversation_id": conversation_id,
                "message_ids": read,
                "user_id": user.id,
            }),
        );
    }

    Ok(Json(serde_json::json!({ "success": true })))
}
