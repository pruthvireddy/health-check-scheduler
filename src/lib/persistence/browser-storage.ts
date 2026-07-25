import {
  appointmentSchema,
  conversationRecordSchema,
  persistenceMetadataSchema,
  type Appointment,
  type ConversationRecord,
} from "@/lib/validation";

export const STORAGE_SCHEMA_VERSION = 1 as const;
export const STORAGE_KEYS = {
  currentConversation: `health-check-scheduler:v${STORAGE_SCHEMA_VERSION}:current-conversation`,
  recentConversations: `health-check-scheduler:v${STORAGE_SCHEMA_VERSION}:recent-conversations`,
  appointments: `health-check-scheduler:v${STORAGE_SCHEMA_VERSION}:appointments`,
  metadata: "health-check-scheduler:metadata",
} as const;

export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

export type StorageMode = "localStorage" | "memory";

export interface BrowserPersistence {
  readonly mode: StorageMode;
  loadCurrentConversation(): ConversationRecord | undefined;
  saveConversation(conversation: ConversationRecord, options?: { setCurrent?: boolean }): ConversationRecord;
  loadRecentConversations(): ConversationRecord[];
  clearCurrentConversation(): void;
  clearSymptomContext(): void;
  clearConversations(): void;
  loadAppointments(): Appointment[];
  saveAppointment(appointment: Appointment): Appointment;
  getAppointment(id: string): Appointment | undefined;
  clearAppointments(): void;
  clearAll(): void;
}

class MemoryStorage implements StorageLike {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

function safeBrowserStorage(): StorageLike | undefined {
  try {
    if (typeof window === "undefined" || !window.localStorage) return undefined;
    const probe = "__hcs_storage_probe__";
    window.localStorage.setItem(probe, "1");
    window.localStorage.removeItem(probe);
    return window.localStorage;
  } catch {
    return undefined;
  }
}

function parseStored<T>(
  storage: StorageLike,
  key: string,
  parser: { safeParse(value: unknown): { success: boolean; data?: T } },
): { value?: T; storageFailed: boolean } {
  let raw: string | null;
  try {
    raw = storage.getItem(key);
  } catch {
    return { storageFailed: true };
  }
  if (!raw) return { storageFailed: false };
  try {
    const parsed = parser.safeParse(JSON.parse(raw));
    if (parsed.success) return { value: parsed.data, storageFailed: false };
  } catch {
    // Treat malformed JSON as corrupt data, not as an unavailable storage backend.
  }
  try {
    storage.removeItem(key);
  } catch {
    // Storage may have become unavailable after initial capability detection.
  }
  return { storageFailed: false };
}

function writeStored(storage: StorageLike, key: string, value: unknown): boolean {
  try {
    storage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/**
 * Creates a validated, versioned browser store. It silently switches to per-instance memory
 * if localStorage is disabled or later throws, so a user can still finish the demo session.
 */
export function createBrowserPersistence(storage?: StorageLike): BrowserPersistence {
  const memory = new MemoryStorage();
  let activeStorage = storage ?? safeBrowserStorage() ?? memory;
  let mode: StorageMode = activeStorage === memory ? "memory" : "localStorage";

  const fallback = () => {
    if (activeStorage !== memory) {
      activeStorage = memory;
      mode = "memory";
    }
  };
  const read = <T>(key: string, parser: { safeParse(value: unknown): { success: boolean; data?: T } }): T | undefined => {
    const result = parseStored(activeStorage, key, parser);
    if (!result.storageFailed) return result.value;
    fallback();
    return parseStored(memory, key, parser).value;
  };
  const write = (key: string, value: unknown): void => {
    if (!writeStored(activeStorage, key, value)) {
      fallback();
      writeStored(activeStorage, key, value);
    }
  };
  const remove = (key: string): void => {
    try {
      activeStorage.removeItem(key);
    } catch {
      fallback();
      memory.removeItem(key);
    }
  };
  const writeMetadata = () => write(STORAGE_KEYS.metadata, { schemaVersion: STORAGE_SCHEMA_VERSION, updatedAt: new Date().toISOString() });
  const loadCurrentConversation = (): ConversationRecord | undefined => {
    const metadata = read(STORAGE_KEYS.metadata, persistenceMetadataSchema);
    if (metadata && metadata.schemaVersion !== STORAGE_SCHEMA_VERSION) {
      remove(STORAGE_KEYS.currentConversation);
      remove(STORAGE_KEYS.recentConversations);
      remove(STORAGE_KEYS.appointments);
      remove(STORAGE_KEYS.metadata);
      return undefined;
    }
    return read(STORAGE_KEYS.currentConversation, conversationRecordSchema);
  };
  const loadRecentConversations = (): ConversationRecord[] => read(STORAGE_KEYS.recentConversations, { safeParse: (value) => {
    const parsed = conversationRecordSchema.array().safeParse(value);
    return parsed.success ? { success: true, data: parsed.data } : { success: false };
  } }) ?? [];
  const loadAppointments = (): Appointment[] => read(STORAGE_KEYS.appointments, { safeParse: (value) => {
    const parsed = appointmentSchema.array().safeParse(value);
    return parsed.success ? { success: true, data: parsed.data } : { success: false };
  } }) ?? [];

  return {
    get mode() {
      return mode;
    },
    loadCurrentConversation,
    saveConversation(conversation, options = {}) {
      const validated = conversationRecordSchema.parse(conversation);
      const existing = loadRecentConversations();
      const recent = [validated, ...existing.filter((item) => item.id !== validated.id)].slice(0, 10);
      write(STORAGE_KEYS.recentConversations, recent);
      if (options.setCurrent !== false) write(STORAGE_KEYS.currentConversation, validated);
      writeMetadata();
      return validated;
    },
    loadRecentConversations,
    clearCurrentConversation() {
      remove(STORAGE_KEYS.currentConversation);
    },
    clearSymptomContext() {
      const stripContext = (conversation: ConversationRecord): ConversationRecord => ({
        ...conversation,
        evidence: conversation.evidence.filter((evidence) => evidence.source !== "context_file"),
        contextReviews: [],
        updatedAt: new Date().toISOString(),
      });
      const current = loadCurrentConversation();
      if (current) write(STORAGE_KEYS.currentConversation, stripContext(current));
      const recent = loadRecentConversations().map(stripContext);
      if (recent.length) write(STORAGE_KEYS.recentConversations, recent);
      writeMetadata();
    },
    clearConversations() {
      remove(STORAGE_KEYS.currentConversation);
      remove(STORAGE_KEYS.recentConversations);
    },
    loadAppointments,
    saveAppointment(appointment) {
      const validated = appointmentSchema.parse(appointment);
      const appointments = loadAppointments();
      write(STORAGE_KEYS.appointments, [validated, ...appointments.filter((item) => item.id !== validated.id)]);
      writeMetadata();
      return validated;
    },
    getAppointment(id) {
      return loadAppointments().find((appointment) => appointment.id === id);
    },
    clearAppointments() {
      remove(STORAGE_KEYS.appointments);
    },
    clearAll() {
      remove(STORAGE_KEYS.currentConversation);
      remove(STORAGE_KEYS.recentConversations);
      remove(STORAGE_KEYS.appointments);
      remove(STORAGE_KEYS.metadata);
    },
  };
}

/** Lazy default for UI code; server rendering automatically receives memory-only storage. */
export const browserPersistence = createBrowserPersistence();
