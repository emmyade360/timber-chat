//! Wire and row types shared across the route modules.
//!
//! Note what is absent: there is no type anywhere that carries message text. The
//! server's vocabulary for a message is (who, which conversation, when, opaque
//! bytes), and that is all these types can express.

use base64::{Engine, engine::general_purpose::STANDARD as BASE64};
use chrono::{DateTime, NaiveDate, Utc};
use serde::{Deserialize, Serialize};
use sqlx::FromRow;
use uuid::Uuid;

use crate::levels;

/// A profile as another user sees it.
#[derive(Serialize, FromRow)]
pub struct PublicProfile {
    pub id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub is_online: bool,
    pub level: i16,
}

/// A user in search results, annotated with where the friendship stands.
#[derive(FromRow)]
pub struct UserSearchRow {
    pub id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub is_online: bool,
    pub level: i16,
    pub friend_status: Option<String>,
    pub attempts: Option<i16>,
}

#[derive(Serialize)]
pub struct SearchResult {
    pub id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub is_online: bool,
    pub level: i16,
    pub level_name: &'static str,
    /// One of `none`, `pending`, `incoming`, `friends`, `rejected`.
    pub friend_status: String,
    /// True when a rejection has already been used and only one attempt remains.
    pub last_chance: bool,
}

impl From<UserSearchRow> for SearchResult {
    fn from(row: UserSearchRow) -> Self {
        let friend_status = row.friend_status.unwrap_or_else(|| "none".into());
        Self {
            id: row.id,
            username: row.username,
            avatar_url: row.avatar_url,
            is_online: row.is_online,
            level: row.level,
            level_name: level_name(row.level),
            last_chance: friend_status == "rejected" && row.attempts == Some(1),
            friend_status,
        }
    }
}

/// The signed-in user's own profile, including progression detail.
#[derive(FromRow)]
pub struct SelfProfileRow {
    pub id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub is_online: bool,
    pub last_seen: Option<DateTime<Utc>>,
    pub growth_points: i64,
    pub level: i16,
    pub streak_days: i32,
    pub last_active_date: Option<NaiveDate>,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct SelfProfile {
    pub id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub is_online: bool,
    pub last_seen: Option<DateTime<Utc>>,
    pub created_at: DateTime<Utc>,
    /// Progression earned from check-ins, messages sent, streaks, friendships
    /// and referrals -- each capped daily so the total cannot be farmed. It
    /// never represents message content, and it is not a health score.
    pub growth_points: i64,
    pub level: i16,
    pub level_name: &'static str,
    pub next_level_name: Option<&'static str>,
    /// Growth earned inside the current stage, and the size of that stage.
    pub growth_into_stage: i64,
    pub growth_for_stage: i64,
    /// Remaining growth to the next stage; `None` at Living Grove.
    pub growth_to_next: Option<i64>,
    pub streak_days: i32,
    pub last_active_date: Option<NaiveDate>,
}

impl From<SelfProfileRow> for SelfProfile {
    fn from(row: SelfProfileRow) -> Self {
        let (growth_into_stage, growth_for_stage) = levels::progress(row.growth_points);
        let next = levels::tier(row.level + 1);
        Self {
            id: row.id,
            username: row.username,
            avatar_url: row.avatar_url,
            is_online: row.is_online,
            last_seen: row.last_seen,
            created_at: row.created_at,
            growth_points: row.growth_points,
            level: row.level,
            level_name: level_name(row.level),
            next_level_name: next.map(|tier| tier.name),
            growth_into_stage,
            growth_for_stage,
            growth_to_next: next.map(|tier| tier.threshold - row.growth_points),
            streak_days: row.streak_days,
            last_active_date: row.last_active_date,
        }
    }
}

/// A friend, with the conversation to open and the public key needed to talk to them.
#[derive(FromRow)]
pub struct FriendRow {
    pub id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub is_online: bool,
    pub level: i16,
    pub kex_pk: Vec<u8>,
    pub identity_pk: Vec<u8>,
    pub kex_key_signature: Option<Vec<u8>>,
    pub conversation_id: Option<Uuid>,
}

#[derive(Serialize)]
pub struct Friend {
    pub id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub is_online: bool,
    pub level: i16,
    pub level_name: &'static str,
    /// Base64 X25519 public key. Public by design: it is one half of an ECDH
    /// exchange and useless without the peer's secret, which never leaves a device.
    pub kex_pk: String,
    /// Ed25519 public key which owns this account and certifies its chat key.
    pub identity_pk: String,
    /// Absent only for legacy accounts that have not attested after the upgrade.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub kex_key_signature: Option<String>,
    pub conversation_id: Option<Uuid>,
}

impl From<FriendRow> for Friend {
    fn from(row: FriendRow) -> Self {
        Self {
            id: row.id,
            username: row.username,
            avatar_url: row.avatar_url,
            is_online: row.is_online,
            level: row.level,
            level_name: level_name(row.level),
            kex_pk: BASE64.encode(&row.kex_pk),
            identity_pk: BASE64.encode(&row.identity_pk),
            kex_key_signature: row.kex_key_signature.map(|signature| BASE64.encode(signature)),
            conversation_id: row.conversation_id,
        }
    }
}

#[derive(FromRow)]
pub struct FriendRequestRow {
    pub id: Uuid,
    pub user_id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub is_online: bool,
    pub level: i16,
    pub created_at: DateTime<Utc>,
}

#[derive(Serialize)]
pub struct FriendRequestView {
    pub id: Uuid,
    pub user_id: Uuid,
    pub username: String,
    pub avatar_url: Option<String>,
    pub is_online: bool,
    pub level: i16,
    pub level_name: &'static str,
    pub created_at: DateTime<Utc>,
}

impl From<FriendRequestRow> for FriendRequestView {
    fn from(row: FriendRequestRow) -> Self {
        Self {
            id: row.id,
            user_id: row.user_id,
            username: row.username,
            avatar_url: row.avatar_url,
            is_online: row.is_online,
            level: row.level,
            level_name: level_name(row.level),
            created_at: row.created_at,
        }
    }
}

#[derive(Serialize)]
pub struct FriendsResponse {
    pub friends: Vec<Friend>,
    pub pending_received: Vec<FriendRequestView>,
    pub pending_sent: Vec<FriendRequestView>,
}

/// A stored message: routing metadata plus a sealed envelope.
#[derive(FromRow)]
pub struct MessageRow {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub sender_id: Uuid,
    pub envelope_version: i16,
    pub nonce: Vec<u8>,
    pub ciphertext: Vec<u8>,
    pub created_at: DateTime<Utc>,
    /// When the recipient's device confirmed it holds the ciphertext.
    pub delivered_at: Option<DateTime<Utc>>,
    /// When the recipient opened it. Always at or after `delivered_at`.
    pub read_at: Option<DateTime<Utc>>,
}

#[derive(Clone, Serialize)]
pub struct StoredMessage {
    pub id: Uuid,
    pub conversation_id: Uuid,
    pub sender_id: Uuid,
    pub envelope_version: i16,
    pub nonce: String,
    pub ciphertext: String,
    pub created_at: DateTime<Utc>,
    /// Receipt state travels with history so a sender that reloads sees the
    /// same ticks it saw before, rather than dropping back to one.
    pub delivered_at: Option<DateTime<Utc>>,
    pub read_at: Option<DateTime<Utc>>,
}

impl From<MessageRow> for StoredMessage {
    fn from(row: MessageRow) -> Self {
        Self {
            id: row.id,
            conversation_id: row.conversation_id,
            sender_id: row.sender_id,
            envelope_version: row.envelope_version,
            nonce: BASE64.encode(&row.nonce),
            ciphertext: BASE64.encode(&row.ciphertext),
            created_at: row.created_at,
            delivered_at: row.delivered_at,
            read_at: row.read_at,
        }
    }
}

/// Receipt state for one of the caller's own messages. Ids and timestamps only.
#[derive(FromRow, Serialize)]
pub struct MessageReceipt {
    pub id: Uuid,
    pub delivered_at: Option<DateTime<Utc>>,
    pub read_at: Option<DateTime<Utc>>,
}

#[derive(FromRow)]
pub struct ConversationRow {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub peer_id: Uuid,
    pub peer_username: String,
    pub peer_avatar_url: Option<String>,
    pub peer_is_online: bool,
    pub peer_level: i16,
    pub peer_kex_pk: Vec<u8>,
    pub peer_identity_pk: Vec<u8>,
    pub peer_kex_key_signature: Option<Vec<u8>>,
    pub last_message_at: Option<DateTime<Utc>>,
}

#[derive(Serialize)]
pub struct Conversation {
    pub id: Uuid,
    pub created_at: DateTime<Utc>,
    pub last_message_at: Option<DateTime<Utc>>,
    pub peer: Friend,
}

impl From<ConversationRow> for Conversation {
    fn from(row: ConversationRow) -> Self {
        Self {
            id: row.id,
            created_at: row.created_at,
            last_message_at: row.last_message_at,
            peer: Friend {
                id: row.peer_id,
                username: row.peer_username,
                avatar_url: row.peer_avatar_url,
                is_online: row.peer_is_online,
                level: row.peer_level,
                level_name: level_name(row.peer_level),
                kex_pk: BASE64.encode(&row.peer_kex_pk),
                identity_pk: BASE64.encode(&row.peer_identity_pk),
                kex_key_signature: row
                    .peer_kex_key_signature
                    .map(|signature| BASE64.encode(signature)),
                conversation_id: Some(row.id),
            },
        }
    }
}

#[derive(Deserialize)]
pub struct SearchQuery {
    pub q: Option<String>,
}

#[derive(Deserialize)]
pub struct HistoryQuery {
    /// Page backwards from this timestamp, for infinite scroll.
    pub before: Option<DateTime<Utc>>,
    pub limit: Option<i64>,
}

pub fn level_name(level: i16) -> &'static str {
    levels::tier(level).map_or("Seed", |tier| tier.name)
}
