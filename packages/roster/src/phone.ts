import type { Roster } from "./schema.js";

/** One agent the phone may reach, as the picker needs it. */
export interface PhoneAgent {
  name: string;
  spokenName: string;
  aliases: string[];
  resumeWindowSeconds: number;
}

/**
 * The agents a caller may be connected to: those whose roster entry opts
 * in. Naming an agent without enabling it is not enough — a spoken name
 * on its own only reserves the word.
 */
export function phoneEnabledAgents(roster: Roster): PhoneAgent[] {
  const agents: PhoneAgent[] = [];
  for (const [name, entry] of Object.entries(roster.agents)) {
    if (!entry.phone.enabled || entry.phone.spokenName === undefined) {
      continue;
    }
    agents.push({
      name,
      spokenName: entry.phone.spokenName,
      aliases: [...entry.phone.aliases],
      resumeWindowSeconds: entry.phone.resumeWindowSeconds,
    });
  }
  return agents;
}
