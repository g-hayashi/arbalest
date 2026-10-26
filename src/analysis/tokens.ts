/**
 * トークン数の見積もり（R5）。`gpt-tokenizer` の o200k で数える。
 * モデルの実際の数え方とは少し違ってよい（分割と、状態が大きすぎるかの判定に使う目安）。
 */
import { countTokens as countO200k } from "gpt-tokenizer/encoding/o200k_base";

/** 本文に特別なトークンの文字列（`<|endoftext|>` など）があっても例外にせず、普通の文字として数える。 */
const NO_DISALLOWED = { disallowedSpecial: new Set<string>() };

export function countTokens(text: string): number {
  return text === "" ? 0 : countO200k(text, NO_DISALLOWED);
}
