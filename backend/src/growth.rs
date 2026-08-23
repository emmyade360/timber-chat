//! Connection-growth progression.
//!
//! Growth is deliberately not a measure of a person's health or worth. It is a
//! gentle record of sustainable, consent-based connection: one intentional check-in
//! per day, a small rhythm bonus, and mutually accepted friendships. The relay never
//! examines message text, and neither message volume nor time spent online earns
//! points.

use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{error::ApiError, levels};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GrowthKind {
    /// The first intentional conversation activity of a calendar day.
    CheckIn,
    /// A small, capped bonus for returning steadily. Missing a day resets the
    /// rhythm, but never removes points already earned.
    Rhythm,
    /// A friendship that both people explicitly accepted.
    Connection,
}

impl GrowthKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CheckIn => "check_in",
            Self::Rhythm => "rhythm",
            Self::Connection => "connection",
        }
    }

    /// Maximum growth points this practice can contribute in one calendar day.
    pub fn daily_cap(self) -> i32 {
        match self {
            Self::CheckIn => 30,
            Self::Rhythm => 14,
            Self::Connection => 60,
        }
    }
}

pub const POINTS_PER_CHECK_IN: i32 = 30;
pub const POINTS_PER_RHYTHM_DAY: i32 = 2;
pub const MAX_RHYTHM_BONUS: i32 = 14;
pub const POINTS_PER_CONNECTION: i32 = 30;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct GrowthAward {
    /// Points actually granted after the daily cap was applied.
    pub granted: i32,
    pub total_growth: i64,
    pub level: i16,
    /// Set when this award crossed a growth-stage boundary.
    pub promoted_to: Option<i16>,
}

/// Grant connection-growth points, clamped to the source's daily cap.
///
/// The clamp happens inside a single upsert so concurrent activity cannot inflate a
/// daily practice. Only metadata required for routing and friendship is used.
pub async fn award(
    db: &PgPool,
    user_id: Uuid,
    kind: GrowthKind,
    points: i32,
) -> Result<GrowthAward, ApiError> {
    let cap = kind.daily_cap();

    let granted: i32 = sqlx::query_scalar(
        r#"
        WITH prior AS (
            SELECT points FROM growth_daily
            WHERE user_id = $1 AND day = CURRENT_DATE AND kind = $2
        ),
        upserted AS (
            INSERT INTO growth_daily (user_id, day, kind, points)
            VALUES ($1, CURRENT_DATE, $2, LEAST($3, $4))
            ON CONFLICT (user_id, day, kind)
            DO UPDATE SET points = LEAST(growth_daily.points + $3, $4)
            RETURNING points
        )
        SELECT upserted.points - COALESCE((SELECT points FROM prior), 0) FROM upserted
        "#,
    )
    .bind(user_id)
    .bind(kind.as_str())
    .bind(points.max(0))
    .bind(cap)
    .fetch_one(db)
    .await?;

    if granted <= 0 {
        let (total_growth, level): (i64, i16) =
            sqlx::query_as("SELECT growth_points, level FROM profiles WHERE id = $1")
                .bind(user_id)
                .fetch_one(db)
                .await?;
        return Ok(GrowthAward {
            granted: 0,
            total_growth,
            level,
            promoted_to: None,
        });
    }

    let (total_growth, previous_level): (i64, i16) = sqlx::query_as(
        "UPDATE profiles SET growth_points = growth_points + $2 WHERE id = $1 RETURNING growth_points, level",
    )
    .bind(user_id)
    .bind(i64::from(granted))
    .fetch_one(db)
    .await?;

    let level = levels::level_for_growth(total_growth);
    let promoted_to = if level > previous_level {
        sqlx::query("UPDATE profiles SET level = $2 WHERE id = $1")
            .bind(user_id)
            .bind(level)
            .execute(db)
            .await?;
        Some(level)
    } else {
        None
    };

    Ok(GrowthAward {
        granted,
        total_growth,
        level,
        promoted_to,
    })
}

/// Record an intentional daily check-in and a bounded consistency bonus.
pub async fn touch_connection(db: &PgPool, user_id: Uuid) -> Result<Vec<GrowthAward>, ApiError> {
    let streak_days: i32 = sqlx::query_scalar(
        r#"
        UPDATE profiles
        SET streak_days = CASE
                WHEN last_active_date = CURRENT_DATE THEN streak_days
                WHEN last_active_date = CURRENT_DATE - 1 THEN streak_days + 1
                ELSE 1
            END,
            last_active_date = CURRENT_DATE
        WHERE id = $1
        RETURNING streak_days
        "#,
    )
    .bind(user_id)
    .fetch_one(db)
    .await?;

    Ok(vec![
        award(db, user_id, GrowthKind::CheckIn, POINTS_PER_CHECK_IN).await?,
        award(
            db,
            user_id,
            GrowthKind::Rhythm,
            (streak_days.saturating_mul(POINTS_PER_RHYTHM_DAY)).min(MAX_RHYTHM_BONUS),
        )
        .await?,
    ])
}

/// The maximum ordinary growth a day can yield. New connections are intentionally
/// excluded: they are a welcome milestone, not a target to optimize for.
pub fn daily_ceiling() -> i32 {
    [GrowthKind::CheckIn, GrowthKind::Rhythm]
        .iter()
        .map(|kind| kind.daily_cap())
        .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_practice_is_capped() {
        for kind in [GrowthKind::CheckIn, GrowthKind::Rhythm, GrowthKind::Connection] {
            assert!(kind.daily_cap() > 0, "{kind:?} must have a cap");
        }
    }

    #[test]
    fn practice_names_are_stable() {
        // These values are primary-key values in growth_daily.
        assert_eq!(GrowthKind::CheckIn.as_str(), "check_in");
        assert_eq!(GrowthKind::Rhythm.as_str(), "rhythm");
        assert_eq!(GrowthKind::Connection.as_str(), "connection");
    }

    #[test]
    fn ordinary_growth_is_steady_not_grindable() {
        assert_eq!(daily_ceiling(), 44);
        let evergreen = levels::tier(levels::MAX_LEVEL).unwrap().threshold;
        let days = evergreen / i64::from(daily_ceiling());
        assert!(
            (280..=360).contains(&days),
            "the top stage should take roughly a year of steady connection, got {days} days"
        );
    }

    #[test]
    fn rhythm_bonus_is_bounded() {
        assert_eq!(MAX_RHYTHM_BONUS, GrowthKind::Rhythm.daily_cap());
    }
}
