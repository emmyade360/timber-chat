//! The connection-growth path: 21 stages from Seed to Living Grove.
//!
//! Thresholds are cumulative connection-growth points. The curve rewards steady,
//! bounded practice over roughly a year; it is not a score for health, popularity,
//! message volume, or time spent in the app.
//!
//! This table is the single source of truth. The frontend renders whatever
//! authenticated `GET /api/growth` returns rather than keeping its own copy, so the two can never
//! drift apart.

use serde::Serialize;

#[derive(Debug, Clone, Copy, Serialize)]
pub struct Level {
    pub level: i16,
    pub name: &'static str,
    /// Cumulative connection-growth points required to hold this stage.
    pub threshold: i64,
}

macro_rules! ladder {
    ($(($level:expr, $name:expr, $threshold:expr)),* $(,)?) => {
        pub const LADDER: &[Level] = &[
            $(Level { level: $level, name: $name, threshold: $threshold }),*
        ];
    };
}

ladder![
    (1, "Seed", 0),
    (2, "Sprout", 5),
    (3, "Seedling", 16),
    (4, "Rooted", 36),
    (5, "Open", 73),
    (6, "Present", 130),
    (7, "Steady", 219),
    (8, "Connected", 354),
    (9, "Kindred", 547),
    (10, "Caring", 807),
    (11, "Grounded", 1_146),
    (12, "Supportive", 1_588),
    (13, "Trusted", 2_135),
    (14, "Flourishing", 2_812),
    (15, "Nurturing", 3_645),
    (16, "Resilient", 4_633),
    (17, "Thriving", 5_830),
    (18, "Sheltering", 7_291),
    (19, "Evergreen", 9_113),
    (20, "Heartwood", 11_194),
    (21, "Living Grove", 13_800),
];

pub const MAX_LEVEL: i16 = 21;

/// The highest growth stage whose threshold has been reached.
pub fn level_for_growth(growth_points: i64) -> i16 {
    LADDER
        .iter()
        .rev()
        .find(|tier| growth_points >= tier.threshold)
        .map_or(1, |tier| tier.level)
}

pub fn tier(level: i16) -> Option<&'static Level> {
    LADDER.iter().find(|entry| entry.level == level)
}

/// Progress within the current growth stage, for the profile screen's bar.
///
/// Returns `(growth_into_stage, growth_span_of_stage)`. At the top stage the span is zero and the
/// caller renders a completed bar rather than dividing by it.
pub fn progress(growth_points: i64) -> (i64, i64) {
    let level = level_for_growth(growth_points);
    let current = tier(level).map_or(0, |entry| entry.threshold);
    match tier(level + 1) {
        Some(next) => (growth_points - current, next.threshold - current),
        None => (0, 0),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn path_has_twenty_one_stages_from_seed_to_living_grove() {
        assert_eq!(LADDER.len(), 21);
        assert_eq!(LADDER.first().unwrap().name, "Seed");
        assert_eq!(LADDER.last().unwrap().name, "Living Grove");
        assert_eq!(LADDER.last().unwrap().level, MAX_LEVEL);
    }

    #[test]
    fn thresholds_increase_strictly() {
        // A flat or decreasing step would let one growth practice skip a stage, or
        // strand a person between two stages that both claim the same score.
        for pair in LADDER.windows(2) {
            assert!(
                pair[1].threshold > pair[0].threshold,
                "{} must require more growth than {}",
                pair[1].name,
                pair[0].name
            );
            assert_eq!(pair[1].level, pair[0].level + 1);
        }
    }

    #[test]
    fn every_stage_resolves_at_and_above_its_threshold() {
        for entry in LADDER {
            assert_eq!(level_for_growth(entry.threshold), entry.level, "{}", entry.name);
            assert_eq!(level_for_growth(entry.threshold + 1), entry.level, "{}", entry.name);
        }
    }

    #[test]
    fn one_point_short_stays_on_the_previous_stage() {
        for entry in LADDER.iter().skip(1) {
            assert_eq!(level_for_growth(entry.threshold - 1), entry.level - 1, "{}", entry.name);
        }
    }

    #[test]
    fn a_new_account_starts_as_a_seed() {
        assert_eq!(level_for_growth(0), 1);
        assert_eq!(level_for_growth(-1), 1);
    }

    #[test]
    fn living_grove_is_the_ceiling() {
        // Derived from the table, so rebalancing the ladder does not break the test.
        let living_grove = LADDER.last().unwrap().threshold;
        assert_eq!(level_for_growth(living_grove), MAX_LEVEL);
        assert_eq!(level_for_growth(i64::MAX), MAX_LEVEL);
        // At the top there is no next tier to divide against.
        assert_eq!(progress(living_grove), (0, 0));
    }

    #[test]
    fn progress_is_measured_within_the_current_stage() {
        let sprout = LADDER[1].threshold;
        let seedling = LADDER[2].threshold;
        let span = seedling - sprout;

        assert_eq!(progress(sprout), (0, span));
        assert_eq!(progress(sprout + span / 2), (span / 2, span));
        assert_eq!(progress(0), (0, sprout));
    }

    #[test]
    fn stages_remain_reachable_through_steady_practice() {
        let steps: Vec<i64> = LADDER.windows(2).map(|w| w[1].threshold - w[0].threshold).collect();
        let first = steps.first().unwrap();
        let last = steps.last().unwrap();
        assert!(last > first, "later stages must take more steady practice than early ones");
        assert_eq!(LADDER[1].threshold, 5, "Sprout is reachable on the first check-in");
    }
}
