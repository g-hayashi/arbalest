import { describe, expect, it, vi } from "vitest";
import {
  dispatchTeamsMessage,
  isTrustedTeamsServiceUrl,
  validateTeamsPayload,
} from "../../src/teams/ingress.js";

const tenant = "11111111-1111-4111-8111-111111111111";
const app = "22222222-2222-4222-8222-222222222222";
const team = "33333333-3333-4333-8333-333333333333";
const channel = "19:channel@thread.tacv2";
function activity() {
  return {
    type: "message",
    id: "1700000000001",
    channelId: "msteams",
    serviceUrl: "https://smba.trafficmanager.net/jp/",
    text: "<at>Arbalest</at> 要約",
    from: { id: "29:person", aadObjectId: "44444444-4444-4444-8444-444444444444" },
    recipient: { id: `28:${app}` },
    conversation: { id: `${channel};messageid=1700000000000`, conversationType: "channel" },
    replyToId: "1700000000000",
    channelData: {
      tenant: { id: tenant },
      team: { id: "19:team@thread.tacv2", aadGroupId: team },
      channel: { id: channel },
    },
    entities: [{ type: "mention", text: "<at>Arbalest</at>", mentioned: { id: `28:${app}` } }],
  };
}
function deps() {
  return {
    appId: app,
    tenantId: tenant,
    allowedTeamIds: new Set([team]),
    now: () => new Date("2026-10-26T00:00:00Z"),
    enqueue: vi.fn().mockResolvedValue({ created: true }),
  };
}

describe("Teams の認証後メンション受付", () => {
  it("aadGroupIdでGraphのチームを決め、同じスレッドへのジョブを積む", async () => {
    const d = deps();
    await dispatchTeamsMessage(activity(), d);
    expect(d.enqueue).toHaveBeenCalledOnce();
    const request = d.enqueue.mock.calls[0]?.[0];
    expect(request.path).toBe("/jobs/teams-request");
    expect(request.name).toMatch(/^teams-[a-f0-9]{64}$/);
    expect(request.payload).toMatchObject({
      platform: "teams",
      tenantId: tenant,
      teamId: team,
      channelId: channel,
      rootMessageId: "1700000000000",
      mentionId: "1700000000001",
      requestText: "要約",
    });
    expect(validateTeamsPayload(request.payload, d)).toBe(true);
  });

  it("親のメンションなら自分のIDをスレッドの親にする", async () => {
    const a = activity();
    a.conversation.id = channel;
    delete (a as Partial<typeof a>).replyToId;
    const d = deps();
    await dispatchTeamsMessage(a, d);
    expect(d.enqueue.mock.calls[0]?.[0].payload.rootMessageId).toBe(a.id);
  });

  it("既存のthread.skypeチャネルIDも受け付ける", async () => {
    const a = activity();
    a.channelData.channel.id = "19:channel@thread.skype";
    a.conversation.id = `${a.channelData.channel.id};messageid=1700000000000`;
    const d = deps();
    await dispatchTeamsMessage(a, d);
    expect(d.enqueue).toHaveBeenCalledOnce();
  });

  it("再送のタスク名は同一、別チームの同IDは別名", async () => {
    const d = deps();
    const a = activity();
    await dispatchTeamsMessage(a, d);
    await dispatchTeamsMessage(a, d);
    expect(d.enqueue.mock.calls[0]?.[0].name).toBe(d.enqueue.mock.calls[1]?.[0].name);
    const other = "55555555-5555-4555-8555-555555555555";
    d.allowedTeamIds.add(other);
    a.channelData.team.aadGroupId = other;
    await dispatchTeamsMessage(a, d);
    expect(d.enqueue.mock.calls[0]?.[0].name).not.toBe(d.enqueue.mock.calls[2]?.[0].name);
  });

  it("別スレッドで同じIDのメンションでも異なるタスクへ積む", async () => {
    const d = deps();
    const a = activity();
    await dispatchTeamsMessage(a, d);
    a.replyToId = "1700000000999";
    a.conversation.id = `${channel};messageid=${a.replyToId}`;
    await dispatchTeamsMessage(a, d);
    expect(d.enqueue.mock.calls[0]?.[0].name).not.toBe(d.enqueue.mock.calls[1]?.[0].name);
  });

  it.each([
    (a: ReturnType<typeof activity>) => {
      a.channelData.tenant.id = app;
    },
    (a: ReturnType<typeof activity>) => {
      a.channelData.team.aadGroupId = app;
    },
    (a: ReturnType<typeof activity>) => {
      a.channelId = "emulator";
    },
    (a: ReturnType<typeof activity>) => {
      a.conversation.conversationType = "personal";
    },
    (a: ReturnType<typeof activity>) => {
      a.conversation.id = "19:other@thread.tacv2";
    },
    (a: ReturnType<typeof activity>) => {
      a.from.id = a.recipient.id;
    },
    (a: ReturnType<typeof activity>) => {
      a.entities = [];
    },
    (a: ReturnType<typeof activity>) => {
      const first = a.entities[0];
      if (first) first.mentioned.id = "28:another-bot";
    },
    (a: ReturnType<typeof activity>) => {
      a.serviceUrl = "https://attacker.example/";
    },
    (a: ReturnType<typeof activity>) => {
      a.conversation.id += "?unsafe";
    },
    (a: ReturnType<typeof activity>) => {
      a.text = "x".repeat(16001);
    },
  ])("許可されない受信は処理しない %#", async (change) => {
    const d = deps();
    const a = activity();
    change(a);
    await dispatchTeamsMessage(a, d);
    expect(d.enqueue).not.toHaveBeenCalled();
  });

  it("投入に失敗した場合は例外を返し、成功扱いにしない", async () => {
    const d = deps();
    d.enqueue.mockRejectedValue(new Error("queue unavailable"));
    await expect(dispatchTeamsMessage(activity(), d)).rejects.toThrow("queue unavailable");
  });

  it("不正payloadと未知フィールドはworkerで拒否できる", async () => {
    const d = deps();
    await dispatchTeamsMessage(activity(), d);
    const p = d.enqueue.mock.calls[0]?.[0].payload;
    expect(validateTeamsPayload({ ...p, rootMessageId: "../escape" }, d)).toBe(false);
    expect(validateTeamsPayload({ ...p, requestText: 123 }, d)).toBe(false);
    expect(validateTeamsPayload({ ...p, tenantId: app }, d)).toBe(false);
    expect(validateTeamsPayload({ ...p, platform: "slack" }, d)).toBe(false);
  });
});

describe("Teams serviceUrl の範囲", () => {
  it.each([
    "http://smba.trafficmanager.net/jp/",
    "https://smba.trafficmanager.net.evil.test/jp/",
    "https://user@smba.trafficmanager.net/jp/",
    "https://smba.trafficmanager.net:444/jp/",
    "https://smba.trafficmanager.net/jp/?token=x",
    "https://localhost/",
  ])("不正な宛先を拒否する: %s", (url) => {
    expect(isTrustedTeamsServiceUrl(url)).toBe(false);
  });
  it("商用クラウドのTeamsサービスだけを許可する", () => {
    expect(isTrustedTeamsServiceUrl("https://smba.trafficmanager.net/jp/")).toBe(true);
    expect(
      isTrustedTeamsServiceUrl("https://smba.infra.teams.microsoft.com/teams/jp/tenant/"),
    ).toBe(true);
  });
});
