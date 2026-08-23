//! Profiles, search, and the connection-growth path.

use axum::{
    Json,
    extract::{Extension, Path, Query, State},
};
use std::time::Duration;
use serde_json::{Value, json};
use uuid::Uuid;

use crate::{
    AppState,
    ws::{EventTarget, publish},
    auth::AuthUser,
    error::ApiError,
    levels,
    growth::{self, GrowthKind},
    models::{
        PublicProfile, SearchQuery, SearchResult, SelfProfile, SelfProfileRow, UserSearchRow,
    },
};

/// Redeem an invite code for a freshly created account.
///
/// An invite starts both people as friends, unless somebody has blocked the other.
/// It is not a growth multiplier: inviting people is never required or rewarded for
/// personal progress. Returns the inviter's username.
///
/// A code that does not resolve is ignored rather than fatal: the account has
/// already been created, and failing the signup over a mistyped link would be worse
/// than silently missing the bonus.
pub async fn redeem_invite(
    state: &AppState,
    invited_id: Uuid,
    code: &str,
) -> Result<Option<String>, ApiError> {
    let referrer: Option<(Uuid, String)> =
        sqlx::query_as("SELECT id, username FROM profiles WHERE invite_code = $1")
            .bind(code.trim().to_uppercase())
            .fetch_optional(&state.db)
            .await?;

    let Some((referrer_id, referrer_username)) = referrer else {
        return Ok(None);
    };
    if referrer_id == invited_id {
        return Ok(None);
    }

    // PRIMARY KEY on invited_id means an account can only ever be credited once.
    let credited = sqlx::query(
        "INSERT INTO referrals (invited_id, referrer_id) VALUES ($1, $2) ON CONFLICT DO NOTHING",
    )
    .bind(invited_id)
    .bind(referrer_id)
    .execute(&state.db)
    .await?;
    if credited.rows_affected() == 0 {
        return Ok(None);
    }

    // Skip the auto-friendship if either side has blocked the other; an invite
    // link must not be a way around a block.
    let blocked: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
            SELECT 1 FROM friend_requests
            WHERE status = 'blocked'
              AND ((sender_id = $1 AND receiver_id = $2) OR (sender_id = $2 AND receiver_id = $1))
        )
        "#,
    )
    .bind(invited_id)
    .bind(referrer_id)
    .fetch_one(&state.db)
    .await?;

    if !blocked {
        let mut tx = state.db.begin().await?;
        sqlx::query(
            r#"
            INSERT INTO friend_requests (sender_id, receiver_id, status)
            VALUES ($1, $2, 'accepted')
            ON CONFLICT (sender_id, receiver_id) DO UPDATE SET status = 'accepted'
            "#,
        )
        .bind(referrer_id)
        .bind(invited_id)
        .execute(&mut *tx)
        .await?;

        sqlx::query(
            r#"
            INSERT INTO conversations (user_a, user_b)
            VALUES (LEAST($1, $2), GREATEST($1, $2))
            ON CONFLICT (user_a, user_b) DO NOTHING
            "#,
        )
        .bind(referrer_id)
        .bind(invited_id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
    }

    publish(
        state,
        EventTarget::User(referrer_id),
        "referral.joined",
        json!({ "user_id": invited_id }),
    );

    Ok(Some(referrer_username))
}

/// The caller's invite code and how it is doing.
pub async fn get_invite(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Value>, ApiError> {
    let (code, joined): (String, i64) = sqlx::query_as(
        r#"
        SELECT p.invite_code,
               (SELECT COUNT(*) FROM referrals r WHERE r.referrer_id = p.id)
        FROM profiles p WHERE p.id = $1
        "#,
    )
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::NotFound("Profile not found.".into()))?;

    Ok(Json(json!({
        "code": code,
        "joined": joined,
    })))
}

/// Public lookup so an invite landing page can say who is inviting you.
pub async fn lookup_invite(
    State(state): State<AppState>,
    Path(code): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let row: Option<(String, i16)> =
        sqlx::query_as("SELECT username, level FROM profiles WHERE invite_code = $1")
            .bind(code.trim().to_uppercase())
            .fetch_optional(&state.db)
            .await?;

    match row {
        Some((username, level)) => Ok(Json(json!({
            "valid": true,
            "username": username,
            "level": level,
            "level_name": crate::models::level_name(level),
        }))),
        None => Ok(Json(json!({ "valid": false }))),
    }
}

pub async fn get_current_user(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<SelfProfile>, ApiError> {
    let profile = sqlx::query_as::<_, SelfProfileRow>(
        r#"
        SELECT id, username, avatar_url, is_online, last_seen, growth_points, level,
               streak_days, last_active_date, created_at
        FROM profiles WHERE id = $1
        "#,
    )
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::NotFound("Profile not found.".into()))?;

    Ok(Json(profile.into()))
}

/// Search by username.
///
/// Users who have rejected this caller twice are filtered out entirely -- not shown
/// as blocked, simply absent, so a refusal does not become a notification.
pub async fn search_users(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Query(query): Query<SearchQuery>,
) -> Result<Json<Vec<SearchResult>>, ApiError> {
    if !state
        .limits
        .allow("user-search", user.id, 60, Duration::from_secs(60))
        .await
    {
        return Err(ApiError::TooManyRequests("Too many searches. Try again shortly.".into()));
    }
    let search = query.q.unwrap_or_default().trim().to_lowercase();
    if search.len() < 2 {
        return Ok(Json(Vec::new()));
    }

    let users = sqlx::query_as::<_, UserSearchRow>(
        r#"
        SELECT
            p.id, p.username, p.avatar_url,
            CASE WHEN EXISTS (
                SELECT 1 FROM friend_requests f
                WHERE f.status = 'accepted'
                  AND ((f.sender_id = $1 AND f.receiver_id = p.id)
                    OR (f.sender_id = p.id AND f.receiver_id = $1))
            ) THEN p.is_online ELSE false END AS is_online,
            p.level,
            CASE
                WHEN EXISTS (
                    SELECT 1 FROM friend_requests f
                    WHERE f.status = 'accepted'
                      AND ((f.sender_id = $1 AND f.receiver_id = p.id)
                        OR (f.sender_id = p.id AND f.receiver_id = $1))
                ) THEN 'friends'
                WHEN EXISTS (
                    SELECT 1 FROM friend_requests f
                    WHERE f.sender_id = $1 AND f.receiver_id = p.id AND f.status = 'pending'
                ) THEN 'pending'
                WHEN EXISTS (
                    SELECT 1 FROM friend_requests f
                    WHERE f.sender_id = p.id AND f.receiver_id = $1 AND f.status = 'pending'
                ) THEN 'incoming'
                WHEN EXISTS (
                    SELECT 1 FROM friend_requests f
                    WHERE f.sender_id = $1 AND f.receiver_id = p.id AND f.status = 'rejected'
                ) THEN 'rejected'
                ELSE 'none'
            END AS friend_status,
            (
                SELECT f.attempts FROM friend_requests f
                WHERE f.sender_id = $1 AND f.receiver_id = p.id
            ) AS attempts
        FROM profiles p
        WHERE p.id <> $1
          AND p.username LIKE $2
          AND NOT EXISTS (
              SELECT 1 FROM friend_requests b
              WHERE b.sender_id = $1 AND b.receiver_id = p.id AND b.status = 'blocked'
          )
        ORDER BY (p.username = $3) DESC, p.username ASC
        LIMIT 20
        "#,
    )
    .bind(user.id)
    .bind(format!("%{search}%"))
    .bind(&search)
    .fetch_all(&state.db)
    .await?;

    Ok(Json(users.into_iter().map(SearchResult::from).collect()))
}

pub async fn get_user(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Path(user_id): Path<Uuid>,
) -> Result<Json<PublicProfile>, ApiError> {
    sqlx::query_as::<_, PublicProfile>(
        r#"
        SELECT p.id, p.username, p.avatar_url,
               CASE WHEN EXISTS (
                   SELECT 1 FROM friend_requests f
                   WHERE f.status = 'accepted'
                     AND ((f.sender_id = $1 AND f.receiver_id = p.id)
                       OR (f.sender_id = p.id AND f.receiver_id = $1))
               ) THEN p.is_online ELSE false END AS is_online,
               p.level
        FROM profiles p WHERE p.id = $2
        "#,
    )
    .bind(user.id)
    .bind(user_id)
    .fetch_optional(&state.db)
    .await?
    .map(Json)
    .ok_or_else(|| ApiError::NotFound("User not found.".into()))
}

/// The complete connection-growth path. It is served rather than duplicated in the
/// client, so every device describes a stage the same way.
pub async fn get_growth() -> Json<Value> {
    Json(json!({
        "max_stage": levels::MAX_LEVEL,
        "stages": levels::LADDER,
        "daily_growth_ceiling": growth::daily_ceiling(),
        "practices": [
            { "kind": "check_in",   "label": "An intentional daily check-in", "points": growth::POINTS_PER_CHECK_IN, "daily_cap": GrowthKind::CheckIn.daily_cap() },
            { "kind": "rhythm",     "label": "A steady connection rhythm", "points": growth::POINTS_PER_RHYTHM_DAY, "daily_cap": GrowthKind::Rhythm.daily_cap() },
            { "kind": "connection", "label": "A mutually accepted connection", "points": growth::POINTS_PER_CONNECTION, "daily_cap": GrowthKind::Connection.daily_cap() },
        ],
    }))
}

/// Whether a username is free, for live feedback on the claim screen.
pub async fn check_username(
    State(state): State<AppState>,
    Path(username): Path<String>,
) -> Result<Json<Value>, ApiError> {
    let normalized = match crate::auth::normalize_username(&username) {
        Ok(value) => value,
        // A malformed name is simply unavailable, with the reason shown inline.
        Err(ApiError::BadRequest(reason)) | Err(ApiError::Conflict(reason)) => {
            return Ok(Json(json!({ "available": false, "reason": reason })));
        }
        Err(other) => return Err(other),
    };

    let taken: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM profiles WHERE username = $1)")
        .bind(&normalized)
        .fetch_one(&state.db)
        .await?;

    Ok(Json(json!({
        "available": !taken,
        "username": normalized,
        "reason": if taken { "That username is already taken." } else { "" },
    })))
}
