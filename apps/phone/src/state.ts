/**
 * What outlives a call: which session the operator was in with each agent,
 * so the next call can offer it back. The vertical slice keeps it in
 * memory; the server issue gives it a database behind the same port.
 */
export interface PhoneSession {
  agent: string;
  /** The A2A contextId, and the Claude session id: derived from the agent and the call that opened it. */
  contextId: string;
  openedByCall: string;
  /** When the operator last spoke to it, ms since the epoch; the resume window counts from here. */
  lastActiveAt: number;
  /** A task still waiting on the operator's answer when the call ended. */
  openTaskId?: string;
}

export interface PhoneStatePort {
  sessionFor(agent: string): PhoneSession | undefined;
  saveSession(session: PhoneSession): void;
}

export class MemoryPhoneState implements PhoneStatePort {
  private readonly sessions = new Map<string, PhoneSession>();

  sessionFor(agent: string): PhoneSession | undefined {
    return this.sessions.get(agent);
  }

  saveSession(session: PhoneSession): void {
    this.sessions.set(session.agent, { ...session });
  }
}
