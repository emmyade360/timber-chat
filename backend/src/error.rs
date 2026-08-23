use axum::{
    Json,
    http::StatusCode,
    response::{IntoResponse, Response},
};
use serde::Serialize;
use tracing::{error, warn};

#[derive(Serialize)]
struct ErrorBody {
    error: String,
}

#[derive(Debug)]
pub enum ApiError {
    BadRequest(String),
    Unauthorized,
    Forbidden(String),
    NotFound(String),
    Conflict(String),
    TooManyRequests(String),
    Upstream(String),
    Database(sqlx::Error),
    Internal(String),
}

impl From<sqlx::Error> for ApiError {
    fn from(error: sqlx::Error) -> Self {
        Self::Database(error)
    }
}

impl IntoResponse for ApiError {
    fn into_response(self) -> Response {
        // Client errors carry their message through; server-side failures are logged
        // in full and answered with something generic, so internals never leak.
        let (status, message) = match self {
            Self::BadRequest(message) => (StatusCode::BAD_REQUEST, message),
            Self::Unauthorized => (
                StatusCode::UNAUTHORIZED,
                "Invalid or missing access token".into(),
            ),
            Self::Forbidden(message) => (StatusCode::FORBIDDEN, message),
            Self::NotFound(message) => (StatusCode::NOT_FOUND, message),
            Self::Conflict(message) => (StatusCode::CONFLICT, message),
            Self::TooManyRequests(message) => (StatusCode::TOO_MANY_REQUESTS, message),
            Self::Upstream(message) => {
                warn!(%message, "Upstream request failed");
                (
                    StatusCode::BAD_GATEWAY,
                    "A storage service is unavailable".into(),
                )
            }
            Self::Database(error) => {
                error!(%error, "Database query failed");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Database operation failed".into(),
                )
            }
            Self::Internal(message) => {
                error!(%message, "Unexpected server error");
                (
                    StatusCode::INTERNAL_SERVER_ERROR,
                    "Unexpected server error".into(),
                )
            }
        };

        (status, Json(ErrorBody { error: message })).into_response()
    }
}
