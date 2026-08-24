//! Attachment upload.
//!
//! The bytes arriving here are already sealed by the sender's device under a
//! single-use key that travels inside the encrypted message body. The server is
//! storing an opaque blob: it cannot tell an image from a document, so it does not
//! try to, and everything is stored and served as `application/octet-stream`.
//! The client validates the real type before encrypting and again after decrypting.

use axum::{
    Json,
    extract::{Extension, Multipart, Path, State},
    http::{StatusCode, header},
    response::{IntoResponse, Response},
};
use chrono::{Duration as ChronoDuration, Utc};
use futures_util::StreamExt;
use serde::Serialize;
use std::time::Duration;
use tracing::warn;
use uuid::Uuid;

use crate::{AppState, auth::AuthUser, error::ApiError};

pub const MAX_UPLOAD_BYTES: usize = 10 * 1024 * 1024;
const STAGING_TTL_MINUTES: i64 = 60;

#[derive(Serialize)]
pub struct AttachmentUploadResponse {
    attachment_id: Uuid,
}

pub async fn upload_file(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    mut multipart: Multipart,
) -> Result<Json<AttachmentUploadResponse>, ApiError> {
    if !state
        .limits
        .allow("upload", user.id, 10, Duration::from_secs(60 * 60))
        .await
    {
        return Err(ApiError::TooManyRequests("Too many uploads. Try again later.".into()));
    }
    let field = multipart
        .next_field()
        .await
        .map_err(|_| ApiError::BadRequest("Could not read the uploaded file.".into()))?
        .ok_or_else(|| ApiError::BadRequest("No file provided.".into()))?;
    if field.name() != Some("file") {
        return Err(ApiError::BadRequest("Expected a file form field.".into()));
    }

    let bytes = field
        .bytes()
        .await
        .map_err(|_| ApiError::BadRequest("Could not read the uploaded file.".into()))?;
    if bytes.is_empty() {
        return Err(ApiError::BadRequest("That file is empty.".into()));
    }
    if bytes.len() > MAX_UPLOAD_BYTES {
        return Err(ApiError::BadRequest("Files must be 10 MB or smaller.".into()));
    }
    if multipart
        .next_field()
        .await
        .map_err(|_| ApiError::BadRequest("Could not read the uploaded file.".into()))?
        .is_some()
    {
        return Err(ApiError::BadRequest(
            "Upload exactly one encrypted file at a time.".into(),
        ));
    }

    cleanup_expired_attachments(&state).await;

    // A random key with no extension: the storage path leaks neither the original
    // filename nor the file type. Both live inside the sealed message payload.
    let attachment_id = Uuid::new_v4();
    let object_key = Uuid::new_v4();
    let key = object_key.to_string();
    let expires_at = Utc::now() + ChronoDuration::minutes(STAGING_TTL_MINUTES);
    sqlx::query(
        "INSERT INTO attachments (id, owner_id, object_key, expires_at) VALUES ($1, $2, $3, $4)",
    )
    .bind(attachment_id)
    .bind(user.id)
    .bind(object_key)
    .bind(expires_at)
    .execute(&state.db)
    .await?;
    let upload_url = format!("{}/storage/v1/object/chat-files/{key}", state.supabase.url);

    let response = state
        .http
        .post(upload_url)
        .bearer_auth(&state.supabase.service_key)
        .header("apikey", &state.supabase.service_key)
        .header(axum::http::header::CONTENT_TYPE, "application/octet-stream")
        .body(bytes)
        .send()
        .await
        .map_err(|error| ApiError::Upstream(error.to_string()))?;

    if !response.status().is_success() {
        let _ = sqlx::query("DELETE FROM attachments WHERE id = $1")
            .bind(attachment_id)
            .execute(&state.db)
            .await;
        warn!(status = %response.status(), "Storage upload failed");
        return Err(ApiError::Upstream("Storage upload was rejected.".into()));
    }

    Ok(Json(AttachmentUploadResponse { attachment_id }))
}

/// Download through the API so a private storage bucket never exposes a stable
/// public URL. The user must still be a participant in the message's conversation.
pub async fn download_file(
    State(state): State<AppState>,
    Extension(user): Extension<AuthUser>,
    Path(attachment_id): Path<Uuid>,
) -> Result<Response, ApiError> {
    if !state
        .limits
        .allow("attachment-download", user.id, 60, Duration::from_secs(60))
        .await
    {
        return Err(ApiError::TooManyRequests(
            "Too many attachment downloads. Try again shortly.".into(),
        ));
    }
    let object_key: Uuid = sqlx::query_scalar(
        r#"
        SELECT a.object_key
        FROM attachments a
        JOIN messages m ON m.id = a.message_id
        JOIN conversations c ON c.id = m.conversation_id
        WHERE a.id = $1 AND a.expires_at > NOW() AND (c.user_a = $2 OR c.user_b = $2)
        "#,
    )
    .bind(attachment_id)
    .bind(user.id)
    .fetch_optional(&state.db)
    .await?
    .ok_or_else(|| ApiError::NotFound("Attachment not found.".into()))?;
    let url = format!("{}/storage/v1/object/chat-files/{object_key}", state.supabase.url);
    let upstream = state
        .http
        .get(url)
        .bearer_auth(&state.supabase.service_key)
        .header("apikey", &state.supabase.service_key)
        .send()
        .await
        .map_err(|error| ApiError::Upstream(error.to_string()))?;
    if !upstream.status().is_success() {
        return Err(ApiError::NotFound("Attachment is no longer available.".into()));
    }
    if upstream
        .content_length()
        .is_some_and(|length| length > MAX_UPLOAD_BYTES as u64)
    {
        // The application only ever writes bounded opaque blobs. Refuse an
        // unexpectedly large upstream object before buffering it in RAM.
        return Err(ApiError::Upstream(
            "Encrypted attachment exceeded the permitted size.".into(),
        ));
    }
    // Content-Length is optional for a chunked response, so bound streaming
    // reads too. This avoids buffering an unexpectedly large storage object in
    // the API process before rejecting it.
    let mut body = upstream.bytes_stream();
    let mut bytes = Vec::new();
    while let Some(chunk) = body.next().await {
        let chunk = chunk.map_err(|error| ApiError::Upstream(error.to_string()))?;
        if chunk.len() > MAX_UPLOAD_BYTES.saturating_sub(bytes.len()) {
            return Err(ApiError::Upstream(
                "Encrypted attachment exceeded the permitted size.".into(),
            ));
        }
        bytes.extend_from_slice(&chunk);
    }
    Ok((
        StatusCode::OK,
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::CACHE_CONTROL, "no-store"),
            (
                header::CONTENT_DISPOSITION,
                "attachment; filename=\"timber-encrypted-attachment\"",
            ),
        ],
        bytes,
    )
        .into_response())
}

/// Purge abandoned staging blobs and intentionally expiring encrypted media.
pub async fn cleanup_expired_attachments(state: &AppState) {
    let expired: Result<Vec<Uuid>, _> = sqlx::query_scalar(
        "DELETE FROM attachments WHERE expires_at < NOW() RETURNING object_key",
    )
    .fetch_all(&state.db)
    .await;
    let Ok(expired) = expired else {
        return;
    };
    for key in expired {
        let url = format!("{}/storage/v1/object/chat-files/{key}", state.supabase.url);
        if let Err(error) = state
            .http
            .delete(url)
            .bearer_auth(&state.supabase.service_key)
            .header("apikey", &state.supabase.service_key)
            .send()
            .await
        {
            warn!(%error, %key, "Could not remove an expired staged attachment");
        }
    }
}
