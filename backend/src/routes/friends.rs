//! The social graph. Messaging is gated entirely on mutual friendship.
//!
//! Requests follow a two-strike rule. A rejected sender may try exactly once more;
//! a second rejection is terminal and also removes the receiver from that sender's
//! search results, so someone who says no twice stops being findable by that person.
//! The block is directional: the receiver can still reach out themselves if they
//! change their mind, which turns into an ordinary pending request.

use axum::{
    Json,
    extract::{Extension, Path, State},
};
use std::time::Duration;
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    error::ApiError,
    models::{Friend, FriendRequestRow, FriendRequestView, FriendRow, FriendsResponse},
    ws::{EventTarget, publish},
    growth::{self, GrowthKind, POINTS_PER_CONNECTION},
};

/// Are these two users mutually accepted friends?
///
/// Checked on every message send, not just when the conversation is created, so
/// that removing a friend cuts off messaging immediately.
pub async fn are_friends(db: &PgPool, first: Uuid, second: Uuid) -> Result<bool, ApiError> {
    sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM friend_requests
            WHERE status = 'accepted'
              AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
        )
        "#,
    )
    .bind(first)
    .bind(second)
    .fetch_one(db)
    .await
    .map_err(Into::into)
}

#[derive(Deserialize)]
pub struct FriendRequestInput {
    receiver_id: Uuid,
}

pub async fn send_friend_request(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<FriendRequestInput>,
) -> Result<Json<Value>, ApiError> {
    if !state
        .limits
        .allow("friend-request", user.id, 10, Duration::from_secs(60 * 60))
        .await
    {
        return Err(ApiError::TooManyRequests("You have sent too many friend requests. Try again later.".into()));
    }
    if input.receiver_id == user.id {
        return Err(ApiError::BadRequest(
            "You cannot send a friend request to yourself.".into(),
        ));
    }

    let receiver_exists: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM profiles WHERE id = $1)")
            .bind(input.receiver_id)
            .fetch_one(&state.db)
            .await?;
    if !receiver_exists {
        return Err(ApiError::NotFound("User not found.".into()));
    }

    // Their pending request to us takes priority: accepting is the right action,
    // and letting both directions sit pending would be confusing.
    let incoming_pending: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2 AND status = 'pending')",
    )
    .bind(input.receiver_id)
    .bind(user.id)
    .fetch_one(&state.db)
    .await?;
    if incoming_pending {
        return Err(ApiError::Conflict(
            "This user already sent you a request — accept it instead.".into(),
        ));
    }

    let existing: Option<(String, i16)> = sqlx::query_as(
        "SELECT status, attempts FROM friend_requests WHERE sender_id = $1 AND receiver_id = $2",
    )
    .bind(user.id)
    .bind(input.receiver_id)
    .fetch_optional(&state.db)
    .await?;

    let attempts = match existing.as_ref().map(|(status, attempts)| (status.as_str(), *attempts)) {
        // Terminal. The receiver is already hidden from this user's search, so
        // reaching here means a stale client or a hand-crafted request.
        Some(("blocked", _)) => {
            return Err(ApiError::Forbidden(
                "You can no longer send requests to this user.".into(),
            ));
        }
        Some(("accepted", _)) => return Err(ApiError::Conflict("You are already friends.".into())),
        Some(("pending", _)) => {
            return Err(ApiError::Conflict("Your request is still pending.".into()));
        }
        Some(("rejected", 1)) => 2,
        Some(("rejected", _)) => {
            return Err(ApiError::Forbidden(
                "You can no longer send requests to this user.".into(),
            ));
        }
        _ => 1,
    };

    sqlx::query(
        r#"
        INSERT INTO friend_requests (sender_id, receiver_id, status, attempts)
        VALUES ($1, $2, 'pending', $3)
        ON CONFLICT (sender_id, receiver_id)
        DO UPDATE SET status = 'pending', attempts = $3, updated_at = NOW()
        "#,
    )
    .bind(user.id)
    .bind(input.receiver_id)
    .bind(attempts)
    .execute(&state.db)
    .await?;

    publish(
        &state,
        EventTarget::User(input.receiver_id),
        "friend.request",
        json!({ "from": user.id, "username": user.username }),
    );
    // Reaches a device whose app is fully closed; the WebSocket event above
    // covers every case where Timber is still running.
    crate::routes::calls::send_friend_push(&state, input.receiver_id, "friend-request", &user.username).await;

    Ok(Json(json!({
        "success": true,
        "attempts": attempts,
        "last_chance": attempts == 2,
    })))
}

#[derive(Deserialize)]
pub struct RespondInput {
    approve: bool,
}

pub async fn respond_friend_request(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Path(request_id): Path<Uuid>,
    Json(input): Json<RespondInput>,
) -> Result<Json<Value>, ApiError> {
    let mut tx = state.db.begin().await?;

    let (sender_id, attempts): (Uuid, i16) = sqlx::query_as(
        r#"
        SELECT sender_id, attempts FROM friend_requests
        WHERE id = $1 AND receiver_id = $2 AND status = 'pending'
        FOR UPDATE
        "#,
    )
    .bind(request_id)
    .bind(user.id)
    .fetch_optional(&mut *tx)
    .await?
    .ok_or_else(|| ApiError::NotFound("Pending friend request not found.".into()))?;

    if !input.approve {
        // First rejection leaves the door open for one more try; the second closes it.
        let status = if attempts >= 2 { "blocked" } else { "rejected" };
        sqlx::query("UPDATE friend_requests SET status = $2, updated_at = NOW() WHERE id = $1")
            .bind(request_id)
            .bind(status)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        return Ok(Json(json!({ "success": true, "status": status })));
    }

    sqlx::query("UPDATE friend_requests SET status = 'accepted', updated_at = NOW() WHERE id = $1")
        .bind(request_id)
        .execute(&mut *tx)
        .await?;

    // Canonical ordering plus the UNIQUE constraint means this is idempotent even
    // if both sides somehow accept concurrently.
    let conversation_id: Uuid = sqlx::query_scalar(
        r#"
        INSERT INTO conversations (user_a, user_b)
        VALUES (LEAST($1, $2), GREATEST($1, $2))
        ON CONFLICT (user_a, user_b) DO UPDATE SET user_a = conversations.user_a
        RETURNING id
        "#,
    )
    .bind(user.id)
    .bind(sender_id)
    .fetch_one(&mut *tx)
    .await?;

    tx.commit().await?;

    // Both sides receive a small connection-growth milestone, subject to the
    // daily cap. A connection is always mutual; sending requests earns nothing.
    for participant in [user.id, sender_id] {
        let award = growth::award(
            &state.db,
            participant,
            GrowthKind::Connection,
            POINTS_PER_CONNECTION,
        )
        .await?;
        if let Some(level) = award.promoted_to {
            publish(
                &state,
                EventTarget::User(participant),
                "growth.stage_reached",
                json!({ "level": level, "name": crate::models::level_name(level) }),
            );
        }
    }

    publish(
        &state,
        EventTarget::User(sender_id),
        "friend.accepted",
        json!({ "by": user.id, "username": user.username, "conversation_id": conversation_id }),
    );
    crate::routes::calls::send_friend_push(&state, sender_id, "friend-accepted", &user.username).await;

    Ok(Json(json!({
        "success": true,
        "status": "accepted",
        "conversation_id": conversation_id,
    })))
}

pub async fn get_friends(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<FriendsResponse>, ApiError> {
    let friends = sqlx::query_as::<_, FriendRow>(
        r#"
        WITH accepted AS (
            SELECT CASE WHEN sender_id = $1 THEN receiver_id ELSE sender_id END AS friend_id
            FROM friend_requests
            WHERE status = 'accepted' AND (sender_id = $1 OR receiver_id = $1)
        )
        SELECT
            p.id, p.username, p.avatar_url, p.is_online, p.level, p.kex_pk,
            p.identity_pk, p.kex_key_signature,
            c.id AS conversation_id
        FROM accepted a
        JOIN profiles p ON p.id = a.friend_id
        LEFT JOIN conversations c
            ON c.user_a = LEAST($1, p.id) AND c.user_b = GREATEST($1, p.id)
        ORDER BY p.username ASC
        "#,
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    let received = sqlx::query_as::<_, FriendRequestRow>(
        r#"
        SELECT fr.id, fr.sender_id AS user_id, p.username, p.avatar_url, p.is_online,
               p.level, fr.created_at
        FROM friend_requests fr
        JOIN profiles p ON p.id = fr.sender_id
        WHERE fr.receiver_id = $1 AND fr.status = 'pending'
        ORDER BY fr.created_at DESC
        "#,
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    let sent = sqlx::query_as::<_, FriendRequestRow>(
        r#"
        SELECT fr.id, fr.receiver_id AS user_id, p.username, p.avatar_url, p.is_online,
               p.level, fr.created_at
        FROM friend_requests fr
        JOIN profiles p ON p.id = fr.receiver_id
        WHERE fr.sender_id = $1 AND fr.status = 'pending'
        ORDER BY fr.created_at DESC
        "#,
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(FriendsResponse {
        friends: friends.into_iter().map(Friend::from).collect(),
        pending_received: received.into_iter().map(FriendRequestView::from).collect(),
        pending_sent: sent.into_iter().map(FriendRequestView::from).collect(),
    }))
}

pub async fn get_pending_requests_count(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Value>, ApiError> {
    let count: i64 = sqlx::query_scalar(
        "SELECT COUNT(*) FROM friend_requests WHERE receiver_id = $1 AND status = 'pending'",
    )
    .bind(user.id)
    .fetch_one(&state.db)
    .await?;
    Ok(Json(json!({ "count": count })))
}

/// Remove a friendship. The conversation row and its ciphertext are deleted with it.
pub async fn remove_friend(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Path(friend_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    let mut tx = state.db.begin().await?;
    sqlx::query(
        r#"
        DELETE FROM friend_requests
        WHERE status = 'accepted'
          AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
        "#,
    )
    .bind(user.id)
    .bind(friend_id)
    .execute(&mut *tx)
    .await?;

    sqlx::query("DELETE FROM conversations WHERE user_a = LEAST($1, $2) AND user_b = GREATEST($1, $2)")
        .bind(user.id)
        .bind(friend_id)
        .execute(&mut *tx)
        .await?;
    tx.commit().await?;

    publish(
        &state,
        EventTarget::User(friend_id),
        "friend.removed",
        json!({ "by": user.id }),
    );

    Ok(Json(json!({ "success": true })))
}
