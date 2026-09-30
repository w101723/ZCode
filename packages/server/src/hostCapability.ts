import { randomBytes } from "node:crypto";
import type { ServerRemoteHostCapability } from "@zcode/shared";

export const DEFAULT_HOST_CAPABILITY_TTL_MS = 30_000;

export interface HostCapabilityStoreOptions {
  ttlMs?: number;
  now?: () => number;
  createCapability?: () => string;
}

export interface HostCapabilityStore {
  issue(): ServerRemoteHostCapability;
  consume(capability: string | undefined): boolean;
}

export const DEFAULT_WEB_TICKET_TTL_MS = 30_000;

export interface ServerRemoteWebTicket {
  ticket: string;
  expiresAt: number;
}

export interface WebTicketStoreOptions {
  ttlMs?: number;
  now?: () => number;
  createTicket?: () => string;
}

export interface WebTicketStore {
  issue(origin: string): ServerRemoteWebTicket;
  consume(ticket: string | undefined, origin: string | undefined): boolean;
  revoke(ticket: string | undefined): boolean;
}

interface StoredWebTicket {
  origin: string;
  expiresAt: number;
}

/** 短期、一次性、与 Origin 绑定的 Web 远程票据；只在 HTTP server 进程内存中存在。 */
export function createWebTicketStore(options: WebTicketStoreOptions = {}): WebTicketStore {
  const ttlMs = options.ttlMs ?? DEFAULT_WEB_TICKET_TTL_MS;
  const now = options.now ?? Date.now;
  const createTicket = options.createTicket ?? (() => randomBytes(32).toString("base64url"));
  const tickets = new Map<string, StoredWebTicket>();

  const purgeExpired = (at: number): void => {
    for (const [ticket, entry] of tickets) {
      if (entry.expiresAt <= at) tickets.delete(ticket);
    }
  };

  return {
    issue(origin: string) {
      const issuedAt = now();
      purgeExpired(issuedAt);
      const ticket = createTicket();
      const expiresAt = issuedAt + ttlMs;
      tickets.set(ticket, { origin, expiresAt });
      return { ticket, expiresAt };
    },
    consume(ticket, origin) {
      if (!ticket) return false;
      const consumedAt = now();
      const entry = tickets.get(ticket);
      // 无论是否匹配、过期或重复消费，先从 Map 中移除，确保一次性消费且不可重放
      tickets.delete(ticket);
      purgeExpired(consumedAt);
      if (!entry) return false;
      if (entry.expiresAt <= consumedAt) return false;
      if (origin !== undefined && entry.origin !== origin) return false;
      return true;
    },
    revoke(ticket) {
      if (!ticket) return false;
      return tickets.delete(ticket);
    },
  };
}

/** 短期、一次性 desktop host capability；只在 HTTP server 进程内存中存在。 */
export function createHostCapabilityStore(
  options: HostCapabilityStoreOptions = {},
): HostCapabilityStore {
  const ttlMs = options.ttlMs ?? DEFAULT_HOST_CAPABILITY_TTL_MS;
  const now = options.now ?? Date.now;
  const createCapability =
    options.createCapability ?? (() => randomBytes(32).toString("base64url"));
  const expiresByCapability = new Map<string, number>();

  const purgeExpired = (at: number): void => {
    for (const [capability, expiresAt] of expiresByCapability) {
      if (expiresAt <= at) expiresByCapability.delete(capability);
    }
  };

  return {
    issue() {
      const issuedAt = now();
      purgeExpired(issuedAt);
      const capability = createCapability();
      const expiresAt = issuedAt + ttlMs;
      expiresByCapability.set(capability, expiresAt);
      return { capability, expiresAt };
    },
    consume(capability) {
      if (!capability) return false;
      const consumedAt = now();
      const expiresAt = expiresByCapability.get(capability);
      // 旧 mode header 是可重放的长期提权声明。ticket 无论成功、过期
      // 还是重放都先删除，只有首次且 TTL 内的消费能获得 trusted-host role。
      expiresByCapability.delete(capability);
      purgeExpired(consumedAt);
      return expiresAt !== undefined && expiresAt > consumedAt;
    },
  };
}
