//! Non-custodial authentication.
//!
//! There is no password and no server-held credential. An account is an Ed25519
//! public key; proving ownership means signing a short-lived nonce the server
//! issued. The server can verify that signature but could never produce one, so a
//! full database compromise still does not let an attacker log in as anyone.
//!
//! Sessions are random, short-lived opaque bearer values.  The database stores
//! only their SHA-256 digests, which makes logout revocable without turning the
//! database into a source of replayable credentials.

use axum::{
    Json,
    extract::{Extension, State},
    http::{HeaderMap, header::AUTHORIZATION},
    middleware::Next,
    response::Response,
};
use std::time::Duration as StdDuration;
use base64::{Engine, engine::general_purpose::{STANDARD as BASE64, URL_SAFE_NO_PAD}};
use chrono::{DateTime, Duration, Utc};
use ed25519_dalek::{Signature, Verifier, VerifyingKey};
use rand::RngCore;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use sqlx::PgPool;
use uuid::Uuid;

use crate::{AppState, error::ApiError};

/// How long a login challenge stays valid. Long enough to sign on a slow phone,
/// short enough that a captured nonce is worthless.
const CHALLENGE_TTL_SECONDS: i64 = 120;
pub const SESSION_TTL_MINUTES: i64 = 15;
pub const WS_TICKET_TTL_SECONDS: i64 = 60;
const NONCE_BYTES: usize = 32;
const SESSION_TOKEN_BYTES: usize = 32;
const KEY_BINDING_DOMAIN: &[u8] = b"timber/key-binding/v1\0";

/// Invite codes omit 0/O/1/I/L so a code copied by hand cannot resolve elsewhere.
const INVITE_ALPHABET: &[u8] = b"23456789ABCDEFGHJKMNPQRSTUVWXYZ";
const INVITE_CODE_LEN: usize = 8;

const MIN_USERNAME: usize = 3;
const MAX_USERNAME: usize = 20;

/// Names that would let an account impersonate the product or a system actor.
const RESERVED_USERNAMES: &[&str] = &[
    "admin", "administrator", "timber", "support", "system", "root", "help", "about", "me",
    "null", "undefined", "moderator", "staff", "official", "security",
];

#[derive(Clone, Debug)]
pub struct AuthUser {
    pub id: Uuid,
    pub username: String,
}

/// Derive an account id from an Ed25519 public key.
///
/// UUIDv8 over the first half of SHA-256(public key). The client performs the
/// identical derivation offline, which is what makes an account a pure function of
/// its recovery phrase: nothing is assigned by the server, so nothing can be lost
/// by the server. Any change here would orphan every existing account.
pub fn user_id_for_public_key(identity_pk: &[u8]) -> Uuid {
    let digest = Sha256::digest(identity_pk);
    let mut bytes = [0u8; 16];
    bytes.copy_from_slice(&digest[..16]);
    bytes[6] = (bytes[6] & 0x0f) | 0x80; // version 8
    bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC variant
    Uuid::from_bytes(bytes)
}

/// A fresh invite code. Collisions are handled by the UNIQUE constraint and a retry,
/// which at 31^8 possibilities is effectively never exercised.
fn generate_invite_code() -> String {
    let mut rng = rand::thread_rng();
    let mut bytes = [0u8; INVITE_CODE_LEN];
    rng.fill_bytes(&mut bytes);
    bytes
        .iter()
        .map(|byte| INVITE_ALPHABET[usize::from(*byte) % INVITE_ALPHABET.len()] as char)
        .collect()
}

fn decode_key(value: &str, field: &str) -> Result<[u8; 32], ApiError> {
    let bytes = BASE64
        .decode(value)
        .map_err(|_| ApiError::BadRequest(format!("{field} is not valid base64")))?;
    bytes
        .try_into()
        .map_err(|_| ApiError::BadRequest(format!("{field} must be 32 bytes")))
}

fn decode_signature(value: &str, field: &str) -> Result<[u8; 64], ApiError> {
    let bytes = BASE64
        .decode(value)
        .map_err(|_| ApiError::BadRequest(format!("{field} is not valid base64")))?;
    bytes
        .try_into()
        .map_err(|_| ApiError::BadRequest(format!("{field} must be 64 bytes")))
}

/// The exact, versioned transcript an identity key signs to certify a chat key.
/// All fields have fixed lengths, so it is unambiguous across implementations.
pub fn kex_key_binding_message(
    user_id: Uuid,
    identity_pk: &[u8; 32],
    kex_pk: &[u8; 32],
) -> Vec<u8> {
    let mut message = Vec::with_capacity(KEY_BINDING_DOMAIN.len() + 16 + 32 + 32);
    message.extend_from_slice(KEY_BINDING_DOMAIN);
    message.extend_from_slice(user_id.as_bytes());
    message.extend_from_slice(identity_pk);
    message.extend_from_slice(kex_pk);
    message
}

fn verify_kex_key_binding(
    user_id: Uuid,
    identity_pk: &[u8; 32],
    kex_pk: &[u8; 32],
    signature_b64: &str,
) -> Result<[u8; 64], ApiError> {
    let signature = decode_signature(signature_b64, "kex_key_signature")?;
    let verifying_key = VerifyingKey::from_bytes(identity_pk).map_err(|_| ApiError::Unauthorized)?;
    verifying_key
        .verify(
            &kex_key_binding_message(user_id, identity_pk, kex_pk),
            &Signature::from_bytes(&signature),
        )
        .map_err(|_| ApiError::BadRequest("The chat key is not certified by this identity.".into()))?;
    Ok(signature)
}

/// Check a signature over the nonce the server issued for this key.
///
/// The challenge is deleted whether or not verification succeeds, so a nonce is
/// strictly single-use and a captured one cannot be replayed.
async fn verify_challenge(
    db: &PgPool,
    identity_pk: &[u8; 32],
    signature_b64: &str,
) -> Result<(), ApiError> {
    let row: Option<(Vec<u8>, DateTime<Utc>)> =
        sqlx::query_as("DELETE FROM auth_challenges WHERE identity_pk = $1 RETURNING nonce, expires_at")
            .bind(&identity_pk[..])
            .fetch_optional(db)
            .await?;

    let (nonce, expires_at) = row.ok_or_else(|| {
        ApiError::BadRequest("No pending challenge for this key. Request a new one.".into())
    })?;
    if expires_at < Utc::now() {
        return Err(ApiError::BadRequest(
            "That challenge expired. Request a new one.".into(),
        ));
    }

    let signature_bytes = decode_signature(signature_b64, "signature")?;

    let verifying_key =
        VerifyingKey::from_bytes(identity_pk).map_err(|_| ApiError::Unauthorized)?;
    verifying_key
        .verify(&nonce, &Signature::from_bytes(&signature_bytes))
        .map_err(|_| ApiError::Unauthorized)
}

fn random_token() -> String {
    let mut raw = [0u8; SESSION_TOKEN_BYTES];
    rand::thread_rng().fill_bytes(&mut raw);
    URL_SAFE_NO_PAD.encode(raw)
}

fn token_digest(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

async fn issue_token(db: &PgPool, id: Uuid) -> Result<String, ApiError> {
    let token = random_token();
    // Keep expired opaque credentials from accumulating indefinitely. Their
    // digests are harmless, but bounded retention keeps the session table small.
    sqlx::query("DELETE FROM auth_sessions WHERE expires_at < NOW() - INTERVAL '1 day'")
        .execute(db)
        .await?;
    sqlx::query(
        "INSERT INTO auth_sessions (token_digest, user_id, expires_at) VALUES ($1, $2, $3)",
    )
    .bind(&token_digest(&token)[..])
    .bind(id)
    .bind(Utc::now() + Duration::minutes(SESSION_TTL_MINUTES))
    .execute(db)
    .await?;
    Ok(token)
}

/// Validate a bearer token and return the caller. Shared by HTTP and WebSocket paths.
pub async fn authenticate(db: &PgPool, token: &str) -> Result<AuthUser, ApiError> {
    let digest = token_digest(token);
    sqlx::query_as::<_, (Uuid, String)>(
        r#"
        SELECT p.id, p.username
        FROM auth_sessions s
        JOIN profiles p ON p.id = s.user_id
        WHERE s.token_digest = $1 AND s.revoked_at IS NULL AND s.expires_at > NOW()
        "#,
    )
    .bind(&digest[..])
    .fetch_optional(db)
    .await?
    .map(|(id, username)| AuthUser { id, username })
    .ok_or(ApiError::Unauthorized)
}

fn bearer_token(headers: &HeaderMap) -> Result<&str, ApiError> {
    headers
        .get(AUTHORIZATION)
        .and_then(|value| value.to_str().ok())
        .and_then(|header| header.strip_prefix("Bearer "))
        .ok_or(ApiError::Unauthorized)
}

pub async fn require_auth(
    State(state): State<AppState>,
    mut request: axum::extract::Request,
    next: Next,
) -> Result<Response, ApiError> {
    let user = authenticate(&state.db, bearer_token(request.headers())?).await?;
    request.extensions_mut().insert(user);
    Ok(next.run(request).await)
}

/// Normalise and check a requested username.
///
/// Lowercased so that `Ada` and `ada` cannot both exist and be mistaken for each
/// other, and restricted to a narrow character set for the same reason.
pub fn normalize_username(raw: &str) -> Result<String, ApiError> {
    let username = raw.trim().to_lowercase();
    if username.len() < MIN_USERNAME || username.len() > MAX_USERNAME {
        return Err(ApiError::BadRequest(format!(
            "Usernames must be between {MIN_USERNAME} and {MAX_USERNAME} characters."
        )));
    }
    if !username
        .chars()
        .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '_')
    {
        return Err(ApiError::BadRequest(
            "Usernames can only use letters, numbers and underscores.".into(),
        ));
    }
    if RESERVED_USERNAMES.contains(&username.as_str()) {
        return Err(ApiError::Conflict("That username is reserved.".into()));
    }
    Ok(username)
}

// --- handlers --------------------------------------------------------------

#[derive(Deserialize)]
pub struct ChallengeInput {
    identity_pk: String,
}

#[derive(Serialize)]
pub struct ChallengeResponse {
    nonce: String,
    expires_at: DateTime<Utc>,
    /// Whether this key already has an account, so the client knows whether to
    /// show the "claim a username" step or go straight in.
    registered: bool,
}

pub async fn challenge(
    State(state): State<AppState>,
    Json(input): Json<ChallengeInput>,
) -> Result<Json<ChallengeResponse>, ApiError> {
    let identity_pk = decode_key(&input.identity_pk, "identity_pk")?;
    if !state
        .limits
        .allow("challenge", BASE64.encode(identity_pk), 10, StdDuration::from_secs(60))
        .await
    {
        return Err(ApiError::TooManyRequests("Too many challenge requests. Try again shortly.".into()));
    }

    let mut nonce = vec![0u8; NONCE_BYTES];
    rand::thread_rng().fill_bytes(&mut nonce);
    let expires_at = Utc::now() + Duration::seconds(CHALLENGE_TTL_SECONDS);

    sqlx::query(
        r#"
        INSERT INTO auth_challenges (identity_pk, nonce, expires_at)
        VALUES ($1, $2, $3)
        ON CONFLICT (identity_pk) DO UPDATE SET nonce = $2, expires_at = $3
        "#,
    )
    .bind(&identity_pk[..])
    .bind(&nonce)
    .bind(expires_at)
    .execute(&state.db)
    .await?;

    // Opportunistically clear expired rows so the table cannot grow without bound
    // from unfinished login attempts.
    sqlx::query("DELETE FROM auth_challenges WHERE expires_at < NOW() - INTERVAL '1 hour'")
        .execute(&state.db)
        .await?;

    let registered: bool =
        sqlx::query_scalar("SELECT EXISTS(SELECT 1 FROM profiles WHERE identity_pk = $1)")
            .bind(&identity_pk[..])
            .fetch_one(&state.db)
            .await?;

    Ok(Json(ChallengeResponse {
        nonce: BASE64.encode(&nonce),
        expires_at,
        registered,
    }))
}

#[derive(Deserialize)]
pub struct RegisterInput {
    identity_pk: String,
    kex_pk: String,
    kex_key_signature: String,
    username: String,
    signature: String,
    /// Optional code from an invite link. Credits the inviter and starts the two
    /// of them off as friends.
    invite_code: Option<String>,
}

#[derive(Serialize)]
pub struct SessionResponse {
    token: String,
    user_id: Uuid,
    username: String,
    /// Present on registration when an invite code was accepted.
    #[serde(skip_serializing_if = "Option::is_none")]
    invited_by: Option<String>,
}

pub async fn register(
    State(state): State<AppState>,
    Json(input): Json<RegisterInput>,
) -> Result<Json<SessionResponse>, ApiError> {
    let identity_pk = decode_key(&input.identity_pk, "identity_pk")?;
    let kex_pk = decode_key(&input.kex_pk, "kex_pk")?;
    let username = normalize_username(&input.username)?;

    verify_challenge(&state.db, &identity_pk, &input.signature).await?;

    let user_id = user_id_for_public_key(&identity_pk);
    if !state
        .limits
        .allow("register", user_id, 3, StdDuration::from_secs(60 * 60))
        .await
    {
        return Err(ApiError::TooManyRequests("Too many registration attempts. Try again later.".into()));
    }
    let kex_key_signature = verify_kex_key_binding(
        user_id,
        &identity_pk,
        &kex_pk,
        &input.kex_key_signature,
    )?;

    let existing: Option<String> =
        sqlx::query_scalar("SELECT username FROM profiles WHERE id = $1")
            .bind(user_id)
            .fetch_optional(&state.db)
            .await?;
    if let Some(existing) = existing {
        return Err(ApiError::Conflict(format!(
            "This recovery phrase already has an account (@{existing}). Sign in instead."
        )));
    }

    let inserted = sqlx::query(
        r#"
        INSERT INTO profiles (id, username, identity_pk, kex_pk, kex_key_signature, invite_code)
        VALUES ($1, $2, $3, $4, $5, $6)
        ON CONFLICT (username) DO NOTHING
        "#,
    )
    .bind(user_id)
    .bind(&username)
    .bind(&identity_pk[..])
    .bind(&kex_pk[..])
    .bind(&kex_key_signature[..])
    .bind(generate_invite_code())
    .execute(&state.db)
    .await?;

    if inserted.rows_affected() == 0 {
        return Err(ApiError::Conflict("That username is already taken.".into()));
    }

    // Credit the inviter, if there was one. A bad code is not worth failing a
    // signup over -- the account is already created and valid.
    let invited_by = match input.invite_code.as_deref() {
        Some(code) if !code.trim().is_empty() => {
            crate::routes::users::redeem_invite(&state, user_id, code).await?
        }
        _ => None,
    };

    Ok(Json(SessionResponse {
        token: issue_token(&state.db, user_id).await?,
        user_id,
        username,
        invited_by,
    }))
}

#[derive(Deserialize)]
pub struct LoginInput {
    identity_pk: String,
    signature: String,
}

pub async fn login(
    State(state): State<AppState>,
    Json(input): Json<LoginInput>,
) -> Result<Json<SessionResponse>, ApiError> {
    let identity_pk = decode_key(&input.identity_pk, "identity_pk")?;
    verify_challenge(&state.db, &identity_pk, &input.signature).await?;

    let user_id = user_id_for_public_key(&identity_pk);
    if !state
        .limits
        .allow("login", user_id, 10, StdDuration::from_secs(60))
        .await
    {
        return Err(ApiError::TooManyRequests("Too many sign-in attempts. Try again shortly.".into()));
    }
    let username: String = sqlx::query_scalar("SELECT username FROM profiles WHERE id = $1")
        .bind(user_id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| {
            ApiError::NotFound("No account for this recovery phrase. Create one first.".into())
        })?;

    Ok(Json(SessionResponse {
        token: issue_token(&state.db, user_id).await?,
        user_id,
        username,
        invited_by: None,
    }))
}

/// Attest the deterministic X25519 key for an account created before key binding
/// was introduced.  Unlike the legacy republish endpoint, the server cannot write
/// an arbitrary key: the identity key must certify the exact value.
#[derive(Deserialize)]
pub struct AttestKexKeyInput {
    kex_pk: String,
    kex_key_signature: String,
}

pub async fn attest_kex_key(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Json(input): Json<AttestKexKeyInput>,
) -> Result<Json<serde_json::Value>, ApiError> {
    let kex_pk = decode_key(&input.kex_pk, "kex_pk")?;
    let identity_pk: Vec<u8> = sqlx::query_scalar("SELECT identity_pk FROM profiles WHERE id = $1")
        .bind(user.id)
        .fetch_optional(&state.db)
        .await?
        .ok_or_else(|| ApiError::NotFound("Profile not found.".into()))?;
    let identity_pk: [u8; 32] = identity_pk
        .try_into()
        .map_err(|_| ApiError::Internal("Stored identity key has an invalid length.".into()))?;
    let signature = verify_kex_key_binding(
        user.id,
        &identity_pk,
        &kex_pk,
        &input.kex_key_signature,
    )?;
    sqlx::query("UPDATE profiles SET kex_pk = $1, kex_key_signature = $2 WHERE id = $3")
        .bind(&kex_pk[..])
        .bind(&signature[..])
        .bind(user.id)
        .execute(&state.db)
        .await?;
    Ok(Json(serde_json::json!({ "success": true })))
}

/// Explicitly revoke the in-memory bearer when the user locks the device.
pub async fn logout(
    State(state): State<AppState>,
    headers: HeaderMap,
) -> Result<Json<serde_json::Value>, ApiError> {
    let digest = token_digest(bearer_token(&headers)?);
    sqlx::query("UPDATE auth_sessions SET revoked_at = NOW() WHERE token_digest = $1")
        .bind(&digest[..])
        .execute(&state.db)
        .await?;
    Ok(Json(serde_json::json!({ "success": true })))
}

#[derive(Serialize)]
pub struct WsTicketResponse {
    pub ticket: String,
    pub expires_at: DateTime<Utc>,
}

/// Mint a short-lived ticket for browser WebSocket negotiation.  Tickets are
/// deliberately stored hashed and consumed atomically by the upgrade handler.
pub async fn issue_ws_ticket(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
) -> Result<Json<WsTicketResponse>, ApiError> {
    if !state
        .limits
        .allow("ws-ticket", user.id, 30, StdDuration::from_secs(60))
        .await
    {
        return Err(ApiError::TooManyRequests("Too many socket connection attempts. Try again shortly.".into()));
    }
    let ticket = random_token();
    sqlx::query("DELETE FROM ws_tickets WHERE expires_at < NOW()")
        .execute(&state.db)
        .await?;
    let expires_at = Utc::now() + Duration::seconds(WS_TICKET_TTL_SECONDS);
    let digest = token_digest(&ticket);
    sqlx::query("INSERT INTO ws_tickets (token_digest, user_id, expires_at) VALUES ($1, $2, $3)")
        .bind(&digest[..])
        .bind(user.id)
        .bind(expires_at)
        .execute(&state.db)
        .await?;
    Ok(Json(WsTicketResponse { ticket, expires_at }))
}

/// Consume a WebSocket ticket once. The DELETE makes concurrent replay attempts
/// fail even if both requests reach separate server instances at the same time.
pub async fn consume_ws_ticket(db: &PgPool, ticket: &str) -> Result<AuthUser, ApiError> {
    let digest = token_digest(ticket);
    let user_id: Option<Uuid> = sqlx::query_scalar(
        "DELETE FROM ws_tickets WHERE token_digest = $1 AND expires_at > NOW() RETURNING user_id",
    )
    .bind(&digest[..])
    .fetch_optional(db)
    .await?;
    let user_id = user_id.ok_or(ApiError::Unauthorized)?;
    let username: String = sqlx::query_scalar("SELECT username FROM profiles WHERE id = $1")
        .bind(user_id)
        .fetch_optional(db)
        .await?
        .ok_or(ApiError::Unauthorized)?;
    Ok(AuthUser { id: user_id, username })
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, SigningKey};

    #[test]
    fn derives_the_same_account_id_as_the_client() {
        // Cross-language vector. The frontend derives this id for the canonical
        // all-zero-entropy BIP39 phrase; if the two ever disagree, every account
        // silently splits in two.
        let identity_pk = BASE64
            .decode("s9gArXUimYYiZD5iUexlszJHUZZYRz9GLUyk27AvLMo=")
            .unwrap();
        assert_eq!(
            user_id_for_public_key(&identity_pk).to_string(),
            "ebf9dc0b-6877-87dc-bc70-cacac5805257"
        );
    }

    #[test]
    fn account_id_is_a_well_formed_uuid_v8() {
        let id = user_id_for_public_key(&[7u8; 32]);
        assert_eq!(id.get_version_num(), 8);
        // RFC 9562 variant: top two bits of octet 8 are 10.
        assert_eq!(id.as_bytes()[8] & 0xc0, 0x80);
    }

    #[test]
    fn account_id_is_stable_and_key_specific() {
        assert_eq!(
            user_id_for_public_key(&[1u8; 32]),
            user_id_for_public_key(&[1u8; 32])
        );
        assert_ne!(
            user_id_for_public_key(&[1u8; 32]),
            user_id_for_public_key(&[2u8; 32])
        );
    }

    #[test]
    fn usernames_are_lowercased_and_trimmed() {
        assert_eq!(normalize_username("  AdaLovelace ").unwrap(), "adalovelace");
        assert_eq!(normalize_username("tobi_99").unwrap(), "tobi_99");
    }

    #[test]
    fn rejects_usernames_outside_the_allowed_shape() {
        assert!(normalize_username("ab").is_err());
        assert!(normalize_username(&"a".repeat(21)).is_err());
        assert!(normalize_username("has space").is_err());
        assert!(normalize_username("emoji🪵").is_err());
        assert!(normalize_username("semi;colon").is_err());
    }

    #[test]
    fn rejects_reserved_names_case_insensitively() {
        assert!(normalize_username("admin").is_err());
        assert!(normalize_username("ADMIN").is_err());
        assert!(normalize_username("Support").is_err());
    }

    #[test]
    fn accepts_a_valid_identity_to_chat_key_binding() {
        let signing = SigningKey::from_bytes(&[9u8; 32]);
        let identity_pk = signing.verifying_key().to_bytes();
        let kex_pk = [4u8; 32];
        let user_id = user_id_for_public_key(&identity_pk);
        let binding = kex_key_binding_message(user_id, &identity_pk, &kex_pk);
        let signature = BASE64.encode(signing.sign(&binding).to_bytes());
        assert!(verify_kex_key_binding(user_id, &identity_pk, &kex_pk, &signature).is_ok());
    }

    #[test]
    fn rejects_a_substituted_chat_key_binding() {
        let signing = SigningKey::from_bytes(&[9u8; 32]);
        let identity_pk = signing.verifying_key().to_bytes();
        let user_id = user_id_for_public_key(&identity_pk);
        let original = [4u8; 32];
        let signature = BASE64.encode(
            signing
                .sign(&kex_key_binding_message(user_id, &identity_pk, &original))
                .to_bytes(),
        );
        assert!(verify_kex_key_binding(user_id, &identity_pk, &[5u8; 32], &signature).is_err());
    }

    #[test]
    fn opaque_session_tokens_are_unpredictable_url_safe_values() {
        let first = random_token();
        let second = random_token();
        assert_ne!(first, second);
        assert_eq!(token_digest(&first).len(), 32);
        assert!(first.chars().all(|character| character.is_ascii_alphanumeric() || character == '-' || character == '_'));
    }
}
