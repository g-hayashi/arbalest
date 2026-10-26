/** Teams の Markdown。可変の文字列を無効化し、取得済み根拠のリンクだけをコードで生成する。 */
import type { FindingTheme } from "../analysis/findings.js";
import type { SummaryItemBase, SummaryModel } from "../slack/render.js";
import { type RequestPeriod, tsToDate } from "../util/time.js";
import type { TeamsTodoOutcome } from "./todos.js";

export const TEAMS_MESSAGE_LIMIT = 8000;
export const TEAMS_UNSUPPORTED_NOTE =
  "Teams では ToDo の登録・完了・リマインド、canvas 相当の外部記録は未対応です。ToDo は抽出結果の表示のみです。";

export type TeamsSummaryOptions = {
  links: ReadonlyMap<string, string>;
  count: number;
  firstTs: string | null;
  lastTs: string | null;
  work?: TeamsTodoOutcome;
  workEnabled?: boolean;
};

/** 改行による構造の挿入も防ぎ、@メンションと可変URLを平文にする。 */
export function escapeTeamsText(value: string): string {
  return value
    .replace(/[\\`*_{}[\]()#+!|~=]/g, "\\$&")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("@", "&#64;")
    .replaceAll(":", "&#58;")
    .replaceAll("/", "&#47;")
    .replace(/[\r\n\u2028\u2029]+/g, " ");
}

/** 取得mapを使う呼び出し元に加え、表示の境界でも危険なスキームを拒否する。 */
function evidenceUrl(value: string | undefined): string | null {
  if (value === undefined) return null;
  try {
    const url = new URL(value);
    if (
      url.protocol !== "https:" ||
      url.hostname !== "teams.microsoft.com" ||
      url.username !== "" ||
      url.password !== "" ||
      url.port !== ""
    )
      return null;
    const safe = url.href.replaceAll("(", "%28").replaceAll(")", "%29");
    return safe.length <= 2048 ? safe : null;
  } catch {
    return null;
  }
}

/** エスケープの途中やサロゲート対で切らず、根拠は末尾に残す。 */
function itemLine(body: string, suffix: string): string {
  const escaped = escapeTeamsText(body);
  if (escaped.length + suffix.length + 2 <= TEAMS_MESSAGE_LIMIT) return `- ${escaped}${suffix}`;
  const points = Array.from(body);
  const note = "…（長文のため省略）";
  const room = TEAMS_MESSAGE_LIMIT - suffix.length - note.length - 2;
  let low = 0;
  let high = points.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    if (escapeTeamsText(points.slice(0, mid).join("")).length <= room) low = mid;
    else high = mid - 1;
  }
  return `- ${escapeTeamsText(points.slice(0, low).join(""))}${note}${suffix}`;
}

/** 行単位の分割。各行の上限は itemLine で保証する。 */
export function splitTeamsLines(lines: readonly string[]): string[] {
  const messages: string[] = [];
  let current = "";
  for (const line of lines) {
    if (line.length > TEAMS_MESSAGE_LIMIT) throw new RangeError("Teams の表示行が上限を超えました");
    if (current !== "" && current.length + line.length + 1 > TEAMS_MESSAGE_LIMIT) {
      messages.push(current);
      current = "";
    }
    current = current === "" ? line : `${current}\n${line}`;
  }
  if (current !== "") messages.push(current);
  return messages;
}

function evidenceSuffix(
  item: Pick<SummaryItemBase, "evidence" | "needsReview">,
  map: ReadonlyMap<string, string>,
): string {
  const urls = [
    ...new Set(
      item.evidence
        .map((id) => evidenceUrl(map.get(id)))
        .filter((url): url is string => url !== null),
    ),
  ];
  const missing =
    item.evidence.length === 0 || item.evidence.some((id) => evidenceUrl(map.get(id)) === null);
  const review = item.needsReview || missing ? " ⚠️ 要確認" : "";
  const links = urls
    .slice(0, 3)
    .map((url, i) => `[根拠${i + 1}](${url})`)
    .join(" ");
  return `${review}${links === "" ? "" : ` ${links}`}`;
}

export function renderTeamsSummary(model: SummaryModel, options: TeamsSummaryOptions): string[] {
  const range =
    options.firstTs !== null && options.lastTs !== null
      ? `${tsToDate(options.firstTs).toISOString()} 〜 ${tsToDate(options.lastTs).toISOString()}`
      : "取得範囲なし";
  const lines = [
    "## 会話のまとめ",
    `スレッド / 投稿${options.count}件 / ${range}`,
    ...(options.work ? [] : [TEAMS_UNSUPPORTED_NOTE]),
  ];
  const group = <T extends SummaryItemBase>(
    title: string,
    items: readonly T[],
    body: (item: T) => string,
  ) => {
    if (items.length === 0) return;
    lines.push(`## ${title}`);
    for (const item of items) lines.push(itemLine(body(item), evidenceSuffix(item, options.links)));
  };
  group("会話の概要", model.overview ?? [], (item) => item.text);
  group(
    "決定事項",
    model.topics.filter((item) => item.status === "decided"),
    (item) => `${item.title}: ${item.decision ?? ""}`,
  );
  group(
    "未決定事項",
    model.topics.filter((item) => item.status === "open"),
    (item) =>
      `${item.title}${item.options.length > 0 ? ` / 候補: ${item.options.join("、")}` : ""}${item.pendingParticipants.length > 0 ? ` / 回答待ち: ${item.pendingParticipants.join("、")}` : ""}`,
  );
  group(
    options.work ? "抽出したToDo" : "ToDo（表示のみ）",
    options.work ? [] : model.todos,
    (item) =>
      `${item.text} / 担当: ${item.assignee ?? "未定"} / 期限: ${item.dueIso ?? item.dueText ?? "未定"}`,
  );
  group("未解決の問い", model.questions, (item) => item.text);
  if (options.work) {
    const workEvidence = (evidence: { link: string }[], review = false) => {
      const links = new Map(evidence.map((item, index) => [String(index), item.link]));
      return evidenceSuffix({ evidence: [...links.keys()], needsReview: review }, links);
    };
    lines.push("## 登録済みToDo");
    for (const todo of options.work.todos)
      lines.push(
        itemLine(
          `T${todo.displayNo} ${todo.text} / ${todo.status === "done" ? "完了済み" : "未完了"} / 担当: ${todo.assigneeAadId === null ? "未定（登録者が管理）" : (options.work.names[todo.assigneeAadId] ?? todo.assigneeAadId)} / 期限: ${todo.dueIso ?? todo.dueText ?? "未定"} / 完了: done T${todo.displayNo}`,
          workEvidence(todo.evidence),
        ),
      );
    if (options.work.todos.length === 0) lines.push("登録済みToDoはありません。");
    for (const [index, entry] of options.work.candidates.entries()) {
      if (entry.match?.kind === "existing") continue;
      lines.push(
        itemLine(
          `候補${index + 1}: ${entry.candidate.text} / ${entry.rejected ? "根拠不一致・登録不可" : entry.match?.kind === "ambiguous" ? "関連付けか別件登録が必要" : entry.match?.kind === "update_proposal" ? "担当者・期限の更新確認が必要" : "登録候補"}`,
          workEvidence(
            entry.candidate.evidence,
            entry.rejected !== null || entry.candidate.needsReview,
          ),
        ),
      );
    }
    if (options.work.rejected.length > 0)
      lines.push("操作できませんでした。一覧を再取得してください。");
  }
  if (
    (model.overview?.length ?? 0) +
      model.topics.length +
      model.todos.length +
      model.questions.length ===
    0
  )
    lines.push("まとめる事項は見つかりませんでした。");
  return splitTeamsLines(lines);
}

export function renderTeamsFindings(
  themes: readonly FindingTheme[],
  options: TeamsSummaryOptions & { period: RequestPeriod },
): string[] {
  const { period } = options;
  const lines = [
    "## Findings",
    itemLine(period.label, ""),
    `対象期間: ${period.start}以上 〜 ${period.end}未満（UTC）`,
    `チャネル / 投稿${options.count}件 / 履歴の対象は最大90日`,
    options.workEnabled
      ? "この依頼では振り返りを返信します。ToDo登録・共有記録は変更しません。"
      : TEAMS_UNSUPPORTED_NOTE,
  ];
  if (options.firstTs !== null && options.lastTs !== null) {
    lines.push(
      `取得範囲: ${tsToDate(options.firstTs).toISOString()} 〜 ${tsToDate(options.lastTs).toISOString()}`,
    );
  }
  if (period.clamped) lines.push("指定の期間が長いため、上限の 90 日に制限しました。");
  let count = 0;
  for (const theme of themes) {
    if (theme.findings.length === 0) continue;
    lines.push("## テーマ", itemLine(theme.theme, ""));
    for (const finding of theme.findings) {
      lines.push(itemLine(finding.statement, evidenceSuffix(finding, options.links)));
      count++;
    }
  }
  if (count === 0) lines.push("この期間の Findings は見つかりませんでした。");
  return splitTeamsLines(lines);
}
