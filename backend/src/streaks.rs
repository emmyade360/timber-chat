//! Per-friendship streaks.
//!
//! A streak belongs to a pair of people rather than to one of them, and it only
//! advances on a day both of them sent something. That is the mechanic Snapchat
//! demonstrated is the strongest retention loop in messaging, and it fits this
//! product exactly as it stands: it needs no group support and no access to
//! message content, only the fact that an envelope was sent.
//!
//! The relay still learns nothing it did not already know. Sending a message is
//! already routing metadata; a streak is a count of days on which that happened
//! in both directions.

use chrono::NaiveDate;
use serde::Serialize;
use sqlx::PgPool;
use uuid::Uuid;

use crate::error::ApiError;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Streak {
    /// Consecutive days both people sent something.
    pub days: i32,
    /// True when today is already counted, so the UI can stop nagging.
    pub extended_today: bool,
    /// True when the streak lapses at the end of today unless both send.
    pub at_risk: bool,
}

/// Order a pair the way the table's CHECK constraint requires.
pub fn canonical(one: Uuid, two: Uuid) -> (Uuid, Uuid) {
    if one <= two { (one, two) } else { (two, one) }
}

/// A streak is live if both sides sent today or yesterday; older than that it has lapsed.
fn project(days: i32, last_mutual: Option<NaiveDate>, today: NaiveDate) -> Streak {
    let Some(last) = last_mutual else {
        return Streak { days: 0, extended_today: false, at_risk: false };
    };
    if last == today {
        Streak { days, extended_today: true, at_risk: false }
    } else if last == today.pred_opt().unwrap_or(today) {
        // Yesterday counted, so the streak stands -- but only until midnight.
        Streak { days, extended_today: false, at_risk: true }
    } else {
        Streak { days: 0, extended_today: false, at_risk: false }
    }
}

/// Record that `sender` sent to `peer` today, advancing the streak if both have.
///
/// The whole decision happens inside one statement so two people sending at the
/// same moment cannot both observe "the other has not sent yet" and skip the
/// increment, or both apply it and count the day twice.
pub async fn touch(db: &PgPool, sender: Uuid, peer: Uuid) -> Result<Streak, ApiError> {
    let (user_a, user_b) = canonical(sender, peer);
    let sender_is_a = sender == user_a;

    let row: (i32, Option<NaiveDate>, NaiveDate) = sqlx::query_as(
        r#"
        INSERT INTO friendship_streaks (user_a, user_b, days, last_mutual_day, a_sent_on, b_sent_on)
        VALUES (
            $1, $2, 0, NULL,
            CASE WHEN $3 THEN CURRENT_DATE ELSE NULL END,
            CASE WHEN $3 THEN NULL ELSE CURRENT_DATE END
        )
        ON CONFLICT (user_a, user_b) DO UPDATE SET
            a_sent_on = CASE WHEN $3 THEN CURRENT_DATE ELSE friendship_streaks.a_sent_on END,
            b_sent_on = CASE WHEN $3 THEN friendship_streaks.b_sent_on ELSE CURRENT_DATE END,
            days = CASE
                -- Both sides have now sent today, and today is not yet counted.
                WHEN COALESCE(friendship_streaks.last_mutual_day, DATE '0001-01-01') < CURRENT_DATE
                     AND (CASE WHEN $3 THEN CURRENT_DATE ELSE friendship_streaks.a_sent_on END) = CURRENT_DATE
                     AND (CASE WHEN $3 THEN friendship_streaks.b_sent_on ELSE CURRENT_DATE END) = CURRENT_DATE
                THEN CASE
                    WHEN friendship_streaks.last_mutual_day = CURRENT_DATE - 1
                    THEN friendship_streaks.days + 1
                    ELSE 1
                END
                ELSE friendship_streaks.days
            END,
            last_mutual_day = CASE
                WHEN COALESCE(friendship_streaks.last_mutual_day, DATE '0001-01-01') < CURRENT_DATE
                     AND (CASE WHEN $3 THEN CURRENT_DATE ELSE friendship_streaks.a_sent_on END) = CURRENT_DATE
                     AND (CASE WHEN $3 THEN friendship_streaks.b_sent_on ELSE CURRENT_DATE END) = CURRENT_DATE
                THEN CURRENT_DATE
                ELSE friendship_streaks.last_mutual_day
            END,
            updated_at = NOW()
        RETURNING days, last_mutual_day, CURRENT_DATE
        "#,
    )
    .bind(user_a)
    .bind(user_b)
    .bind(sender_is_a)
    .fetch_one(db)
    .await?;

    Ok(project(row.0, row.1, row.2))
}

/// Every live streak this account holds, keyed by the other person.
pub async fn for_user(db: &PgPool, user_id: Uuid) -> Result<Vec<(Uuid, Streak)>, ApiError> {
    let rows: Vec<(Uuid, Uuid, i32, Option<NaiveDate>, NaiveDate)> = sqlx::query_as(
        r#"
        SELECT user_a, user_b, days, last_mutual_day, CURRENT_DATE
        FROM friendship_streaks
        WHERE (user_a = $1 OR user_b = $1)
          AND last_mutual_day >= CURRENT_DATE - 1
        "#,
    )
    .bind(user_id)
    .fetch_all(db)
    .await?;

    Ok(rows
        .into_iter()
        .map(|(user_a, user_b, days, last_mutual, today)| {
            let peer = if user_a == user_id { user_b } else { user_a };
            (peer, project(days, last_mutual, today))
        })
        .filter(|(_, streak)| streak.days > 0)
        .collect())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn day(year: i32, month: u32, date: u32) -> NaiveDate {
        NaiveDate::from_ymd_opt(year, month, date).expect("valid date")
    }

    #[test]
    fn a_pair_orders_the_same_way_from_either_side() {
        let one = Uuid::from_u128(1);
        let two = Uuid::from_u128(2);
        assert_eq!(canonical(one, two), canonical(two, one));
        assert_eq!(canonical(one, two), (one, two));
    }

    #[test]
    fn a_streak_with_no_mutual_day_is_not_a_streak() {
        let streak = project(0, None, day(2026, 9, 2));
        assert_eq!(streak.days, 0);
        assert!(!streak.at_risk);
    }

    #[test]
    fn today_counted_means_nothing_is_at_risk() {
        let today = day(2026, 9, 2);
        let streak = project(7, Some(today), today);
        assert_eq!(streak.days, 7);
        assert!(streak.extended_today);
        assert!(!streak.at_risk);
    }

    // The nudge the whole mechanic runs on: yesterday counted, today has not,
    // so this is the streak that a reminder is worth sending about.
    #[test]
    fn yesterday_counted_means_the_streak_lapses_tonight() {
        let today = day(2026, 9, 2);
        let streak = project(7, Some(day(2026, 9, 1)), today);
        assert_eq!(streak.days, 7);
        assert!(!streak.extended_today);
        assert!(streak.at_risk);
    }

    #[test]
    fn a_missed_day_ends_the_streak() {
        let today = day(2026, 9, 2);
        let streak = project(30, Some(day(2026, 8, 31)), today);
        assert_eq!(streak.days, 0, "a gap resets rather than pausing");
        assert!(!streak.at_risk);
    }

    #[test]
    fn a_streak_survives_a_month_boundary() {
        let today = day(2026, 9, 1);
        let streak = project(12, Some(day(2026, 8, 31)), today);
        assert_eq!(streak.days, 12);
        assert!(streak.at_risk);
    }
}
