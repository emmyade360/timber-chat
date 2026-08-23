//! Small in-process sliding-window limits for abuse-prone endpoints.
//!
//! Keys are account or identity scoped, so no untrusted forwarding header is
//! treated as a client IP. Deployments with several API instances should place a
//! shared edge rate limiter in front as well.

use std::{collections::{HashMap, VecDeque}, sync::Arc, time::{Duration, Instant}};

use tokio::sync::Mutex;

#[derive(Clone, Default)]
pub struct RateLimiter {
    windows: Arc<Mutex<HashMap<String, VecDeque<Instant>>>>,
}

impl RateLimiter {
    /// Returns true and records the operation when it is inside its window.
    pub async fn allow(&self, scope: &str, subject: impl std::fmt::Display, max: usize, window: Duration) -> bool {
        let key = format!("{scope}:{subject}");
        let now = Instant::now();
        let mut all = self.windows.lock().await;
        let entries = all.entry(key).or_default();
        while entries.front().is_some_and(|seen| now.duration_since(*seen) >= window) {
            entries.pop_front();
        }
        if entries.len() >= max {
            return false;
        }
        entries.push_back(now);
        true
    }
}
