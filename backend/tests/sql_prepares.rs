//! Every hand-written statement must at least PREPARE against the real schema.
//!
//! Postgres resolves parameter types at prepare time, which is what catches a
//! mismatched placeholder list -- the exact defect that silently broke calls.
//! `INSERT INTO pending_call_signals (...) SELECT $1, $2, $3, ...` shifted every
//! column by one, so storing an answer or an ICE candidate always failed, and
//! the relay returned before publishing it. No call could ever connect, and
//! neither the compiler nor the test suite noticed.
//!
//! Runs only when TEST_DATABASE_URL is set; CI provides one.

use sqlx::{Connection, PgConnection};
use uuid::Uuid;

/// The statement from `routes::calls::store_pending_signal`.
const STORE_PENDING_SIGNAL: &str =
    "INSERT INTO pending_call_signals (call_id, sender_id, kind, envelope_version, nonce, ciphertext) \
     SELECT $1, $3, $4, $5, $6, $7 WHERE EXISTS (SELECT 1 FROM pending_calls WHERE call_id = $1 \
     AND conversation_id = $2 AND expires_at > NOW() AND (caller_id = $3 OR recipient_id = $3))";

/// The statement from `ws::record_read_receipts`.
const RECORD_READ_RECEIPTS: &str =
    "INSERT INTO read_receipts (message_id, user_id) SELECT m.id, $2 FROM messages m \
     WHERE m.id = ANY($1) AND m.conversation_id = $3 AND m.sender_id <> $2 \
     ON CONFLICT DO NOTHING RETURNING message_id";

async fn connect() -> Option<PgConnection> {
    let url = std::env::var("TEST_DATABASE_URL").ok()?;
    Some(
        PgConnection::connect(&url)
            .await
            .expect("TEST_DATABASE_URL is set, so the database must be reachable"),
    )
}

/// Let Postgres type-check the statement against the live schema.
async fn assert_prepares(db: &mut PgConnection, label: &str, sql: &str) {
    if let Err(error) = sqlx::query(&format!("PREPARE check_{label} AS {sql}"))
        .execute(&mut *db)
        .await
    {
        panic!("{label} does not type-check against the schema: {error}");
    }
    let _ = sqlx::query(&format!("DEALLOCATE check_{label}"))
        .execute(&mut *db)
        .await;
}

#[tokio::test]
async fn hand_written_statements_type_check_against_the_schema() {
    let Some(mut db) = connect().await else {
        eprintln!("TEST_DATABASE_URL is not set; skipping");
        return;
    };
    assert_prepares(&mut db, "store_pending_signal", STORE_PENDING_SIGNAL).await;
    assert_prepares(&mut db, "record_read_receipts", RECORD_READ_RECEIPTS).await;
}

#[tokio::test]
async fn a_call_signal_stores_only_for_a_participant() {
    let Some(mut db) = connect().await else {
        eprintln!("TEST_DATABASE_URL is not set; skipping");
        return;
    };

    let call = Uuid::new_v4();
    let caller = Uuid::new_v4();
    let recipient = Uuid::new_v4();
    let stranger = Uuid::new_v4();

    // pending_calls has foreign keys into both, so the pair and their
    // conversation have to exist before a call can reference them.
    for (id, who) in [(caller, "caller"), (recipient, "recipient")] {
        sqlx::query(
            "INSERT INTO profiles (id, username, identity_pk, kex_pk, invite_code) \
             VALUES ($1, $2, $3, $3, $4)",
        )
        .bind(id)
        // profiles_username_shape allows lowercase, digits and underscore, 3-20 chars.
        .bind(format!("{who}_{}", &id.simple().to_string()[..8]))
        // identity_pk and kex_pk are unique, so derive them from the id.
        .bind(id.as_bytes().repeat(2))
        .bind(id.simple().to_string()[..8].to_uppercase())
        .execute(&mut db)
        .await
        .expect("a profile can be created");
    }

    let conversation: Uuid = sqlx::query_scalar(
        "INSERT INTO conversations (user_a, user_b) VALUES (LEAST($1, $2), GREATEST($1, $2)) RETURNING id",
    )
    .bind(caller)
    .bind(recipient)
    .fetch_one(&mut db)
    .await
    .expect("a conversation can be created");

    sqlx::query(
        "INSERT INTO pending_calls (call_id, conversation_id, caller_id, recipient_id, media, expires_at) \
         VALUES ($1, $2, $3, $4, 'audio', NOW() + interval '2 minutes')",
    )
    .bind(call)
    .bind(conversation)
    .bind(caller)
    .bind(recipient)
    .execute(&mut db)
    .await
    .expect("a pending call can be created");

    async fn store(db: &mut PgConnection, call: Uuid, conversation: Uuid, sender: Uuid, kind: &str) -> u64 {
        sqlx::query(STORE_PENDING_SIGNAL)
            .bind(call)
            .bind(conversation)
            .bind(sender)
            .bind(kind)
            .bind(2i16)
            .bind(vec![0u8; 24])
            .bind(vec![1u8; 8])
            .execute(db)
            .await
            .expect("the statement executes")
            .rows_affected()
    }

    assert_eq!(store(&mut db, call, conversation, recipient, "answer").await, 1);
    assert_eq!(store(&mut db, call, conversation, caller, "ice-candidate").await, 1);
    // Someone outside the call cannot inject signalling into it.
    assert_eq!(store(&mut db, call, conversation, stranger, "ice-candidate").await, 0);

    // The stored rows must carry the right sender and kind, not a shifted column.
    let rows: Vec<(Uuid, String)> =
        sqlx::query_as("SELECT sender_id, kind FROM pending_call_signals WHERE call_id = $1 ORDER BY id")
            .bind(call)
            .fetch_all(&mut db)
            .await
            .expect("the stored signals can be read back");
    assert_eq!(
        rows,
        vec![(recipient, "answer".to_owned()), (caller, "ice-candidate".to_owned())],
    );

    // Cascades clear the call, its signals and the conversation.
    sqlx::query("DELETE FROM profiles WHERE id = ANY($1)")
        .bind(vec![caller, recipient])
        .execute(&mut db)
        .await
        .ok();
}
