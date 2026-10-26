import type { TeamsScope, TeamsTodoCandidate, TeamsTodoIdentity } from "../todo-identity.js";

export type {
  TeamsEvidence,
  TeamsScope,
  TeamsTodoCandidate,
  TeamsTodoIdentity,
  TeamsWorkErrorCode,
} from "../todo-identity.js";
export { TeamsWorkError } from "../todo-identity.js";

export type TeamsTodo = TeamsTodoIdentity & {
  targetId: string;
  displayNo: number;
  createdByAadId: string;
  revision: number;
  createdAt: string;
  lastHumanUpdatedAt: string;
  expireAt: Date;
  doneBy: string | null;
  doneAt: string | null;
};
/** SDKで認証済みのactivityからだけ構築する。URLをカードdataから受け取らない。 */
export type TeamsConversationReference = { serviceUrl: string; conversationId: string };
export type TeamsThreadSettings = {
  scope: TeamsScope;
  targetId: string;
  nextDisplayNo: number;
  managerAadId: string;
  notificationsEnabled: boolean;
  disabled: boolean;
  serviceUrl: string | null;
  conversationId: string | null;
  createdAt: string;
  lastHumanUpdatedAt: string;
  expireAt: Date;
};
export type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };
export type TeamsSnapshot = {
  scope: TeamsScope;
  revision: number;
  slots: string[];
  todos: TeamsTodo[];
  /** 検証済み分析の表示確定値。生成済みの値だけを渡し、再試行でAIを呼ばない。 */
  content?: JsonValue;
};
export type TeamsSlot = {
  slot: number;
  text: string;
  scope: TeamsScope;
  botOwned: boolean;
  activityId: string | null;
  appliedRevision: number;
  state: "pending" | "creating" | "applied" | "failed" | "delivery_unknown" | "deleted" | "retired";
};
export type TeamsSharePointState = {
  siteId: string;
  listId: string;
  arbalestKey: string;
  itemId: string | null;
  etag: string | null;
  appliedRevision: number;
  appliedHash: string | null;
  pendingRevision: number | null;
  pendingHash: string | null;
  pendingGeneratedFields: Record<string, string> | null;
  state: "pending" | "applied" | "failed" | "conflict" | "too_large";
};
export type TeamsProgress = Partial<
  Record<
    "analysis" | "ledger" | "teams" | "sharepoint" | "reply",
    "pending" | "applied" | "failed" | "delivery_unknown" | "disabled"
  >
>;
export type TeamsRecord = {
  scope: TeamsScope;
  targetId: string;
  desiredRevision: number;
  snapshot: TeamsSnapshot;
  snapshotHash: string;
  operationId: string;
  slots: TeamsSlot[];
  sharepoint: TeamsSharePointState | null;
  progress: TeamsProgress;
  expireAt: Date;
};
export type TeamsEffectKind = "record" | "reminder" | "sharepoint" | "reply";
export type TeamsEffectState =
  | "pending"
  | "running"
  | "applied"
  | "failed"
  | "delivery_unknown"
  | "cancelled";
export type TeamsEffect = {
  operationId: string;
  scope: TeamsScope;
  targetId: string;
  kind: TeamsEffectKind;
  revision: number;
  snapshot: TeamsSnapshot;
  snapshotHash: string;
  slots: TeamsSlot[];
  state: TeamsEffectState;
  attempts: number;
  /** 通知のRetry-After。snapshotを変更せず再試行時刻を保持する。 */
  nextAttemptAt?: Date | null;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  fencingToken: number;
  expireAt: Date;
};
export type TeamsEffectLease = TeamsEffect & { leaseOwner: string; leaseUntil: Date };
export type TeamsAction =
  | "register"
  | "link"
  | "confirm_update"
  | "done"
  | "notifications_off"
  | "notifications_on";
export type TeamsActionRef = {
  tokenHash: string;
  scope: TeamsScope;
  targetId: string;
  sourceActivityId: string;
  action: TeamsAction;
  todoId: string | null;
  candidate: TeamsTodoCandidate | null;
  expectedRevision: number | null;
  issuedByAadId: string;
  allowedActorAadIds: string[];
  explicitNew: boolean;
  createdAt: string;
  expireAt: Date;
};
export type TeamsHumanInput = {
  scope: TeamsScope;
  actorAadId: string;
  now: Date;
  /** 抑止と明示ToDo操作は外部記録を新規に有効化しない。未指定は既存ストア契約を維持。 */
  recordPolicy?: "always" | "existing_only" | "none";
};
export type TeamsSettingsInput = TeamsHumanInput & { reference?: TeamsConversationReference };
export type TeamsRegisterInput = TeamsSettingsInput & {
  /** 根拠本文との一致/参加者を上流で検証済みの候補だけを渡す。Storeは構造/同一性/期限/auto条件を再検査する。 */
  requestId: string;
  candidate: TeamsTodoCandidate;
  mode: "new" | "link";
  todoId?: string;
  expectedRevision?: number;
  automatic?: boolean;
  explicitNew?: boolean;
};
export type TeamsDoneInput = TeamsHumanInput & {
  todoId?: string;
  displayNo?: number;
  expectedRevision: number;
};
export type TeamsUpdateInput = TeamsDoneInput & { candidate: TeamsTodoCandidate };
export type TeamsNotificationInput = TeamsHumanInput & { enabled: boolean };
export type TeamsActionRefInput = TeamsHumanInput & {
  tokenHash: string;
  sourceActivityId: string;
  action: TeamsAction;
  todoId?: string;
  candidate?: TeamsTodoCandidate;
  expectedRevision?: number;
  allowedActorAadIds?: string[];
  explicitNew?: boolean;
  expireAt: Date;
};
export type TeamsEffectInput = {
  operationId: string;
  scope: TeamsScope;
  kind: TeamsEffectKind;
  revision: number;
  snapshot: TeamsSnapshot;
  expireAt: Date;
  now: Date;
};
export type TeamsLeaseInput = {
  scope: TeamsScope;
  operationId: string;
  owner: string;
  fencingToken: number;
  now: Date;
};
export type TeamsEffectSaveInput = TeamsLeaseInput & {
  state?: TeamsEffectState;
  slots?: TeamsSlot[];
  nextAttemptAt?: Date | null;
};
export type TeamsRecordSaveInput = TeamsLeaseInput & {
  revision: number;
  snapshot: TeamsSnapshot;
  slots?: TeamsSlot[];
  sharepoint?: TeamsSharePointState | null;
  progress?: TeamsProgress;
};
export type TeamsRecordReserveInput = TeamsHumanInput & {
  snapshot: TeamsSnapshot;
  expectedRevision: number;
};
/** 外部投稿の所有検証は呼出し元の復旧サービスで行い、未検証payloadを直接渡さない。 */
export type TeamsRecordRecoveryInput = TeamsHumanInput & {
  expectedRevision: number;
  slot: number;
  activityId: string | null;
};
export type TeamsMutationResult = { todo: TeamsTodo; changed: boolean };
export type TeamsWorkStoreOptions = {
  now?: () => Date;
  newId?: () => string;
  leaseMs?: number;
  /** 同一transaction内で呼ぶ純粋な表示関数。外部呼出し/乱数/時刻取得は禁止。 */
  renderSnapshot?: (input: {
    scope: TeamsScope;
    revision: number;
    todos: TeamsTodo[];
    previous: TeamsSnapshot | null;
  }) => TeamsSnapshot;
};

export interface TeamsWorkStore {
  getTodos(scope: TeamsScope): Promise<TeamsTodo[]>;
  getSettings(scope: TeamsScope): Promise<TeamsThreadSettings | null>;
  listSettings(): Promise<TeamsThreadSettings[]>;
  ensureSettings(input: TeamsSettingsInput): Promise<TeamsThreadSettings>;
  disableThread(input: { scope: TeamsScope; now: Date }): Promise<void>;
  /** 自動停止。人操作時刻・保持期限を延長しない。 */
  stopNotifications(input: { scope: TeamsScope; now: Date }): Promise<void>;
  register(input: TeamsRegisterInput): Promise<TeamsMutationResult>;
  confirmUpdate(input: TeamsUpdateInput): Promise<TeamsMutationResult>;
  markDone(input: TeamsDoneInput): Promise<TeamsMutationResult>;
  setNotifications(input: TeamsNotificationInput): Promise<TeamsThreadSettings>;
  putActionRef(input: TeamsActionRefInput): Promise<void>;
  getActionRef(tokenHash: string): Promise<TeamsActionRef | null>;
  reserveEffect(input: TeamsEffectInput): Promise<{ effect: TeamsEffect; created: boolean }>;
  getEffect(operationId: string): Promise<TeamsEffect | null>;
  claimEffect(
    operationId: string,
    owner: string,
    now: Date,
    options?: { reapply?: boolean },
  ): Promise<TeamsEffectLease | null>;
  extendEffectLease(input: TeamsLeaseInput): Promise<TeamsEffectLease>;
  saveEffect(input: TeamsEffectSaveInput): Promise<void>;
  getRecord(scope: TeamsScope): Promise<TeamsRecord | null>;
  listRecords(): Promise<TeamsRecord[]>;
  /** 明示canvas等。台帳変更を伴わない場合もrecordとeffectを同時予約する。 */
  reserveRecord(input: TeamsRecordReserveInput): Promise<TeamsRecord>;
  saveRecord(input: TeamsRecordSaveInput): Promise<void>;
  recoverRecord(input: TeamsRecordRecoveryInput): Promise<void>;
}
