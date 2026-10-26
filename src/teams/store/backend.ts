/** Teams専用。Slack StoreのCollectionNameへ追加しない。 */
export const TEAMS_COLLECTIONS = [
  "teams_todos",
  "teams_todo_anchors",
  "teams_thread_settings",
  "teams_records",
  "teams_effects",
  "teams_action_refs",
  "teams_requests",
] as const;
export type TeamsCollection = (typeof TEAMS_COLLECTIONS)[number];
export interface TeamsTransaction {
  get<T>(collection: TeamsCollection, id: string): Promise<T | null>;
  list<T>(collection: TeamsCollection, targetId?: string): Promise<T[]>;
  set<T>(collection: TeamsCollection, id: string, value: T): void;
}
export interface TeamsBackend {
  run<T>(body: (tx: TeamsTransaction) => Promise<T>): Promise<T>;
}
