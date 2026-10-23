//! Growth progression.
//!
//! This module used to implement the opposite of what it does now. Growth was
//! built to resist engagement loops: 44 points a day, about a year to the top
//! stage, and explicitly nothing for message volume, popularity or referrals.
//! That was a deliberate product stance and it has been deliberately reversed --
//! sending, returning, keeping streaks and bringing people in all earn now.
//!
//! Two things survive the change, because they are correctness rather than
//! philosophy:
//!
//!   * Daily caps. Not to keep growth "gentle", but because uncapped points are
//!     farmable -- two accounts messaging each other in a loop would otherwise
//!     mint an unbounded score, and a leaderboard makes that worth doing.
//!   * The relay still never reads message content. Growth is awarded for the
//!     fact that an envelope was sent, never for anything inside it.

use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::{error::ApiError, levels};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GrowthKind {
    /// The first conversation activity of a calendar day.
    CheckIn,
    /// A bonus for returning steadily. Missing a day resets the rhythm, but
    /// never removes points already earned.
    Rhythm,
    /// A friendship that both people explicitly accepted.
    Connection,
    /// Sending an envelope. Capped, because a pair of accounts can trade
    /// messages as fast as the rate limiter allows.
    Message,
    /// Keeping a per-friendship streak alive, worth more the longer it runs.
    Streak,
    /// Someone joined through this account's invite.
    Referral,
}

impl GrowthKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::CheckIn => "check_in",
            Self::Rhythm => "rhythm",
            Self::Connection => "connection",
            Self::Message => "message",
            Self::Streak => "streak",
            Self::Referral => "referral",
        }
    }

    /// Maximum growth points this source can contribute in one calendar day.
    ///
    /// These are anti-farming limits, not pacing. Each is set well above what
    /// ordinary use reaches, so a real person never feels it and a scripted
    /// pair of accounts does.
    pub fn daily_cap(self) -> i32 {
        match self {
            Self::CheckIn => 30,
            Self::Rhythm => 50,
            Self::Connection => 100,
            Self::Message => 120,
            Self::Streak => 150,
            Self::Referral => 1_000,
        }
    }
}

pub const POINTS_PER_CHECK_IN: i32 = 30;
pub const POINTS_PER_RHYTHM_DAY: i32 = 5;
pub const MAX_RHYTHM_BONUS: i32 = 50;
pub const POINTS_PER_CONNECTION: i32 = 50;
/// Per envelope sent. Small on purpose: the cap is reached by a normal day of
/// conversation, so the reward is for talking to people, not for volume.
pub const POINTS_PER_MESSAGE: i32 = 2;
/// Per day of a live streak, so a long streak is worth protecting.
pub const POINTS_PER_STREAK_DAY: i32 = 5;
/// Per account that joins through an invite.
pub const POINTS_PER_REFERRAL: i32 = 250;

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

/// The most an active day yields without new connections or referrals, which
/// are milestones rather than something to plan a day around.
pub fn daily_ceiling() -> i32 {
    [
        GrowthKind::CheckIn,
        GrowthKind::Rhythm,
        GrowthKind::Message,
        GrowthKind::Streak,
    ]
    .iter()
    .map(|kind| kind.daily_cap())
    .sum()
}

#[cfg(test)]
mod tests {
    use super::*;

    // Every source stays capped. Not for pacing -- for the leaderboard, which
    // turns any uncapped source into something worth scripting.
    #[test]
    fn every_source_is_capped() {
        for kind in [
            GrowthKind::CheckIn,
            GrowthKind::Rhythm,
            GrowthKind::Connection,
            GrowthKind::Message,
            GrowthKind::Streak,
            GrowthKind::Referral,
        ] {
            assert!(kind.daily_cap() > 0, "{kind:?} must have a cap");
        }
    }

    #[test]
    fn source_names_are_stable() {
        // These values are primary-key values in growth_daily; renaming one
        // silently resets every existing daily subtotal under the old name.
        assert_eq!(GrowthKind::CheckIn.as_str(), "check_in");
        assert_eq!(GrowthKind::Rhythm.as_str(), "rhythm");
        assert_eq!(GrowthKind::Connection.as_str(), "connection");
        assert_eq!(GrowthKind::Message.as_str(), "message");
        assert_eq!(GrowthKind::Streak.as_str(), "streak");
        assert_eq!(GrowthKind::Referral.as_str(), "referral");
    }

    // The curve this release is tuned to. The old assertion here demanded
    // roughly a year to the top stage; the product now wants a visible climb,
    // so the same test pins the new intent instead of being deleted.
    #[test]
    fn an_engaged_day_makes_visible_progress() {
        assert_eq!(daily_ceiling(), 350);
        let top = levels::tier(levels::MAX_LEVEL).unwrap().threshold;
        let days = top / i64::from(daily_ceiling());
        assert!(
            (30..=60).contains(&days),
            "the top stage should take one to two months of heavy use, got {days} days"
        );
    }

    // A casual user -- checking in, a short streak, a few messages -- should
    // still cross the early stages quickly enough to notice.
    #[test]
    fn a_casual_day_still_moves_the_bar() {
        let casual = POINTS_PER_CHECK_IN + POINTS_PER_STREAK_DAY + POINTS_PER_MESSAGE * 5;
        let second_stage = levels::LADDER[1].threshold;
        assert!(
            i64::from(casual) >= second_stage,
            "one ordinary day should clear the first stage, got {casual}"
        );
    }

    #[test]
    fn rhythm_bonus_is_bounded() {
        assert_eq!(MAX_RHYTHM_BONUS, GrowthKind::Rhythm.daily_cap());
    }

    // Referrals are the one source worth real points, so they are also the one
    // most worth faking. The cap is what stops a scripted signup farm.
    #[test]
    fn referrals_are_generous_but_bounded() {
        const { assert!(POINTS_PER_REFERRAL > POINTS_PER_CONNECTION) };
        let per_day = GrowthKind::Referral.daily_cap() / POINTS_PER_REFERRAL;
        assert!((1..=8).contains(&per_day), "got {per_day} referrals a day");
    }
}
