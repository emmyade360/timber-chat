//! Timber backend.
//!
//! A relay for end-to-end encrypted direct messages. The server authenticates
//! signatures, enforces the friendship rules, routes sealed envelopes, and tracks
//! progression -- and is deliberately incapable of reading a single message. There
//! is no plaintext column in the schema and no decryption key anywhere in this
//! process.

mod auth;
mod error;
mod levels;
mod limits;
mod models;
mod routes;
mod ws;
mod growth;

use std::{
    collections::{HashMap, HashSet},
    env,
    net::SocketAddr,
    sync::Arc,
    time::Duration,
};

use axum::{
    Json, Router,
    extract::{DefaultBodyLimit, State},
    http::{
        Method,
        HeaderValue,
        header::{AUTHORIZATION, CONTENT_TYPE},
    },
    middleware,
    routing::{delete, get, post},
};
use reqwest::Client;
use serde_json::{Value, json};
use sqlx::{
    PgPool,
    postgres::{PgConnectOptions, PgPoolOptions, PgSslMode},
};
use tokio::{signal, sync::{Mutex, broadcast}};
use tower_http::{
    cors::CorsLayer,
    limit::RequestBodyLimitLayer,
    trace::TraceLayer,
};
use tracing::{info, info_span, warn};
use uuid::Uuid;

use routes::upload::MAX_UPLOAD_BYTES;

const EVENT_BUFFER_SIZE: usize = 512;
const DEFAULT_DATABASE_MAX_CONNECTIONS: u32 = 5;
const DATABASE_ACQUIRE_TIMEOUT: Duration = Duration::from_secs(15);
const DATABASE_CONNECT_ATTEMPTS: u8 = 3;
const AUTH_BODY_LIMIT_BYTES: usize = 8 * 1024;

#[derive(Clone)]
pub struct AppState {
    pub db: PgPool,
    pub http: Client,
    pub supabase: SupabaseConfig,
    pub events: broadcast::Sender<ws::PublishedEvent>,
    pub online_users: Arc<Mutex<HashMap<Uuid, usize>>>,
    pub allowed_origins: Arc<HashSet<String>>,
    pub limits: limits::RateLimiter,
}

fn allowed_origins() -> Result<HashSet<String>, Box<dyn std::error::Error>> {
    let managed_host = env::var("RENDER").is_ok();
    let raw = match env::var("ALLOWED_ORIGINS") {
        Ok(value) => value,
        Err(env::VarError::NotPresent) if !managed_host => "http://localhost:5173".into(),
        Err(env::VarError::NotPresent) => {
            return Err("ALLOWED_ORIGINS is required in a managed deployment and must list the HTTPS frontend origin.".into());
        }
        Err(error) => return Err(error.into()),
    };
    let origins: HashSet<String> = raw
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_owned)
        .collect();
    if origins.is_empty() || origins.iter().any(|origin| origin == "*") {
        return Err("ALLOWED_ORIGINS must contain one or more explicit origins, never '*'.".into());
    }
    if origins.iter().any(|origin| {
        let host = origin
            .strip_prefix("http://")
            .or_else(|| origin.strip_prefix("https://"));
        origin.ends_with('/')
            || host.is_none_or(|value| value.is_empty() || value.contains(['/', '?', '#', '@']))
            || origin.parse::<HeaderValue>().is_err()
            || (managed_host && !origin.starts_with("https://"))
    }) {
        return Err("ALLOWED_ORIGINS entries must be exact origins without a trailing slash; managed deployments require HTTPS origins.".into());
    }
    Ok(origins)
}

/// Supabase is used only for Postgres and object storage. Authentication is
/// handled entirely in-process by [`crate::auth`].
#[derive(Clone)]
pub struct SupabaseConfig {
    pub url: String,
    pub service_key: String,
}

impl SupabaseConfig {
    fn from_environment() -> Result<Self, Box<dyn std::error::Error>> {
        let url = required_env("SUPABASE_URL")?.trim_end_matches('/').to_owned();
        if env::var("RENDER").is_ok() && !url.starts_with("https://") {
            return Err("SUPABASE_URL must use HTTPS in a managed deployment.".into());
        }
        Ok(Self {
            url,
            service_key: required_env("SUPABASE_SERVICE_KEY")?,
        })
    }
}

fn required_env(name: &str) -> Result<String, Box<dyn std::error::Error>> {
    env::var(name).map_err(|_| format!("Missing required environment variable: {name}").into())
}

fn database_max_connections() -> Result<u32, Box<dyn std::error::Error>> {
    let value = match env::var("DATABASE_MAX_CONNECTIONS") {
        Ok(value) => value,
        Err(env::VarError::NotPresent) => return Ok(DEFAULT_DATABASE_MAX_CONNECTIONS),
        Err(error) => return Err(error.into()),
    };

    let max_connections: u32 = value.parse().map_err(|_| {
        "DATABASE_MAX_CONNECTIONS must be a positive whole number (for example, 5)."
    })?;
    if max_connections == 0 {
        return Err("DATABASE_MAX_CONNECTIONS must be greater than zero.".into());
    }
    Ok(max_connections)
}

/// Keep capability-like paths and personal handles out of application logs.
/// Request query strings are never included, and dynamic route components are
/// replaced with their route label before a tracing span is created.
fn request_log_path(path: &str) -> &str {
    if path.starts_with("/invites/") {
        "/invites/:code"
    } else if path.starts_with("/api/attachments/") {
        "/api/attachments/:id"
    } else if path.starts_with("/api/conversations/") {
        "/api/conversations/:id"
    } else if path.starts_with("/api/friends/requests/") {
        "/api/friends/requests/:id/respond"
    } else if path.starts_with("/api/friends/") {
        "/api/friends/:id"
    } else if path.starts_with("/api/explore/cards/") {
        "/api/explore/cards/:id/action"
    } else if path.starts_with("/api/users/") {
        "/api/users/:id"
    } else {
        path
    }
}

async fn connect_database(
    database_url: &str,
    max_connections: u32,
) -> Result<PgPool, Box<dyn std::error::Error>> {
    // Do not permit a URL without `sslmode=require` to silently fall back to an
    // unencrypted Postgres connection. Supabase poolers support TLS.
    let connect_options: PgConnectOptions = database_url
        .parse()
        .map_err(|_| -> Box<dyn std::error::Error> {
            "SUPABASE_DB_URL must be a valid PostgreSQL connection URL. Percent-encode special characters in the password."
                .into()
        })?;
    let connect_options = connect_options.ssl_mode(PgSslMode::Require);

    for attempt in 1..=DATABASE_CONNECT_ATTEMPTS {
        match PgPoolOptions::new()
            .max_connections(max_connections)
            .acquire_timeout(DATABASE_ACQUIRE_TIMEOUT)
            .connect_with(connect_options.clone())
            .await
        {
            Ok(pool) => return Ok(pool),
            Err(error) if attempt < DATABASE_CONNECT_ATTEMPTS => {
                let delay = Duration::from_secs(u64::from(attempt) * 2);
                warn!(
                    attempt,
                    max_attempts = DATABASE_CONNECT_ATTEMPTS,
                    retry_after_seconds = delay.as_secs(),
                    error = %error,
                    "database connection unavailable; retrying"
                );
                tokio::time::sleep(delay).await;
            }
            Err(error) => {
                return Err(format!(
                    "Database connection was not acquired after {DATABASE_CONNECT_ATTEMPTS} attempts \
                     (each waited up to {} seconds): {error}. Confirm SUPABASE_DB_URL is the \
                     Supabase pooler's SSL connection string and that the pooler is accepting new clients.",
                    DATABASE_ACQUIRE_TIMEOUT.as_secs(),
                )
                .into());
            }
        }
    }

    unreachable!("the connection loop always returns")
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    dotenvy::dotenv().ok();
    tracing_subscriber::fmt()
        .with_env_filter(tracing_subscriber::EnvFilter::from_default_env())
        .init();

    let supabase = SupabaseConfig::from_environment()?;
    let database_url = required_env("SUPABASE_DB_URL")?;
    let port = env::var("PORT").unwrap_or_else(|_| "8080".into());
    let allowed_origins = allowed_origins()?;
    let cors_origins: Vec<HeaderValue> = allowed_origins
        .iter()
        .map(|origin| origin.parse())
        .collect::<Result<_, _>>()?;
    let database_max_connections = database_max_connections()?;

    let db = connect_database(&database_url, database_max_connections).await?;
    sqlx::migrate!("./migrations").run(&db).await?;

    let (events, _) = broadcast::channel(EVENT_BUFFER_SIZE);
    let state = AppState {
        db,
        http: Client::new(),
        supabase,
        events,
        online_users: Arc::new(Mutex::new(HashMap::new())),
        allowed_origins: Arc::new(allowed_origins.clone()),
        limits: limits::RateLimiter::default(),
    };

    // Delivery time is the only metadata retained for scheduled envelopes. The
    // worker promotes due ciphertext into the ordinary opaque-message stream.
    let scheduled_state = state.clone();
    tokio::spawn(async move {
        let mut ticker = tokio::time::interval(Duration::from_secs(5));
        loop {
            ticker.tick().await;
            if let Err(error) = ws::deliver_due_scheduled_messages(&scheduled_state).await {
                warn!(?error, "Could not deliver scheduled envelopes");
            }
            routes::upload::cleanup_expired_attachments(&scheduled_state).await;
            routes::calls::cleanup_expired_calls(&scheduled_state).await;
        }
    });

    // Unauthenticated: proving key ownership is what gets you a token.
    let auth_api = Router::new()
        .route("/challenge", post(auth::challenge))
        .route("/register", post(auth::register))
        .route("/login", post(auth::login))
        // Authentication requests consist solely of public keys and signatures.
        // Keep malformed requests from claiming the attachment upload budget.
        .layer(RequestBodyLimitLayer::new(AUTH_BODY_LIMIT_BYTES));

    let protected_api = Router::new()
        .route("/growth", get(routes::users::get_growth))
        .route(
            "/users/me",
            get(routes::users::get_current_user).patch(routes::users::update_current_user),
        )
        .route("/users/search", get(routes::users::search_users))
        .route("/users/{id}", get(routes::users::get_user))
        .route("/users/me/kex-key", post(auth::attest_kex_key))
        .route(
            "/explore/profile",
            get(routes::explore::get_profile).put(routes::explore::put_profile),
        )
        .route("/explore/cards", get(routes::explore::get_cards))
        .route("/explore/cards/{id}/like", post(routes::explore::like_card))
        .route("/explore/cards/{id}/pass", post(routes::explore::pass_card))
        .route("/explore/cards/{id}/block", post(routes::explore::block_card))
        .route("/explore/cards/{id}/report", post(routes::explore::report_card))
        .route("/explore/matches", get(routes::explore::get_matches))
        .route("/auth/logout", post(auth::logout))
        .route("/ws-ticket", post(auth::issue_ws_ticket))
        .route("/webrtc/ice-servers", get(routes::webrtc::get_ice_servers))
        .route("/calls/pending", get(routes::calls::get_pending_calls))
        .route("/push-subscriptions", post(routes::calls::upsert_push_subscription).delete(routes::calls::delete_push_subscription))
        .route("/invite", get(routes::users::get_invite))
        .route("/friends", get(routes::friends::get_friends))
        .route("/friends/{id}", delete(routes::friends::remove_friend))
        .route(
            "/friends/requests/count",
            get(routes::friends::get_pending_requests_count),
        )
        .route(
            "/friends/request",
            post(routes::friends::send_friend_request),
        )
        .route(
            "/friends/requests/{id}/respond",
            post(routes::friends::respond_friend_request),
        )
        .route(
            "/conversations",
            get(routes::conversations::list_conversations),
        )
        .route(
            "/conversations/{id}/messages",
            get(routes::conversations::get_messages),
        )
        .route(
            "/conversations/{id}/receipts",
            get(routes::conversations::get_receipts),
        )
        .route(
            "/conversations/{id}/read",
            post(routes::conversations::mark_read),
        )
        .route("/upload", post(routes::upload::upload_file))
        .route("/attachments/{id}", get(routes::upload::download_file))
        .layer(middleware::from_fn_with_state(state.clone(), auth::require_auth));

    let app = Router::new()
        .route("/health", get(health))
        .route("/invites/{code}", get(routes::users::lookup_invite))
        .route("/ws", get(ws::websocket_handler))
        .nest("/auth", auth_api)
        .nest("/api", protected_api)
        .layer(DefaultBodyLimit::max(MAX_UPLOAD_BYTES))
        .layer(
            CorsLayer::new()
                .allow_origin(
                    cors_origins,
                )
                .allow_methods([Method::GET, Method::POST, Method::PUT, Method::PATCH, Method::DELETE, Method::OPTIONS])
                .allow_headers([AUTHORIZATION, CONTENT_TYPE]),
        )
        .layer(middleware::map_response(security_headers))
        // Authentication and WebSocket-ticket headers must never be emitted in
        // request spans. Dynamic path values and query strings are also redacted
        // before logging, so invite capabilities and account metadata stay out
        // of routine Render logs.
        .layer(TraceLayer::new_for_http().make_span_with(|request: &axum::http::Request<_>| {
            info_span!(
                "http.request",
                method = %request.method(),
                path = request_log_path(request.uri().path()),
            )
        }))
        .with_state(state);

    if routes::calls::push_configured() {
        info!("Background alerts enabled: calls and messages will reach closed apps.");
    } else {
        warn!(
            "WEB_PUSH_VAPID_PRIVATE_KEY / WEB_PUSH_VAPID_SUBJECT are not set. \
             Calls and messages will NOT notify anyone whose app is closed."
        );
    }

    let address: SocketAddr = format!("0.0.0.0:{port}").parse()?;
    let listener = tokio::net::TcpListener::bind(address).await?;
    info!(%address, "Timber backend listening");
    axum::serve(listener, app)
        .with_graceful_shutdown(shutdown_signal())
        .await?;
    Ok(())
}

/// Application readiness for Render. A healthy socket without Postgres cannot
/// deliver messages, so the probe includes a tiny pooled database query.
async fn health(State(state): State<AppState>) -> Result<Json<Value>, error::ApiError> {
    sqlx::query_scalar::<_, i32>("SELECT 1")
        .fetch_one(&state.db)
        .await?;
    // The running version, so a report from a user can be tied to a build
    // without guessing which deploy they are talking to. It is the same number
    // the frontend shows in settings.
    Ok(Json(json!({ "status": "ok", "version": env!("CARGO_PKG_VERSION") })))
}

/// Render sends SIGTERM while redeploying. Stop accepting new connections while
/// allowing Axum to finish in-flight responses during the platform grace period.
async fn shutdown_signal() {
    let ctrl_c = async {
        signal::ctrl_c().await.expect("could not install Ctrl+C signal handler");
    };
    #[cfg(unix)]
    {
        let terminate = async {
            signal::unix::signal(signal::unix::SignalKind::terminate())
                .expect("could not install SIGTERM handler")
                .recv()
                .await;
        };
        tokio::select! {
            _ = ctrl_c => {},
            _ = terminate => {},
        }
    }
    #[cfg(not(unix))]
    ctrl_c.await;
    info!("shutdown signal received");
}

async fn security_headers(mut response: axum::response::Response) -> axum::response::Response {
    let headers = response.headers_mut();
    headers.insert("cache-control", "no-store".parse().expect("static header"));
    headers.insert(
        "strict-transport-security",
        "max-age=63072000; includeSubDomains; preload"
            .parse()
            .expect("static header"),
    );
    headers.insert("x-content-type-options", "nosniff".parse().expect("static header"));
    headers.insert("x-frame-options", "DENY".parse().expect("static header"));
    headers.insert("x-xss-protection", "0".parse().expect("static header"));
    headers.insert(
        "x-permitted-cross-domain-policies",
        "none".parse().expect("static header"),
    );
    headers.insert("referrer-policy", "no-referrer".parse().expect("static header"));
    headers.insert(
        "cross-origin-opener-policy",
        "same-origin".parse().expect("static header"),
    );
    headers.insert(
        "cross-origin-resource-policy",
        "same-origin".parse().expect("static header"),
    );
    headers.insert(
        "origin-agent-cluster",
        "?1".parse().expect("static header"),
    );
    headers.insert(
        "permissions-policy",
        "camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()"
            .parse()
            .expect("static header"),
    );
    headers.insert(
        "content-security-policy",
        "default-src 'none'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'none'"
            .parse()
            .expect("static header"),
    );
    response
}

#[cfg(test)]
mod tests {
    use super::request_log_path;

    #[test]
    fn request_spans_redact_capabilities_and_dynamic_account_paths() {
        assert_eq!(request_log_path("/invites/ABCD1234"), "/invites/:code");
        assert_eq!(request_log_path("/api/conversations/a/b"), "/api/conversations/:id");
        assert_eq!(request_log_path("/health"), "/health");
    }

    /// Two migrations sharing a version number is not a build error: it fails at
    /// startup, against the live database, as `VersionMismatch`, because the
    /// checksum recorded for that version cannot match both files. Catch it here
    /// instead, where it costs nothing.
    #[test]
    fn migration_versions_are_unique() {
        let mut seen: std::collections::HashMap<u32, String> = std::collections::HashMap::new();
        for entry in std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/migrations"))
            .expect("migrations directory is readable")
        {
            let name = entry.expect("readable entry").file_name().to_string_lossy().into_owned();
            if !name.ends_with(".sql") {
                continue;
            }
            let (prefix, _) = name.split_once('_').unwrap_or_else(|| {
                panic!("migration {name} must be named <version>_<description>.sql")
            });
            let version: u32 = prefix
                .parse()
                .unwrap_or_else(|_| panic!("migration {name} must start with a numeric version"));
            if let Some(existing) = seen.insert(version, name.clone()) {
                panic!("migrations {existing} and {name} share version {version}");
            }
        }
        assert!(seen.len() >= 9, "expected the full migration set, found {}", seen.len());
    }
}
