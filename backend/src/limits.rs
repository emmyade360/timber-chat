//! Small in-process sliding-window limits for abuse-prone endpoints.
//!
//! Keys are account or identity scoped, so no untrusted forwarding header is
//! treated as a client IP. Deployments with several API instances should place a
//! shared edge rate limiter in front as well.

use std::{
    collections::{HashMap, VecDeque},
    sync::Arc,
    time::{Duration, Instant},
};

use tokio::sync::Mutex;

/// A deliberately bounded in-process limiter. The production edge should still
/// enforce network-wide limits, but this prevents untrusted identifiers from
/// turning a single Render process into an ever-growing HashMap.
const MAX_TRACKED_BUCKETS: usize = 4_096;

struct Bucket {
    events: VecDeque<Instant>,
    window: Duration,
    last_seen: Instant,
}

struct RateLimitState {
    buckets: HashMap<String, Bucket>,
}

#[derive(Clone)]
pub struct RateLimiter {
    state: Arc<Mutex<RateLimitState>>,
}

impl Default for RateLimiter {
    fn default() -> Self {
        Self {
            state: Arc::new(Mutex::new(RateLimitState {
                buckets: HashMap::new(),
            })),
        }
    }
}

impl RateLimiter {
    fn prune(bucket: &mut Bucket, now: Instant) {
        while bucket
            .events
            .front()
            .is_some_and(|seen| now.duration_since(*seen) >= bucket.window)
        {
            bucket.events.pop_front();
        }
    }

    /// Returns true and records the operation when it is inside its window.
    pub async fn allow(&self, scope: &str, subject: impl std::fmt::Display, max: usize, window: Duration) -> bool {
        let key = format!("{scope}:{subject}");
        let now = Instant::now();
        let mut state = self.state.lock().await;

        if !state.buckets.contains_key(&key) && state.buckets.len() >= MAX_TRACKED_BUCKETS {
            // First discard buckets whose whole window has elapsed. This runs
            // only under pressure, so normal requests stay O(1).
            state.buckets.retain(|_, bucket| {
                Self::prune(bucket, now);
                !bucket.events.is_empty()
            });
            // A global anonymous limit protects the endpoints that accept a
            // caller-chosen subject. Evicting the oldest residual bucket keeps
            // the process bounded even if an attacker keeps rotating values.
            if state.buckets.len() >= MAX_TRACKED_BUCKETS
                && let Some(oldest) = state
                    .buckets
                    .iter()
                    .min_by_key(|(_, bucket)| bucket.last_seen)
                    .map(|(key, _)| key.clone())
            {
                state.buckets.remove(&oldest);
            }
        }

        let bucket = state.buckets.entry(key).or_insert_with(|| Bucket {
            events: VecDeque::new(),
            window,
            last_seen: now,
        });
        // A scope always uses the same window. Preserve the existing value so
        // a caller cannot shorten a live rate-limit bucket by choosing a new
        // duration at a different call site.
        Self::prune(bucket, now);
        bucket.last_seen = now;
        if bucket.events.len() >= max {
            return false;
        }
        bucket.events.push_back(now);
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn enforces_a_window_per_scope_and_subject() {
        let limiter = RateLimiter::default();
        assert!(limiter.allow("login", "account-a", 2, Duration::from_secs(60)).await);
        assert!(limiter.allow("login", "account-a", 2, Duration::from_secs(60)).await);
        assert!(!limiter.allow("login", "account-a", 2, Duration::from_secs(60)).await);
        assert!(limiter.allow("login", "account-b", 2, Duration::from_secs(60)).await);
        assert!(limiter.allow("search", "account-a", 2, Duration::from_secs(60)).await);
    }

    #[tokio::test]
    async fn bounds_caller_controlled_bucket_cardinality() {
        let limiter = RateLimiter::default();
        for number in 0..=MAX_TRACKED_BUCKETS {
            assert!(limiter.allow("challenge", number, 1, Duration::from_secs(60)).await);
        }
        let state = limiter.state.lock().await;
        assert!(state.buckets.len() <= MAX_TRACKED_BUCKETS);
    }
}
