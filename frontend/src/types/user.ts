// Public profile data. None of this is conversation content: it is what the
// relay already knows and what a peer is shown.

export interface User {
  id: string;
  username: string;
  avatar_url: string | null;
  level: number;
  level_name: string;
  next_level_name: string | null;
  growth_points: number;
  /** Progress within the current stage, and what the next one costs. */
  growth_for_stage: number;
  growth_into_stage: number;
  streak_days: number;
}

/** A peer as carried on a conversation. A strict subset of `User`. */
export interface Peer {
  id: string;
  username: string;
  level: number;
  level_name: string;
  /** Long-term public keys. Verified against the stored copy on every sync. */
  identity_pk?: string;
  kex_pk?: string;
}

export interface GrowthStage {
  level: number;
  name: string;
  threshold: number;
}

export interface GrowthLadder {
  stages: GrowthStage[];
  practices: { key: string; label: string; points: number }[];
  daily_growth_ceiling: number;
}

export interface LevelUp {
  level: number;
  name: string;
}

export type FriendshipState = "friends" | "pending_sent" | "pending_received" | "none";

export interface FriendRequest {
  id: string;
  username: string;
  level?: number;
  level_name?: string;
}

export interface Friendships {
  friends: Peer[];
  pending_received: FriendRequest[];
  pending_sent: FriendRequest[];
}
