import test from "node:test";
import assert from "node:assert/strict";

import { TaskState } from "@a2a-js/sdk";
import type { Message, Task } from "@a2a-js/sdk";

import type { CardBody, ChannelInfo, DiscordApi, FetchedMessage, HistoryMessage, PlainMessage } from "./api.js";
import { CHANNEL_TYPE, CALLBACK } from "./api.js";
import { STOP_ID } from "./card.js";
import { BridgeEngine, deriveContextId, META_DISCORD_CHANNEL, META_DISCORD_THREAD } from "./engine.js";
import { BridgeState } from "./state.js";
import type { A2AEvent, AgentClient, MessageEvent } from "./types.js";

const BOT = "bot-1";
const OPERATOR = "op-1";
const STRANGER = "stranger-1";
const GUILD = "guild-1";
const CHANNEL = "chan-1";
const DM = "dm-1";

type DiscordCall =
  | { type: "postCard"; channel: string; body: CardBody; id: string }
  | { type: "editCard"; channel: string; id: string; body: CardBody }
  | { type: "post"; channel: string; message: PlainMessage; id: string }
  | { type: "createThread"; channel: string; messageId: string; name: string; id: string }
  | { type: "typing"; channel: string }
  | { type: "respond"; interactionId: string; callback: number }
  | { type: "ephemeral"; interactionId: string; text: string };

class MockDiscord implements DiscordApi {
  calls: DiscordCall[] = [];
  channels = new Map<string, ChannelInfo>();
  refuseEdits = false;
  refuseCards = false;
  refuseThreads = false;
  private counter = 0;

  constructor() {
    this.channels.set(CHANNEL, { id: CHANNEL, type: CHANNEL_TYPE.GUILD_TEXT, guildId: GUILD });
    this.channels.set(DM, { id: DM, type: CHANNEL_TYPE.DM });
  }
  private next(prefix: string): string {
    return `${prefix}-${++this.counter}`;
  }
  async channelInfo(channelId: string): Promise<ChannelInfo> {
    const info = this.channels.get(channelId);
    if (info === undefined) {
      throw new Error(`unknown channel ${channelId}`);
    }
    return info;
  }
  async createThread(channel: string, messageId: string, name: string): Promise<string> {
    if (this.refuseThreads) {
      throw new Error("Missing Permissions");
    }
    const id = `thread-${messageId}`;
    this.channels.set(id, { id, type: CHANNEL_TYPE.PUBLIC_THREAD, guildId: GUILD, parentId: channel });
    this.calls.push({ type: "createThread", channel, messageId, name, id });
    return id;
  }
  async postCard(channel: string, body: CardBody): Promise<string> {
    if (this.refuseCards) {
      throw new Error("refused");
    }
    const id = this.next("card");
    this.calls.push({ type: "postCard", channel, body, id });
    return id;
  }
  async editCard(channel: string, id: string, body: CardBody): Promise<void> {
    if (this.refuseEdits) {
      throw new Error("refused");
    }
    this.calls.push({ type: "editCard", channel, id, body });
  }
  async postMessage(channel: string, message: PlainMessage): Promise<string> {
    const id = this.next("msg");
    this.calls.push({ type: "post", channel, message, id });
    return id;
  }
  async typing(channel: string): Promise<void> {
    this.calls.push({ type: "typing", channel });
  }
  async respond(interactionId: string, _token: string, callback: number): Promise<void> {
    this.calls.push({ type: "respond", interactionId, callback });
  }
  async respondEphemeral(interactionId: string, _token: string, text: string): Promise<void> {
    this.calls.push({ type: "ephemeral", interactionId, text });
  }
  async fetchMessage(channelId: string, messageId: string): Promise<FetchedMessage> {
    return { id: messageId, channelId, attachments: [] };
  }
  history: HistoryMessage[] = [];
  async readMessages(): Promise<HistoryMessage[]> {
    return this.history;
  }

  /** The text of the card as last drawn, by card id. */
  cardText(id: string): string {
    const draws = this.calls.filter((c) => (c.type === "postCard" && c.id === id) || (c.type === "editCard" && c.id === id));
    const last = draws.at(-1);
    if (last === undefined || (last.type !== "postCard" && last.type !== "editCard")) {
      return "";
    }
    return displays(last.body).at(-1) ?? "";
  }
  cards(): string[] {
    return this.calls.filter((c) => c.type === "postCard").map((c) => (c as { id: string }).id);
  }
  posts(): PlainMessage[] {
    return this.calls.filter((c) => c.type === "post").map((c) => (c as { message: PlainMessage }).message);
  }
}

function displays(body: CardBody): string[] {
  const out: string[] = [];
  const visit = (c: unknown) => {
    const component = c as Record<string, unknown>;
    if (component.type === 10) {
      out.push(String(component.content));
    }
    if (Array.isArray(component.components)) {
      component.components.forEach(visit);
    }
  };
  body.components.forEach(visit);
  return out;
}

function hasStop(body: CardBody): boolean {
  let found = false;
  const visit = (c: unknown) => {
    const component = c as Record<string, unknown>;
    if (component.type === 2 && component.custom_id === STOP_ID) {
      found = true;
    }
    if (Array.isArray(component.components)) {
      component.components.forEach(visit);
    }
    if (component.accessory !== undefined) {
      visit(component.accessory);
    }
  };
  body.components.forEach(visit);
  return found;
}

/** A scripted agent: each stream yields the events the script says, after a tick each. */
class FakeAgent implements AgentClient {
  sent: Message[] = [];
  cancelled: string[] = [];
  reachable = true;
  script: (message: Message, taskId: string) => A2AEvent[] = () => [];
  private counter = 0;

  async fetchCard() {
    if (!this.reachable) {
      throw new Error("unreachable");
    }
    return { streaming: true };
  }
  async *stream(message: Message): AsyncIterable<A2AEvent> {
    this.sent.push(message);
    const taskId = `task-${++this.counter}`;
    const task: Task = {
      id: taskId,
      contextId: message.contextId,
      status: { state: TaskState.TASK_STATE_WORKING, timestamp: "", message: undefined },
      artifacts: [],
      history: [],
      metadata: {},
    };
    yield { kind: "task", task };
    for (const event of this.script(message, taskId)) {
      await new Promise((resolve) => setTimeout(resolve, 1));
      yield event;
    }
  }
  async send(message: Message): Promise<Task> {
    this.sent.push(message);
    throw new Error("not used");
  }
  async cancel(taskId: string): Promise<void> {
    this.cancelled.push(taskId);
  }
  async *resubscribe(): AsyncIterable<A2AEvent> {}
}

function text(taskId: string, value: string, lastChunk = false): A2AEvent {
  return { kind: "artifact", taskId, text: value, append: true, lastChunk };
}
function done(taskId: string, metadata?: Record<string, unknown>): A2AEvent {
  return { kind: "status", taskId, contextId: "", state: TaskState.TASK_STATE_COMPLETED, metadata };
}
function failed(taskId: string, messageText?: string): A2AEvent {
  return { kind: "status", taskId, contextId: "", state: TaskState.TASK_STATE_FAILED, messageText };
}
function activity(taskId: string, id: string, title: string, status: "running" | "done"): A2AEvent {
  return { kind: "activity", taskId, activities: [{ id, title, status }] };
}

function message(overrides: Partial<MessageEvent> & { channel: string }): MessageEvent {
  return {
    kind: "message",
    messageId: `m-${Math.random().toString(36).slice(2, 8)}`,
    text: "hello",
    authorId: OPERATOR,
    authorIsApp: false,
    mentions: [],
    botMentions: [],
    mentionNames: {},
    files: [],
    type: 0,
    forwards: [],
    guild: overrides.channel === DM ? undefined : GUILD,
    ...overrides,
  };
}

function setup(options: { bindings?: Record<string, string>; textLimit?: number; context?: "native" | "replay"; forwardHoldMs?: number } = {}) {
  const discord = new MockDiscord();
  const agent = new FakeAgent();
  const state = new BridgeState(":memory:");
  const engine = new BridgeEngine({
    agent: "example",
    guildId: GUILD,
    operators: [OPERATOR],
    selfId: () => BOT,
    queueing: "harness",
    client: agent,
    discord,
    state,
    editIntervalMs: 1,
    forwardHoldMs: options.forwardHoldMs ?? 20,
    ...(options.bindings === undefined ? {} : { bindings: options.bindings }),
    ...(options.textLimit === undefined ? {} : { textLimit: options.textLimit }),
    ...(options.context === undefined ? {} : { context: options.context }),
  });
  return { discord, agent, state, engine };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

test("a DM is a turn: the card is posted as a reply, streamed, and finished", async () => {
  const { discord, agent, engine } = setup();
  agent.script = (_m, taskId) => [text(taskId, "Hello "), text(taskId, "there."), done(taskId)];

  await engine.handleEvent(message({ channel: DM, messageId: "dm-msg" }));
  await settle();

  const [sent] = agent.sent;
  assert.equal(sent?.contextId, deriveContextId(DM));
  assert.equal(sent?.metadata?.[META_DISCORD_CHANNEL], DM);
  assert.equal(sent?.metadata?.[META_DISCORD_THREAD], DM);
  assert.equal(sent?.messageId, `discord-${DM}-dm-msg`);
  const card = discord.calls.find((c) => c.type === "postCard");
  assert.ok(card && card.type === "postCard");
  assert.equal(card.body.message_reference, undefined, "the card does not quote the message above it");
  assert.equal(discord.cardText(card.id), "Hello there.");
  const last = discord.calls.filter((c) => c.type === "editCard").at(-1);
  assert.ok(last && last.type === "editCard" && !hasStop(last.body), "the final edit removes Stop");
  assert.deepEqual(displays(last.body), ["Hello there."], "a finished answer is just the text");
  assert.equal((last.body.components[0] as { type: number }).type, 10, "no container around a finished answer");
  assert.ok(discord.calls.some((c) => c.type === "typing"));
});

test("a stranger, a bot, a wrong server, and a redelivery are not turns", async () => {
  const { discord, agent, engine } = setup();
  await engine.handleEvent(message({ channel: DM, authorId: STRANGER }));
  await engine.handleEvent(message({ channel: DM, authorIsApp: true }));
  await engine.handleEvent(message({ channel: CHANNEL, guild: "another", mentions: [BOT] }));
  await engine.handleEvent(message({ channel: DM, type: 21 }));
  const twice = message({ channel: DM, messageId: "same" });
  agent.script = (_m, taskId) => [done(taskId)];
  await engine.handleEvent(twice);
  await engine.handleEvent(twice);
  await settle();
  assert.equal(agent.sent.length, 1);
  assert.equal(discord.calls.filter((c) => c.type === "createThread").length, 0);
});

test("a mention in a channel opens a thread; the thread is the context and the agent an answerer", async () => {
  const { discord, agent, state, engine } = setup();
  agent.script = (_m, taskId) => [text(taskId, "ok"), done(taskId)];

  await engine.handleEvent(message({ channel: CHANNEL, messageId: "root", text: `<@${BOT}> deploy please`, mentions: [BOT], botMentions: [BOT] }));
  await settle();

  const thread = discord.calls.find((c) => c.type === "createThread");
  assert.ok(thread && thread.type === "createThread");
  assert.equal(thread.name, "deploy please");
  assert.equal(agent.sent[0]?.contextId, deriveContextId(thread.id));
  assert.equal(agent.sent[0]?.metadata?.[META_DISCORD_CHANNEL], CHANNEL);
  assert.equal(agent.sent[0]?.metadata?.[META_DISCORD_THREAD], thread.id);
  const card = discord.calls.find((c) => c.type === "postCard");
  assert.ok(card && card.type === "postCard" && card.channel === thread.id);
  const sentText = agent.sent[0]?.parts[0]?.content;
  assert.ok(sentText?.$case === "text" && sentText.value === "@example deploy please", "the agent reads its own mention as its name");
  assert.deepEqual(state.contextFor("example", thread.id)?.answerer, true);

  // An unmentioned follow-up in that thread is a turn for an answerer.
  await engine.handleEvent(message({ channel: thread.id, text: "and the other one" }));
  await settle();
  assert.equal(agent.sent.length, 2);
  assert.equal(agent.sent[1]?.metadata?.["thicket.shouldQuery"], undefined);

  // With another agent mentioned, it is context only.
  await engine.handleEvent(message({ channel: thread.id, text: "<@other> you too", mentions: ["other"], botMentions: ["other"] }));
  await settle();
  assert.equal(agent.sent.length, 3);
  assert.equal(agent.sent[2]?.metadata?.["thicket.shouldQuery"], false);
});

test("an unmentioned message in a channel is ignored, and a mention into a thread engages without answering follow-ups", async () => {
  const { discord, agent, state, engine } = setup();
  agent.script = (_m, taskId) => [done(taskId)];
  const thread = "thread-x";
  discord.channels.set(thread, { id: thread, type: CHANNEL_TYPE.PUBLIC_THREAD, guildId: GUILD, parentId: CHANNEL });

  await engine.handleEvent(message({ channel: CHANNEL, text: "just chatting" }));
  await engine.handleEvent(message({ channel: thread, text: "nobody asked" }));
  await settle();
  assert.equal(agent.sent.length, 0);

  await engine.handleEvent(message({ channel: thread, text: `<@${BOT}> join us`, mentions: [BOT], botMentions: [BOT] }));
  await settle();
  assert.equal(agent.sent.length, 1);
  assert.equal(state.contextFor("example", thread)?.answerer, false);

  await engine.handleEvent(message({ channel: thread, text: "follow-up for whoever" }));
  await settle();
  assert.equal(agent.sent.length, 2);
  assert.equal(agent.sent[1]?.metadata?.["thicket.shouldQuery"], false, "engaged but not an answerer: context only");
});

test("a bound forum post is a session from its first message", async () => {
  const forum = "forum-1";
  const { discord, agent, state, engine } = setup({ bindings: { [forum]: "example" } });
  discord.channels.set(forum, { id: forum, type: CHANNEL_TYPE.GUILD_FORUM, guildId: GUILD });
  const post = "post-1";
  discord.channels.set(post, { id: post, type: CHANNEL_TYPE.PUBLIC_THREAD, guildId: GUILD, parentId: forum });
  agent.script = (_m, taskId) => [done(taskId)];

  await engine.handleEvent(message({ channel: post, text: "the post body" }));
  await settle();

  assert.equal(agent.sent.length, 1);
  assert.equal(agent.sent[0]?.metadata?.["thicket.workspace"], "example");
  assert.equal(state.contextFor("example", post)?.answerer, true);
});

test("activity steps draw on the card and set the status line", async () => {
  const { discord, agent, engine } = setup();
  agent.script = (_m, taskId) => [
    activity(taskId, "s1", "Read agents.yaml", "running"),
    activity(taskId, "s1", "Read agents.yaml", "done"),
    text(taskId, "Done reading."),
    done(taskId),
  ];
  await engine.handleEvent(message({ channel: DM }));
  await settle();
  const draws = discord.calls.filter((c) => c.type === "editCard" || c.type === "postCard");
  const statuses = draws.map((c) => displays((c as { body: CardBody }).body)[0]);
  assert.ok(statuses.includes("**Read agents.yaml…**"), `drawn statuses: ${statuses.join(" | ")}`);
  const edits = discord.calls.filter((c) => c.type === "editCard");
  const final = displays((edits.at(-1) as { body: CardBody }).body);
  assert.deepEqual(final, ["Done reading.", "-# ✅ Read agents.yaml"], "answer first, steps as subtext");
});

test("text past the budget rolls over to a new card, the old one frozen", async () => {
  const { discord, agent, engine } = setup({ textLimit: 40 });
  agent.script = (_m, taskId) => [
    text(taskId, "one two three four five six seven eight nine ten eleven twelve thirteen"),
    done(taskId),
  ];
  await engine.handleEvent(message({ channel: DM }));
  await settle();
  const cards = discord.cards();
  assert.equal(cards.length, 2);
  const frozen = discord.calls.filter((c) => c.type === "editCard" && c.id === cards[0]).at(-1) as { body: CardBody };
  assert.ok(displays(frozen.body)[0]?.includes("continued below"));
  assert.ok(!hasStop(frozen.body));
  const second = discord.calls.find((c) => c.type === "postCard" && c.id === cards[1]) as { body: CardBody };
  assert.equal(second.body.flags & (1 << 12), 1 << 12, "the rollover page is silent");
  assert.equal((discord.cardText(cards[0]!) + " " + discord.cardText(cards[1]!)).replace(/\s+/g, " ").trim(), "one two three four five six seven eight nine ten eleven twelve thirteen");
});

test("a person speaking beneath an open card cuts it: the answer continues below them", async () => {
  const { discord, agent, engine } = setup();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  agent.script = (_m, taskId) => [text(taskId, "first part")];
  const original = agent.stream.bind(agent);
  agent.stream = async function* (m: Message) {
    for await (const event of original(m)) {
      yield event;
    }
    await gate;
    const taskId = "task-1";
    yield text(taskId, " second part");
    yield done(taskId);
  };
  const first = engine.handleEvent(message({ channel: DM }));
  await settle();
  assert.equal(discord.cards().length, 1);

  // The operator speaks; in a DM that is a turn of its own, and it marks
  // the open card stale before it reaches the agent.
  agent.stream = original;
  agent.script = (_m, taskId) => [done(taskId)];
  const second = engine.handleEvent(message({ channel: DM, text: "wait" }));
  await settle();
  release();
  await Promise.all([first, second]);
  await settle();

  const cards = discord.cards();
  assert.ok(cards.length >= 2, "the continuation opened a new card below the person");
  assert.equal(discord.cardText(cards[0]!), "first part");
});

test("Stop cancels the card's task; a stale Stop is told the turn finished", async () => {
  const { discord, agent, engine } = setup();
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  agent.stream = async function* (m: Message) {
    agent.sent.push(m);
    yield {
      kind: "task",
      task: { id: "t1", contextId: m.contextId, status: { state: TaskState.TASK_STATE_WORKING, timestamp: "", message: undefined }, artifacts: [], history: [], metadata: {} },
    } as A2AEvent;
    yield text("t1", "working on it");
    await gate;
    yield { kind: "status", taskId: "t1", contextId: "", state: TaskState.TASK_STATE_CANCELED } as A2AEvent;
  };
  const turn = engine.handleEvent(message({ channel: DM }));
  await settle();
  const card = discord.cards()[0]!;

  await engine.handleEvent({ kind: "component", interactionId: "i1", token: "t", channel: DM, messageId: card, userId: OPERATOR, customId: STOP_ID, componentType: 2, values: [] });
  assert.deepEqual(agent.cancelled, ["t1"]);
  assert.ok(discord.calls.some((c) => c.type === "respond" && c.callback === CALLBACK.DEFERRED_UPDATE));
  release();
  await turn;
  await settle();
  const last = discord.calls.filter((c) => c.type === "editCard").at(-1) as { body: CardBody };
  assert.equal(displays(last.body)[0], "**Stopped**");

  await engine.handleEvent({ kind: "component", interactionId: "i2", token: "t", channel: DM, messageId: card, userId: OPERATOR, customId: STOP_ID, componentType: 2, values: [] });
  assert.ok(discord.calls.some((c) => c.type === "ephemeral" && c.interactionId === "i2" && /finished/.test(c.text)));

  await engine.handleEvent({ kind: "component", interactionId: "i3", token: "t", channel: DM, messageId: card, userId: STRANGER, customId: STOP_ID, componentType: 2, values: [] });
  assert.ok(discord.calls.some((c) => c.type === "ephemeral" && c.interactionId === "i3" && /operator/.test(c.text)));
});

test("an unreachable agent queues the message and says so; the queue flushes when it is back", async () => {
  const { discord, agent, state, engine } = setup();
  agent.reachable = false;
  await engine.handleEvent(message({ channel: DM, messageId: "q1", text: "later" }));
  assert.equal(state.queuedFor("example").length, 1);
  assert.ok(discord.posts().some((p) => /queued/.test(p.text) && p.ping === true));

  agent.reachable = true;
  agent.script = (_m, taskId) => [done(taskId)];
  assert.equal(await engine.flushQueue(), 1);
  await settle();
  assert.equal(agent.sent[0]?.messageId, `discord-${DM}-q1`);
  assert.equal(state.queuedFor("example").length, 0);
});

test("a failed turn pings the operator with the reason; a refused card falls back to plain text", async () => {
  const { discord, agent, engine } = setup();
  agent.script = (_m, taskId) => [text(taskId, "partial"), failed(taskId, "the tool exploded")];
  await engine.handleEvent(message({ channel: DM }));
  await settle();
  assert.ok(discord.posts().some((p) => p.text === "the tool exploded" && p.ping === true));

  const second = setup();
  second.discord.refuseCards = true;
  second.agent.script = (_m, taskId) => [text(taskId, "plain answer"), done(taskId)];
  await second.engine.handleEvent(message({ channel: DM }));
  await settle();
  assert.ok(second.discord.posts().some((p) => p.text === "plain answer"));
});

test("a refused thread refuses the turn out loud", async () => {
  const { discord, agent, engine } = setup();
  discord.refuseThreads = true;
  await engine.handleEvent(message({ channel: CHANNEL, mentions: [BOT], botMentions: [BOT] }));
  await settle();
  assert.equal(agent.sent.length, 0);
  assert.ok(discord.posts().some((p) => /can't open a thread/.test(p.text)));
});

test("a replay agent gets the channel's history ahead of the message", async () => {
  const { discord, agent, engine } = setup({ context: "replay" });
  discord.history = [
    { id: "h1", authorId: OPERATOR, authorIsApp: false, text: "earlier" },
    { id: "h2", authorId: BOT, authorIsApp: true, text: "reply" },
  ];
  agent.script = (_m, taskId) => [done(taskId)];
  await engine.handleEvent(message({ channel: DM, text: "now" }));
  await settle();
  const sent = agent.sent[0]?.parts[0]?.content;
  assert.ok(sent?.$case === "text" && /\[op-1\] earlier\n\[agent\] reply/.test(sent.value) && /Current message:\nnow/.test(sent.value));
});

test("a restart reattaches to the recorded card and keeps editing it", async () => {
  const discord = new MockDiscord();
  const state = new BridgeState(":memory:");
  state.recordTask({
    taskId: "t-old",
    agent: "example",
    channel: DM,
    triggerId: "trig",
    authorId: OPERATOR,
    card: { messageId: "card-old", status: "Working", steps: [], text: "before the restart" },
  });
  const agent = new FakeAgent();
  agent.resubscribe = async function* () {
    yield text("t-old", " and after");
    yield done("t-old");
  };
  const engine = new BridgeEngine({
    agent: "example",
    guildId: GUILD,
    operators: [OPERATOR],
    selfId: () => BOT,
    queueing: "harness",
    client: agent,
    discord,
    state,
    editIntervalMs: 1,
  });
  await engine.start();
  await settle();
  assert.equal(discord.cards().length, 0, "no new card");
  assert.equal(discord.cardText("card-old"), "before the restart and after");
  assert.equal(state.taskById("t-old"), undefined);
});

test("the envelope carries author, reply and forward; an empty forward becomes the message body", async () => {
  const { agent, engine } = setup();
  agent.script = (_m, taskId) => [done(taskId)];
  await engine.handleEvent(
    message({
      channel: DM,
      text: "",
      authorName: "ivy",
      forwards: [{ text: "forwarded words", files: [] }],
    }),
  );
  await engine.handleEvent(
    message({
      channel: DM,
      text: `<@${BOT}> yes`,
      mentions: [BOT],
      botMentions: [BOT],
      mentionNames: { [BOT]: "thicket-dev" },
      replyTo: "orig",
      reply: { author: { id: BOT, name: "thicket-dev", isApp: true }, text: "earlier", files: [] },
      files: [],
    }),
  );
  await settle();
  const [forward, reply] = agent.sent;
  const body = (m: Message | undefined) => (m?.parts[0]?.content?.$case === "text" ? m.parts[0].content.value : "");
  assert.equal(body(forward), "(forwarded) forwarded words");
  const env1 = forward?.metadata?.["thicket.envelope"] as { author: { name: string; kind: string }; references: { kind: string }[] };
  assert.equal(env1.author.name, "ivy");
  assert.equal(env1.author.kind, "operator");
  assert.deepEqual(env1.references.map((r) => r.kind), ["forward"]);
  assert.equal(body(reply), "@example yes");
  const env2 = reply?.metadata?.["thicket.envelope"] as { mentions: { self?: boolean }[]; references: { kind: string; author?: { self?: boolean }; text?: string }[] };
  assert.equal(env2.mentions[0]?.self, true);
  assert.deepEqual(env2.references[0], { kind: "reply", message: "orig", author: { id: BOT, name: "thicket-dev", kind: "agent", self: true }, text: "earlier" });
});

test("a forward and the comment typed with it become one turn; a lone forward waits, then goes", async () => {
  const { agent, engine } = setup({ forwardHoldMs: 40 });
  agent.script = (_m, taskId) => [done(taskId)];
  const body = (m: Message | undefined) => (m?.parts[0]?.content?.$case === "text" ? m.parts[0].content.value : "");

  const held = engine.handleEvent(message({ channel: DM, text: "", forwards: [{ text: `<@${BOT}> old words`, files: [] }] }));
  await engine.handleEvent(message({ channel: DM, text: "can you read this?" }));
  await held;
  await settle();
  assert.equal(agent.sent.length, 1, "one turn, not two");
  assert.equal(body(agent.sent[0]), "can you read this?");
  const env = agent.sent[0]?.metadata?.["thicket.envelope"] as { references: { kind: string; text?: string }[] };
  assert.deepEqual(env.references, [{ kind: "forward", text: `<@${BOT}> old words` }]);

  await engine.handleEvent(message({ channel: DM, text: "", forwards: [{ text: `<@${BOT}> alone`, files: [] }] }));
  await settle();
  assert.equal(agent.sent.length, 2, "a forward with no comment is its own turn after the hold");
  assert.equal(body(agent.sent[1]), "(forwarded) @example alone", "forwarded mentions of the agent read as its name too");
});
