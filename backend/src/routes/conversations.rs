//! Conversations and message history.
//!
//! Every row returned here is ciphertext. The handlers authorise access and page
//! the data; they have no way to read it, and nothing in this file tries to.

use axum::{
    Json,
    extract::{Extension, Path, Query, State},
};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    error::ApiError,
    models::{Conversation, ConversationRow, HistoryQuery, MessageRow, StoredMessage},
};

const DEFAULT_PAGE: i64 = 50;
const MAX_PAGE: i64 = 200;

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
        SELECT id, conversation_id, sender_id, envelope_version, nonce, ciphertext, created_at
        FROM messages
        WHERE conversation_id = $1
          AND ($2::timestamptz IS NULL OR created_at < $2)
        ORDER BY created_at DESC
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

/// Mark a message read and tell the sender.
pub async fn mark_read(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Path((conversation_id, message_id)): Path<(Uuid, Uuid)>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let peer = require_participant(&state.db, conversation_id, user.id).await?;

    let inserted = sqlx::query(
        r#"
        INSERT INTO read_receipts (message_id, user_id)
        SELECT $1, $2
        WHERE EXISTS (SELECT 1 FROM messages WHERE id = $1 AND conversation_id = $3)
        ON CONFLICT DO NOTHING
        "#,
    )
    .bind(message_id)
    .bind(user.id)
    .bind(conversation_id)
    .execute(&state.db)
    .await?;

    if inserted.rows_affected() > 0 {
        crate::ws::publish(
            &state,
            crate::ws::EventTarget::User(peer),
            "receipt.read",
            serde_json::json!({
                "conversation_id": conversation_id,
                "message_id": message_id,
                "user_id": user.id,
            }),
        );
    }

    Ok(Json(serde_json::json!({ "success": true })))
}
