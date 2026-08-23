//! Consent-first, friend-only discovery.
//!
//! Explore is deliberately not part of the encrypted messenger protocol. A card
//! is explicitly public profile data for adults who opt in; it never exposes
//! coordinates, city labels, presence, a contact graph, or any chat material.

use axum::{
    Json,
    extract::{Extension, Path, State},
};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sqlx::{FromRow, Postgres, Transaction};
use std::{collections::HashSet, time::Duration};
use uuid::Uuid;

use crate::{
    AppState,
    auth::AuthUser,
    error::ApiError,
    growth::{self, GrowthKind, POINTS_PER_CONNECTION},
    models::level_name,
    ws::{EventTarget, publish},
};

const MAX_DECK_CARDS: i64 = 12;
const MAX_DAILY_CARDS: usize = 48;
const MAX_DAILY_LIKES: usize = 24;
const INTERESTS: &[&str] = &[
    "art", "books", "building", "cooking", "film", "fitness", "games", "gardening",
    "learning", "music", "nature", "photography", "sports", "technology", "travel",
    "volunteering", "wellbeing", "writing",
];

#[derive(Debug, Deserialize)]
pub struct ExploreProfileInput {
    /// A Boolean attestation stores no date of birth, only the fact and time of
    /// a user self-attesting as an adult.
    pub adult_confirmed: bool,
    pub is_visible: bool,
    pub photo_url: Option<String>,
    pub bio: String,
    pub interests: Vec<String>,
    pub metro_area: String,
}

#[derive(Debug, Serialize, FromRow)]
pub struct ExploreProfileView {
    pub is_visible: bool,
    pub adult_attested_at: chrono::DateTime<chrono::Utc>,
    pub photo_url: Option<String>,
    pub bio: String,
    pub interests: Vec<String>,
}

#[derive(Debug, Serialize)]
pub struct ExploreProfileResponse {
    pub profile: Option<ExploreProfileView>,
    /// A metro is intentionally only a matching filter. Even a profile owner is
    /// told only whether one is configured so it cannot accidentally be copied
    /// into a public card view.
    pub metro_configured: bool,
    pub allowed_interests: &'static [&'static str],
}

#[derive(Debug, Serialize, FromRow)]
pub struct ExploreCard {
    pub id: Uuid,
    pub username: String,
    pub photo_url: Option<String>,
    pub bio: String,
    pub interests: Vec<String>,
    pub level: i16,
}

#[derive(Debug, Serialize)]
pub struct ExploreCardsResponse {
    pub cards: Vec<ExploreCard>,
    pub daily_card_limit: usize,
}

#[derive(Debug, Deserialize)]
pub struct ReportInput {
    pub reason: String,
    pub details: Option<String>,
}

#[derive(Debug, Serialize, FromRow)]
pub struct MatchView {
    pub id: Uuid,
    pub user_id: Uuid,
    pub username: String,
    pub photo_url: Option<String>,
    pub bio: String,
    pub interests: Vec<String>,
    pub conversation_id: Option<Uuid>,
    pub created_at: chrono::DateTime<chrono::Utc>,
}

fn normalize_metro(value: &str) -> Result<String, ApiError> {
    let normalized = value.trim().to_lowercase();
    let valid = normalized.chars().count() >= 2
        && normalized.chars().count() <= 64
        && normalized
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ' ' | '-' | '\''));
    if !valid {
        return Err(ApiError::BadRequest(
            "Choose a metro area using 2–64 letters, numbers, spaces, hyphens, or apostrophes. It is used only for matching and is never shown on your card.".into(),
        ));
    }
    Ok(normalized)
}

fn normalize_interests(values: Vec<String>) -> Result<Vec<String>, ApiError> {
    let allowed: HashSet<&str> = INTERESTS.iter().copied().collect();
    let mut seen = HashSet::new();
    let normalized: Vec<String> = values
        .into_iter()
        .map(|value| value.trim().to_lowercase())
        .filter(|value| seen.insert(value.clone()))
        .collect();
    if normalized.is_empty() || normalized.len() > 5 || normalized.iter().any(|value| !allowed.contains(value.as_str())) {
        return Err(ApiError::BadRequest(
            "Choose between one and five interests from Timber's controlled list.".into(),
        ));
    }
    Ok(normalized)
}

fn validate_photo(photo_url: Option<String>, visible: bool) -> Result<Option<String>, ApiError> {
    let photo_url = photo_url.map(|value| value.trim().to_owned()).filter(|value| !value.is_empty());
    if let Some(url) = &photo_url
        && (url.len() > 2_048 || !url.starts_with("https://"))
    {
        return Err(ApiError::BadRequest(
            "An Explore photo must be a public HTTPS image URL.".into(),
        ));
    }
    if visible && photo_url.is_none() {
        return Err(ApiError::BadRequest(
            "Add a public profile photo before appearing in Explore.".into(),
        ));
    }
    Ok(photo_url)
}

async fn require_actionable_target(
    tx: &mut Transaction<'_, Postgres>,
    actor_id: Uuid,
    target_id: Uuid,
) -> Result<(), ApiError> {
    if actor_id == target_id {
        return Err(ApiError::BadRequest("You cannot act on your own card.".into()));
    }
    let eligible: bool = sqlx::query_scalar(
        r#"
        SELECT EXISTS(
          SELECT 1
          FROM explore_profiles mine
          JOIN profiles mine_profile ON mine_profile.id = mine.user_id
          JOIN explore_profiles candidate
            ON candidate.user_id = $2
           AND candidate.is_visible
           AND candidate.metro_area = mine.metro_area
           AND candidate.interests && mine.interests
          WHERE mine.user_id = $1
            AND mine.is_visible
            AND mine_profile.kex_key_signature IS NOT NULL
            AND EXISTS (SELECT 1 FROM profiles WHERE id = $2 AND kex_key_signature IS NOT NULL)
            AND NOT EXISTS (
              SELECT 1 FROM explore_blocks
              WHERE (actor_id = $1 AND target_id = $2)
                 OR (actor_id = $2 AND target_id = $1)
            )
            AND NOT EXISTS (
              SELECT 1 FROM friend_requests
              WHERE (sender_id = $1 AND receiver_id = $2)
                 OR (sender_id = $2 AND receiver_id = $1)
            )
        )
        "#,
    )
    .bind(actor_id)
    .bind(target_id)
    .fetch_one(&mut **tx)
    .await?;
    if eligible { Ok(()) } else {
        Err(ApiError::NotFound("That Explore card is no longer available.".into()))
    }
}

/// Read the caller's preferences without ever returning their matching metro.
pub async fn get_profile(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ExploreProfileResponse>, ApiError> {
    let profile = sqlx::query_as::<_, ExploreProfileView>(
        "SELECT is_visible, adult_attested_at, photo_url, bio, interests FROM explore_profiles WHERE user_id = $1",
    )
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?;
    Ok(Json(ExploreProfileResponse {
        metro_configured: profile.is_some(),
        profile,
        allowed_interests: INTERESTS,
    }))
}

/// Create or change a public Explore card. Opting out immediately erases likes
/// in both directions, while intentionally preserving established friends/chat.
pub async fn put_profile(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<ExploreProfileInput>,
) -> Result<Json<ExploreProfileResponse>, ApiError> {
    if !state.limits.allow("explore-profile-edit", user.id, 6, Duration::from_secs(60 * 60)).await {
        return Err(ApiError::TooManyRequests("You have changed Explore preferences too often. Try again later.".into()));
    }
    if !input.adult_confirmed {
        return Err(ApiError::Forbidden("Explore is available only to adults who self-attest that they are 18 or older.".into()));
    }
    // The matching bucket is intentionally write-only. Allow an existing card
    // to retain it when the user edits a photo/bio or turns visibility off, but
    // require it for a first-time profile.
    let metro_area = if input.metro_area.trim().is_empty() {
        sqlx::query_scalar::<_, String>(
            "SELECT metro_area FROM explore_profiles WHERE user_id = $1",
        )
        .bind(user.id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::BadRequest(
            "Choose a metro matching area. It is used only for matching and is never shown on your card.".into(),
        ))?
    } else {
        normalize_metro(&input.metro_area)?
    };
    let interests = normalize_interests(input.interests)?;
    let photo_url = validate_photo(input.photo_url, input.is_visible)?;
    let bio = input.bio.trim().to_owned();
    if bio.chars().count() > 160 {
        return Err(ApiError::BadRequest("An Explore bio can be at most 160 characters.".into()));
    }

    let mut tx = state.db.begin().await?;
    let profile = sqlx::query_as::<_, ExploreProfileView>(
        r#"
        INSERT INTO explore_profiles
          (user_id, adult_attested_at, is_visible, photo_url, bio, metro_area, interests, updated_at)
        VALUES ($1, NOW(), $2, $3, $4, $5, $6, NOW())
        ON CONFLICT (user_id) DO UPDATE SET
          is_visible = EXCLUDED.is_visible,
          photo_url = EXCLUDED.photo_url,
          bio = EXCLUDED.bio,
          metro_area = EXCLUDED.metro_area,
          interests = EXCLUDED.interests,
          updated_at = NOW()
        RETURNING is_visible, adult_attested_at, photo_url, bio, interests
        "#,
    )
    .bind(user.id)
    .bind(input.is_visible)
    .bind(photo_url)
    .bind(bio)
    .bind(metro_area)
    .bind(interests)
    .fetch_one(&mut *tx)
    .await?;
    if !profile.is_visible {
        sqlx::query("DELETE FROM explore_likes WHERE actor_id = $1 OR target_id = $1")
            .bind(user.id)
            .execute(&mut *tx)
            .await?;
    }
    tx.commit().await?;

    Ok(Json(ExploreProfileResponse {
        metro_configured: true,
        profile: Some(profile),
        allowed_interests: INTERESTS,
    }))
}

/// A bounded, shuffled deck. `metro_area` is used only inside the query and is
/// never selected, and the exclusions prevent scraping a social graph.
pub async fn get_cards(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<ExploreCardsResponse>, ApiError> {
    if !state.limits.allow("explore-deck-refresh", user.id, 10, Duration::from_secs(60)).await
        || !state.limits.allow("explore-deck-daily", user.id, MAX_DAILY_CARDS, Duration::from_secs(60 * 60 * 24)).await {
        return Err(ApiError::TooManyRequests("Explore is paused for now. Please come back later.".into()));
    }
    let cards = sqlx::query_as::<_, ExploreCard>(
        r#"
        SELECT p.id, p.username, ep.photo_url, ep.bio, ep.interests, p.level
        FROM explore_profiles mine
        JOIN profiles mine_profile ON mine_profile.id = mine.user_id
        JOIN explore_profiles ep
          ON ep.is_visible
         AND ep.user_id <> mine.user_id
         AND ep.metro_area = mine.metro_area
         AND ep.interests && mine.interests
        JOIN profiles p ON p.id = ep.user_id
        WHERE mine.user_id = $1
          AND mine.is_visible
          AND mine_profile.kex_key_signature IS NOT NULL
          AND p.kex_key_signature IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM explore_likes l WHERE l.actor_id = $1 AND l.target_id = ep.user_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM explore_blocks b
            WHERE (b.actor_id = $1 AND b.target_id = ep.user_id)
               OR (b.actor_id = ep.user_id AND b.target_id = $1)
          )
          AND NOT EXISTS (
            SELECT 1 FROM explore_reports r WHERE r.reporter_id = $1 AND r.target_id = ep.user_id
          )
          AND NOT EXISTS (
            SELECT 1 FROM friend_requests fr
            WHERE (fr.sender_id = $1 AND fr.receiver_id = ep.user_id)
               OR (fr.sender_id = ep.user_id AND fr.receiver_id = $1)
          )
        ORDER BY md5(ep.user_id::text || CURRENT_DATE::text || $1::text)
        LIMIT $2
        "#,
    )
    .bind(user.id)
    .bind(MAX_DECK_CARDS)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(ExploreCardsResponse { cards, daily_card_limit: MAX_DAILY_CARDS }))
}

pub async fn like_card(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Path(target_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    if !state.limits.allow("explore-like", user.id, MAX_DAILY_LIKES, Duration::from_secs(60 * 60 * 24)).await {
        return Err(ApiError::TooManyRequests("You have reached today's Explore like limit.".into()));
    }
    let mut tx = state.db.begin().await?;
    // Serialize pair mutations, avoiding a manual friend request racing a mutual
    // like into duplicate relationships.
    sqlx::query("SELECT pg_advisory_xact_lock(hashtext(LEAST($1::text, $2::text) || ':' || GREATEST($1::text, $2::text)))")
        .bind(user.id)
        .bind(target_id)
        .execute(&mut *tx)
        .await?;
    require_actionable_target(&mut tx, user.id, target_id).await?;
    sqlx::query(
        r#"INSERT INTO explore_likes (actor_id, target_id, decision, created_at, updated_at)
           VALUES ($1, $2, 'liked', NOW(), NOW())
           ON CONFLICT (actor_id, target_id) DO UPDATE SET decision = 'liked', updated_at = NOW()"#,
    )
    .bind(user.id)
    .bind(target_id)
    .execute(&mut *tx)
    .await?;
    let reciprocal: bool = sqlx::query_scalar(
        "SELECT EXISTS(SELECT 1 FROM explore_likes WHERE actor_id = $1 AND target_id = $2 AND decision = 'liked')",
    )
    .bind(target_id)
    .bind(user.id)
    .fetch_one(&mut *tx)
    .await?;

    let mut conversation_id = None;
    if reciprocal {
        let created_match: Option<Uuid> = sqlx::query_scalar(
            r#"INSERT INTO explore_matches (user_a, user_b)
               VALUES (LEAST($1, $2), GREATEST($1, $2))
               ON CONFLICT (user_a, user_b) DO NOTHING
               RETURNING id"#,
        )
        .bind(user.id)
        .bind(target_id)
        .fetch_optional(&mut *tx)
        .await?;
        if created_match.is_some() {
            sqlx::query(
                "INSERT INTO friend_requests (sender_id, receiver_id, status, attempts) VALUES ($1, $2, 'accepted', 1)",
            )
            .bind(user.id)
            .bind(target_id)
            .execute(&mut *tx)
            .await?;
            let created_conversation_id: Uuid = sqlx::query_scalar(
                r#"INSERT INTO conversations (user_a, user_b)
                   VALUES (LEAST($1, $2), GREATEST($1, $2))
                   ON CONFLICT (user_a, user_b) DO UPDATE SET user_a = conversations.user_a
                   RETURNING id"#,
            )
            .bind(user.id)
            .bind(target_id)
            .fetch_one(&mut *tx)
            .await?;
            conversation_id = Some(created_conversation_id);
        }
    }
    tx.commit().await?;

    let matched = conversation_id.is_some();
    if let Some(conversation_id) = conversation_id {
        // Mutual consent created the exact same accepted-friend / conversation
        // relationship used everywhere else; normal key attestation remains in
        // the client sync path before it can encrypt a message.
        for participant in [user.id, target_id] {
            let award = growth::award(&state.db, participant, GrowthKind::Connection, POINTS_PER_CONNECTION).await?;
            if let Some(level) = award.promoted_to {
                publish(&state, EventTarget::User(participant), "growth.stage_reached", json!({ "level": level, "name": level_name(level) }));
            }
        }
        let target_name: Option<String> = sqlx::query_scalar("SELECT username FROM profiles WHERE id = $1")
            .bind(target_id).fetch_optional(&state.db).await?;
        publish(&state, EventTarget::User(target_id), "friend.accepted", json!({ "by": user.id, "username": user.username, "conversation_id": conversation_id }));
        publish(&state, EventTarget::User(user.id), "explore.matched", json!({ "with": target_id, "username": target_name, "conversation_id": conversation_id }));
    }
    Ok(Json(json!({
        "liked": true,
        "matched": matched,
        "conversation_id": conversation_id,
    })))
}

pub async fn pass_card(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Path(target_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    if !state.limits.allow("explore-pass", user.id, 72, Duration::from_secs(60 * 60 * 24)).await {
        return Err(ApiError::TooManyRequests("Explore is paused for now. Please come back later.".into()));
    }
    let mut tx = state.db.begin().await?;
    require_actionable_target(&mut tx, user.id, target_id).await?;
    sqlx::query(
        r#"INSERT INTO explore_likes (actor_id, target_id, decision, created_at, updated_at)
           VALUES ($1, $2, 'passed', NOW(), NOW())
           ON CONFLICT (actor_id, target_id) DO UPDATE SET decision = 'passed', updated_at = NOW()"#,
    )
    .bind(user.id).bind(target_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({ "passed": true })))
}

pub async fn block_card(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Path(target_id): Path<Uuid>,
) -> Result<Json<Value>, ApiError> {
    if target_id == user.id { return Err(ApiError::BadRequest("You cannot block yourself.".into())); }
    let mut tx = state.db.begin().await?;
    let exists: bool = sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM profiles WHERE id = $1)")
        .bind(target_id).fetch_one(&mut *tx).await?;
    if !exists { return Err(ApiError::NotFound("User not found.".into())); }
    sqlx::query("INSERT INTO explore_blocks (actor_id, target_id) VALUES ($1, $2) ON CONFLICT DO NOTHING")
        .bind(user.id).bind(target_id).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM explore_likes WHERE (actor_id = $1 AND target_id = $2) OR (actor_id = $2 AND target_id = $1)")
        .bind(user.id).bind(target_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({ "blocked": true })))
}

pub async fn report_card(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Path(target_id): Path<Uuid>,
    Json(input): Json<ReportInput>,
) -> Result<Json<Value>, ApiError> {
    if !state.limits.allow("explore-report", user.id, 10, Duration::from_secs(60 * 60)).await {
        return Err(ApiError::TooManyRequests("Too many reports. Please try again later.".into()));
    }
    if target_id == user.id { return Err(ApiError::BadRequest("You cannot report yourself.".into())); }
    let reason = input.reason.trim().to_lowercase();
    if !matches!(reason.as_str(), "harassment" | "impersonation" | "unsafe" | "other") {
        return Err(ApiError::BadRequest("Choose a report reason from the provided list.".into()));
    }
    let details = input.details.map(|value| value.trim().to_owned()).filter(|value| !value.is_empty());
    if details.as_ref().is_some_and(|value| value.chars().count() > 500) {
        return Err(ApiError::BadRequest("Report details can be at most 500 characters.".into()));
    }
    let mut tx = state.db.begin().await?;
    require_actionable_target(&mut tx, user.id, target_id).await?;
    sqlx::query("INSERT INTO explore_reports (reporter_id, target_id, reason, details) VALUES ($1, $2, $3, $4)")
        .bind(user.id).bind(target_id).bind(reason).bind(details).execute(&mut *tx).await?;
    sqlx::query("DELETE FROM explore_likes WHERE actor_id = $1 AND target_id = $2")
        .bind(user.id).bind(target_id).execute(&mut *tx).await?;
    tx.commit().await?;
    Ok(Json(json!({ "reported": true })))
}

pub async fn get_matches(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<Value>, ApiError> {
    let matches = sqlx::query_as::<_, MatchView>(
        r#"
        SELECT m.id,
               CASE WHEN m.user_a = $1 THEN m.user_b ELSE m.user_a END AS user_id,
               p.username, ep.photo_url, ep.bio, ep.interests, c.id AS conversation_id, m.created_at
        FROM explore_matches m
        JOIN profiles p ON p.id = CASE WHEN m.user_a = $1 THEN m.user_b ELSE m.user_a END
        LEFT JOIN explore_profiles ep ON ep.user_id = p.id
        LEFT JOIN conversations c ON c.user_a = LEAST($1, p.id) AND c.user_b = GREATEST($1, p.id)
        WHERE m.user_a = $1 OR m.user_b = $1
        ORDER BY m.created_at DESC
        "#,
    )
    .bind(user.id)
    .fetch_all(&state.db)
    .await?;
    Ok(Json(json!({ "matches": matches })))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn metro_is_a_hidden_matching_token_not_coordinates() {
        assert_eq!(normalize_metro("  Lagos-West ").unwrap(), "lagos-west");
        assert!(normalize_metro("6.5244,3.3792").is_err());
        assert!(normalize_metro("x").is_err());
    }

    #[test]
    fn interests_are_controlled_deduplicated_and_bounded() {
        assert_eq!(
            normalize_interests(vec!["Books".into(), "books".into(), "Music".into()]).unwrap(),
            vec!["books", "music"]
        );
        assert!(normalize_interests(vec!["unknown".into()]).is_err());
        assert!(normalize_interests(vec!["art".into(), "books".into(), "building".into(), "cooking".into(), "film".into(), "fitness".into()]).is_err());
    }

    #[test]
    fn card_serialization_has_no_presence_or_location_fields() {
        let card = ExploreCard {
            id: Uuid::nil(),
            username: "cedar".into(),
            photo_url: Some("https://images.example/cedar.jpg".into()),
            bio: "Reading and walks".into(),
            interests: vec!["books".into()],
            level: 1,
        };
        let value = serde_json::to_value(card).unwrap();
        let object = value.as_object().unwrap();
        assert_eq!(object.len(), 6);
        for expected in ["id", "username", "photo_url", "bio", "interests", "level"] {
            assert!(object.contains_key(expected));
        }
        for forbidden in ["metro_area", "latitude", "longitude", "distance", "is_online", "last_seen", "safety_number", "friends"] {
            assert!(!object.contains_key(forbidden));
        }
    }
}
