//! Profiles, search, and the connection-growth path.

use axum::{
    Json,
    extract::{Extension, Path, Query, State},
};
use serde::Deserialize;
use serde_json::{Value, json};
use std::time::Duration;
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    error::ApiError,
    growth::{self, GrowthKind},
    levels,
    streaks,
    models::{
        PublicProfile, SearchQuery, SearchResult, SelfProfile, SelfProfileRow, UserSearchRow,
    },
    ws::{EventTarget, publish},
};

/// Redeem an invite code for a freshly created account.
///
/// An invite starts both people as friends, unless somebody has blocked the other,
/// and credits the inviter with referral growth. Returns the inviter's username.
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

    // Referrals earn growth now. This is the source most worth faking, so it
    // leans on two things that were already true: the referrals PRIMARY KEY
    // makes the credit exactly-once per invited account, and the daily cap in
    // growth_daily bounds how fast a signup farm could pay off.
    growth::award(
        &state.db,
        referrer_id,
        GrowthKind::Referral,
        growth::POINTS_PER_REFERRAL,
    )
    .await?;

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
    if !state
        .limits
        .allow("invite-lookup-global", "all", 300, Duration::from_secs(60))
        .await
    {
        return Err(ApiError::TooManyRequests(
            "Too many invite checks. Try again shortly.".into(),
        ));
    }
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

/// The non-custodial account name and its public keys are intentionally
/// immutable. This endpoint changes only the optional profile image, which is
/// ordinary account metadata rather than encrypted chat content.
#[derive(Deserialize)]
pub struct UpdateProfileInput {
    pub avatar_url: Option<String>,
}

fn normalize_avatar_url(value: Option<String>) -> Result<Option<String>, ApiError> {
    let Some(value) = value else {
        return Ok(None);
    };
    let value = value.trim();
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 2048 {
        return Err(ApiError::BadRequest(
            "Profile photo URL is too long.".into(),
        ));
    }

    let parsed = reqwest::Url::parse(value)
        .map_err(|_| ApiError::BadRequest("Use a valid HTTPS profile photo URL.".into()))?;
    if parsed.scheme() != "https"
        || parsed.host_str().is_none()
        || !parsed.username().is_empty()
        || parsed.password().is_some()
    {
        return Err(ApiError::BadRequest(
            "Profile photos must use a valid HTTPS URL without embedded credentials.".into(),
        ));
    }
    Ok(Some(value.to_owned()))
}

/// People are shown as `@username` throughout the UI. Accept that natural
/// search form as well as the bare username without making `@` part of the
/// database lookup.
fn normalize_user_search(value: Option<String>) -> String {
    value
        .unwrap_or_default()
        .trim()
        .trim_start_matches('@')
        .to_lowercase()
}

pub async fn update_current_user(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<UpdateProfileInput>,
) -> Result<Json<SelfProfile>, ApiError> {
    if !state
        .limits
        .allow("profile-edit", user.id, 12, Duration::from_secs(60 * 60))
        .await
    {
        return Err(ApiError::TooManyRequests(
            "Too many profile changes. Try again later.".into(),
        ));
    }
    let avatar_url = normalize_avatar_url(input.avatar_url)?;
    let profile = sqlx::query_as::<_, SelfProfileRow>(
        r#"
        UPDATE profiles
        SET avatar_url = $2
        WHERE id = $1
        RETURNING id, username, avatar_url, is_online, last_seen, growth_points, level,
                  streak_days, last_active_date, created_at
        "#,
    )
    .bind(user.id)
    .bind(avatar_url)
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
    let search = normalize_user_search(query.q);
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

/// The complete connection-growth path. It is protected rather than public so
/// anonymous callers cannot scrape progression and daily-cap metadata.
pub async fn get_growth(Extension(_user): Extension<AuthUser>) -> Json<Value> {
    Json(json!({
        "max_stage": levels::MAX_LEVEL,
        "stages": levels::LADDER,
        "daily_growth_ceiling": growth::daily_ceiling(),
        "practices": [
            { "kind": "check_in",   "label": "An intentional daily check-in", "points": growth::POINTS_PER_CHECK_IN, "daily_cap": GrowthKind::CheckIn.daily_cap() },
            { "kind": "rhythm",     "label": "A steady connection rhythm", "points": growth::POINTS_PER_RHYTHM_DAY, "daily_cap": GrowthKind::Rhythm.daily_cap() },
            { "kind": "connection", "label": "A mutually accepted connection", "points": growth::POINTS_PER_CONNECTION, "daily_cap": GrowthKind::Connection.daily_cap() },
            { "kind": "message",    "label": "Talking to someone", "points": growth::POINTS_PER_MESSAGE, "daily_cap": GrowthKind::Message.daily_cap() },
            { "kind": "streak",     "label": "Keeping a streak alive", "points": growth::POINTS_PER_STREAK_DAY, "daily_cap": GrowthKind::Streak.daily_cap() },
            { "kind": "referral",   "label": "Someone joined through you", "points": growth::POINTS_PER_REFERRAL, "daily_cap": GrowthKind::Referral.daily_cap() },
        ],
    }))
}

/// Every live streak this account holds, for the flame on each chat row.
pub async fn get_streaks(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Value>, ApiError> {
    let streaks = streaks::for_user(&state.db, user.id).await?;
    Ok(Json(json!({
        "streaks": streaks
            .into_iter()
            .map(|(peer_id, streak)| json!({
                "peer_id": peer_id,
                "days": streak.days,
                "extended_today": streak.extended_today,
                "at_risk": streak.at_risk,
            }))
            .collect::<Vec<_>>(),
    })))
}

#[derive(Deserialize)]
pub struct LeaderboardOptIn {
    pub opted_in: bool,
}

/// Join or leave the public ranking.
///
/// Growth points were private until this release; a leaderboard makes them
/// comparable between accounts, which is a disclosure rather than a display
/// choice. So it is off by default and reversible.
pub async fn set_leaderboard_opt_in(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<LeaderboardOptIn>,
) -> Result<Json<Value>, ApiError> {
    sqlx::query("UPDATE profiles SET leaderboard_opt_in = $2 WHERE id = $1")
        .bind(user.id)
        .bind(input.opted_in)
        .execute(&state.db)
        .await?;
    Ok(Json(json!({ "opted_in": input.opted_in })))
}

/// The top of the public ranking, plus where this account sits in it.
pub async fn get_leaderboard(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Value>, ApiError> {
    // Only opted-in rows are ever readable here, so someone who has not joined
    // is absent from the list rather than merely unranked.
    let rows: Vec<(Uuid, String, Option<String>, i64, i16)> = sqlx::query_as(
        r#"
        SELECT id, username, avatar_url, growth_points, level
        FROM profiles
        WHERE leaderboard_opt_in = TRUE
        ORDER BY growth_points DESC, username ASC
        LIMIT 100
        "#,
    )
    .fetch_all(&state.db)
    .await?;

    let (opted_in, rank): (bool, Option<i64>) = sqlx::query_as(
        r#"
        SELECT
            p.leaderboard_opt_in,
            CASE WHEN p.leaderboard_opt_in THEN (
                SELECT COUNT(*) + 1 FROM profiles other
                WHERE other.leaderboard_opt_in = TRUE
                  AND other.growth_points > p.growth_points
            ) END
        FROM profiles p
        WHERE p.id = $1
        "#,
    )
    .bind(user.id)
    .fetch_one(&state.db)
    .await?;

    Ok(Json(json!({
        "opted_in": opted_in,
        "rank": rank,
        "entries": rows
            .into_iter()
            .enumerate()
            .map(|(index, (id, username, avatar_url, growth_points, level))| json!({
                "position": index + 1,
                "id": id,
                "username": username,
                "avatar_url": avatar_url,
                "growth_points": growth_points,
                "level": level,
                "level_name": crate::models::level_name(level),
                "is_me": id == user.id,
            }))
            .collect::<Vec<_>>(),
    })))
}

#[cfg(test)]
mod tests {
    use super::{normalize_avatar_url, normalize_user_search};

    #[test]
    fn profile_photo_accepts_only_safe_https_urls() {
        assert_eq!(
            normalize_avatar_url(Some(" https://images.example/avatar.png ".into())).unwrap(),
            Some("https://images.example/avatar.png".into()),
        );
        assert_eq!(normalize_avatar_url(Some("  ".into())).unwrap(), None);
        assert!(normalize_avatar_url(Some("http://images.example/avatar.png".into())).is_err());
        assert!(
            normalize_avatar_url(Some("https://user:pass@images.example/avatar.png".into()))
                .is_err()
        );
        assert!(normalize_avatar_url(Some("not a URL".into())).is_err());
    }

    #[test]
    fn people_search_accepts_a_displayed_at_username() {
        assert_eq!(normalize_user_search(Some("  @Mango_Tree ".into())), "mango_tree");
        assert_eq!(normalize_user_search(Some("mango_tree".into())), "mango_tree");
    }
}
