//! Ephemeral WebRTC relay configuration.
//!
//! The backend never receives media. It gives an authenticated browser the ICE
//! configuration needed to establish a direct DTLS/SRTP media path, and creates a
//! short-lived coturn REST credential when a shared secret is configured.

use std::env;

use axum::{Json, extract::Extension};
use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use chrono::{DateTime, Duration, Utc};
use hmac::{Hmac, Mac};
use serde::Serialize;
use sha1::Sha1;

use crate::{auth::AuthUser, error::ApiError};

const TURN_CREDENTIAL_TTL_MINUTES: i64 = 10;

#[derive(Serialize)]
pub struct IceServersResponse {
    pub ice_servers: Vec<IceServer>,
    pub turn_configured: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub expires_at: Option<DateTime<Utc>>,
}

/// Matches the browser's `RTCIceServer` shape. `urls` deliberately stays an
/// array so a deployment can offer UDP and TLS/TCP TURN endpoints together.
#[derive(Serialize)]
pub struct IceServer {
    pub urls: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub username: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub credential: Option<String>,
}

fn urls_from_env(name: &str, schemes: &[&str]) -> Result<Vec<String>, ApiError> {
    let raw = env::var(name).unwrap_or_default();
    let urls: Vec<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect();
    if urls.iter().any(|url| !schemes.iter().any(|scheme| url.starts_with(scheme))) {
        return Err(ApiError::Internal(format!(
            "{name} contains an unsupported ICE URL scheme"
        )));
    }
    Ok(urls)
}

fn nonempty_env(name: &str) -> Result<String, ApiError> {
    env::var(name)
        .ok()
        .filter(|value| !value.trim().is_empty())
        .ok_or_else(|| ApiError::Internal(format!("{name} must be configured when TURN is enabled")))
}

fn rest_turn_credential(secret: &str, user: &AuthUser) -> (String, String, DateTime<Utc>) {
    let expires_at = Utc::now() + Duration::minutes(TURN_CREDENTIAL_TTL_MINUTES);
    let username = format!("{}:{}", expires_at.timestamp(), user.id);
    let mut mac = Hmac::<Sha1>::new_from_slice(secret.as_bytes())
        .expect("HMAC accepts a secret of any length");
    mac.update(username.as_bytes());
    let credential = BASE64.encode(mac.finalize().into_bytes());
    (username, credential, expires_at)
}

/// Return STUN/TURN configuration only after the caller has an authenticated
/// Timber session. TURN credentials are ten-minute coturn REST credentials when
/// `WEBRTC_TURN_SHARED_SECRET` is present; static credentials are supported only
/// for managed TURN providers that do not support REST authentication.
pub async fn get_ice_servers(
    Extension(user): Extension<AuthUser>,
) -> Result<Json<IceServersResponse>, ApiError> {
    let stun_urls = urls_from_env("WEBRTC_STUN_URLS", &["stun:", "stuns:"])?;
    let turn_urls = urls_from_env("WEBRTC_TURN_URLS", &["turn:", "turns:"])?;
    let turn_configured = !turn_urls.is_empty();
    let mut ice_servers = Vec::new();
    if !stun_urls.is_empty() {
        ice_servers.push(IceServer {
            urls: stun_urls,
            username: None,
            credential: None,
        });
    }

    let mut expires_at = None;
    if turn_configured {
        let rest_secret = env::var("WEBRTC_TURN_SHARED_SECRET")
            .ok()
            .filter(|secret| !secret.trim().is_empty());
        let using_rest_secret = rest_secret.is_some();
        let (username, credential, expiry) = match rest_secret {
            Some(secret) => rest_turn_credential(&secret, &user),
            _ => (
                nonempty_env("WEBRTC_TURN_USERNAME")?,
                nonempty_env("WEBRTC_TURN_CREDENTIAL")?,
                Utc::now() + Duration::minutes(TURN_CREDENTIAL_TTL_MINUTES),
            ),
        };
        if using_rest_secret {
            expires_at = Some(expiry);
        }
        ice_servers.push(IceServer {
            urls: turn_urls,
            username: Some(username),
            credential: Some(credential),
        });
    }

    Ok(Json(IceServersResponse {
        ice_servers,
        turn_configured,
        expires_at,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn turn_rest_credentials_are_short_lived_and_account_scoped() {
        let user = AuthUser {
            id: uuid::Uuid::nil(),
            username: "cedar".into(),
        };
        let (username, credential, expires_at) = rest_turn_credential("turn-secret", &user);
        assert!(username.ends_with(":00000000-0000-0000-0000-000000000000"));
        assert!(!credential.is_empty());
        assert!(expires_at > Utc::now());
    }
}
