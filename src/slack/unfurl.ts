/**
 * ボットの返信（chat.postMessage）に付ける、リンクのプレビューを出さない指定。
 * canvas や過去の会話のパーマリンクが展開されて返信が長くならないようにする。
 * chat.update には unfurl の引数がないので付けない。
 */
export const NO_UNFURL = { unfurl_links: false, unfurl_media: false } as const;
