/**
 * ストアの型とインタフェース（data-model.md の「コレクション」、R3、R9、R13）。
 * 実装はメモリ（src/store/memory）と Firestore（src/store/firestore）の 2 つ。
 * 時刻は UTC の ISO 文字列、日付は JST の `YYYY-MM-DD`。`expireAt` だけは TTL のために Date で持つ。
 */

// ---- AnalysisState（data-model.md の AnalysisState） ----

export type Certainty = "explicit" | "implied" | "uncertain";

/** 項目に共通の「要確認」の印。 */
export type ReviewFlags = {
  needsReview: boolean;
  reviewReasons: string[];
};

export type OptionItem = ReviewFlags & {
  id: string;
  label: string;
  dateIso: string | null;
  evidence: string[];
};

export type TopicItem = ReviewFlags & {
  id: string;
  title: string;
  evidence: string[];
  /** 参加者の短い ID（`p1` など）。 */
  requiredParticipants: string[];
  options: OptionItem[];
  /** decide.ts が計算する値。保存はしてもしなくてもよい。 */
  status?: "decided" | "open";
};

export type ResponseItem = ReviewFlags & {
  id: string;
  topicId: string;
  optionId: string | null;
  participant: string;
  answer: "yes" | "no" | "maybe";
  certainty: Certainty;
  evidence: string[];
  quote: string;
  supersededBy: string | null;
};

export type StatementItem = ReviewFlags & {
  id: string;
  topicId: string;
  optionId: string | null;
  text: string;
  certainty: Certainty;
  evidence: string[];
  quote: string;
};

export type TodoItem = ReviewFlags & {
  id: string;
  text: string;
  assignee: string | null;
  dueIso: string | null;
  dueText: string | null;
  certainty: Certainty;
  evidence: string[];
  quote: string;
  closed: boolean;
};

export type QuestionItem = ReviewFlags & {
  id: string;
  text: string;
  evidence: string[];
  quote: string;
  closed: boolean;
};

/** 根拠付きの会話概要。旧保存状態には overview がないため、読み込み時は空として扱う。 */
export type OverviewItem = ReviewFlags & {
  id: string;
  text: string;
  evidence: string[];
  quote: string;
};

/** 抽出した事実。 */
export type AnalysisState = {
  overview?: OverviewItem[];
  topics: TopicItem[];
  responses: ResponseItem[];
  statements: StatementItem[];
  todos: TodoItem[];
  questions: QuestionItem[];
};

export function emptyAnalysisState(): AnalysisState {
  return { overview: [], topics: [], responses: [], statements: [], todos: [], questions: [] };
}

export function normalizeAnalysisState(state: AnalysisState): AnalysisState {
  return { ...state, overview: state.overview ?? [] };
}

// ---- targets ----

export type Participant = { id: string; userId: string; name: string };

export type TargetDoc = {
  targetId: string;
  kind: "thread" | "channel";
  channelId: string;
  threadTs: string | null;
  lastAnalyzedTs: string;
  /** ts → 本文（編集後）とリアクションの sha1 の先頭 12 文字。 */
  analyzedDigest: Record<string, string>;
  promptVersion: string;
  participants: Participant[];
  state: AnalysisState;
  /** 項目 ID の採番（接頭辞 → 最後に使った番号）。 */
  nextSeq: Record<string, number>;
  canvasSectionMarker: string | null;
  /** 保存時にストアが設定する。 */
  updatedAt: string;
  expireAt: Date;
};

/** `put` に渡す値。`updatedAt` と `expireAt` はストアが now から決める。 */
export type TargetInput = Omit<TargetDoc, "updatedAt" | "expireAt">;

export interface TargetsRepo {
  get(targetId: string): Promise<TargetDoc | null>;
  /** 全体を置き換える。updatedAt = now、expireAt = now + 90 日。 */
  put(target: TargetInput): Promise<TargetDoc>;
}

// ---- todos ----

export type TodoStatus = "open" | "done";

export type TodoDoc = {
  /** `${targetId}_${itemId}` */
  todoId: string;
  targetId: string;
  itemId: string;
  channelId: string;
  threadTs: string;
  text: string;
  dueIso: string | null;
  dueText: string | null;
  /** null は「未定」。リマインドは createdBy に送る。 */
  assigneeUserId: string | null;
  createdBy: string;
  status: TodoStatus;
  /** ボットが返信した一覧のメッセージの ts（✅ の対象）。 */
  listMessageTs: string;
  /** 根拠のメッセージの ts（✅ の対象）。 */
  sourceTs: string[];
  /** `YYYY-MM-DD`（JST）。同じ日に二重に送らない。 */
  lastRemindedOn: string | null;
  doneBy: string | null;
  doneAt: string | null;
  createdAt: string;
  updatedAt: string;
  /** 完了から 90 日、未完了なら最後の更新から 90 日。 */
  expireAt: Date;
};

export type TodoInput = {
  targetId: string;
  itemId: string;
  channelId: string;
  threadTs: string;
  text: string;
  dueIso: string | null;
  dueText: string | null;
  assigneeUserId: string | null;
  createdBy: string;
  listMessageTs: string;
  sourceTs: string[];
};

export function todoIdOf(targetId: string, itemId: string): string {
  return `${targetId}_${itemId}`;
}

export interface TodosRepo {
  get(todoId: string): Promise<TodoDoc | null>;
  /**
   * 登録する。無ければ `open` で作る。
   * 既にあって未完了なら、text、dueIso、dueText、assigneeUserId、listMessageTs、sourceTs だけを更新する
   * （createdBy は最初の値のまま）。完了済みなら何も変えずに現在の値を返す。
   */
  upsert(input: TodoInput): Promise<TodoDoc>;
  /** listMessageTs か sourceTs が messageTs に一致する ToDo（状態を問わない）。 */
  findByMessageTs(channelId: string, messageTs: string): Promise<TodoDoc[]>;
  /**
   * `open → done`。無ければ null。既に完了していれば changed = false で何も変えない。
   * expireAt は完了時刻から 90 日。
   */
  markDone(todoId: string, userId: string): Promise<{ todo: TodoDoc; changed: boolean } | null>;
  /** リマインドの対象（contracts/http-and-tasks.md#リマインドの対象）。today は現在時刻（JST の日付に直して使う）。 */
  findDueForReminder(today: Date): Promise<TodoDoc[]>;
  /** lastRemindedOn を設定する。updatedAt と expireAt は変えない。 */
  markReminded(todoIds: string[], today: Date): Promise<void>;
}

// ---- canvases / chunk_cache ----

export type CanvasDoc = { channelId: string; canvasId: string; createdAt: string };

export interface CanvasesRepo {
  get(channelId: string): Promise<CanvasDoc | null>;
  /** 上書きする。 */
  set(channelId: string, canvasId: string): Promise<CanvasDoc>;
}

export interface ChunkCacheRepo {
  /** key は呼び出し側が計算した sha256。無ければ null。 */
  get(key: string): Promise<unknown[] | null>;
  /** expireAt = now + 90 日。 */
  put(key: string, value: unknown[]): Promise<void>;
}

// ---- processed_events / job_locks ----

export type RequestProgressInput = {
  targetId: string;
  channelId: string;
  threadTs: string;
  mentionTs: string;
  /** 記録用。再試行で実体との照合を省くためには使わない。 */
  stages: Partial<Record<"todos" | "canvas" | "reply", "done" | "skipped" | "failed">>;
  /** summary:0、todos:0 など、同一依頼内の投稿と Slack ts の対応。 */
  messages: Record<string, string>;
  /** Teams の送信前に固定した表示結果。元会話・依頼本文は含めず、既存進捗と同じ TTL で保存する。 */
  replyChunks?: string[];
};
export type RequestProgress = RequestProgressInput & { updatedAt: string; expireAt: Date };

export interface EventsRepo {
  /** 初めてなら true、既にあれば false（`create()` 相当）。expireAt = now + 7 日。 */
  markProcessed(taskName: string): Promise<boolean>;
  getRequestProgress(taskName: string): Promise<RequestProgress | null>;
  saveRequestProgress(taskName: string, input: RequestProgressInput): Promise<RequestProgress>;
}

export interface LocksRepo {
  /** リースを取れたら所有者のトークン。有効なリースが他にあれば null。期限切れのリースは取り直せる。 */
  acquire(targetId: string, ttlMs: number): Promise<string | null>;
  /** トークンが一致するときだけ消す。無い・不一致なら何もしない。 */
  release(targetId: string, token: string): Promise<void>;
}

export type Store = {
  targets: TargetsRepo;
  todos: TodosRepo;
  canvases: CanvasesRepo;
  chunkCache: ChunkCacheRepo;
  locks: LocksRepo;
  events: EventsRepo;
};

/** TTL の確認用（テストだけが使う）。 */
export type CollectionName =
  | "targets"
  | "todos"
  | "canvases"
  | "chunk_cache"
  | "processed_events"
  | "job_locks";
