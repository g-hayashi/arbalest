import { describe, expect, it, vi } from "vitest";
import {
  createUserResolver,
  type SlackUsersClient,
  USER_CACHE_TTL_MS,
} from "../../src/slack/users.js";

function fakeUsers(name: string) {
  const info = vi.fn(async ({ user }: { user: string }) => ({
    user: { id: user, profile: { display_name: name } },
  }));
  const client: SlackUsersClient = { users: { info } };
  return { client, info };
}

describe("ジョブ間のユーザー情報キャッシュ", () => {
  it("同じ client の別 resolver でも結果を再利用し、1時間で取り直す", async () => {
    const { client, info } = fakeUsers("田中");
    let time = 0;
    const now = () => new Date(time);
    await createUserResolver(client, now).getUser("U1");

    time = USER_CACHE_TTL_MS - 1;
    expect(await createUserResolver(client, now).getUser("U1")).toEqual({
      id: "U1",
      name: "田中",
      deleted: false,
    });
    expect(info).toHaveBeenCalledTimes(1);

    time = USER_CACHE_TTL_MS;
    await createUserResolver(client, now).getUser("U1");
    expect(info).toHaveBeenCalledTimes(2);
  });

  it("異なる client の同じユーザーIDを共有しない", async () => {
    const first = fakeUsers("チーム1の田中");
    const second = fakeUsers("チーム2の佐藤");
    const now = () => new Date(0);

    expect((await createUserResolver(first.client, now).getUser("U1")).name).toBe("チーム1の田中");
    expect((await createUserResolver(second.client, now).getUser("U1")).name).toBe("チーム2の佐藤");
    expect(first.info).toHaveBeenCalledTimes(1);
    expect(second.info).toHaveBeenCalledTimes(1);
  });

  it("同じ client でも短いTTLを指定した resolver は期限を守る", async () => {
    const { client, info } = fakeUsers("田中");
    let time = 0;
    const now = () => new Date(time);
    await createUserResolver(client, now).getUser("U1");

    time = 10;
    await createUserResolver(client, now, 10).getUser("U1");
    expect(info).toHaveBeenCalledTimes(2);
  });
});
