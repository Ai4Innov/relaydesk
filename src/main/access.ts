import type { Settings } from "../shared/contracts";
import { defaultSettings } from "../shared/defaults";

interface SettingsReader { get<T>(collection: "settings", id: string): T | undefined }

/**
 * Frictionless onboarding: when on (the default), newly connected accounts get data access and AI sharing,
 * and their discovered folders/channels/calendars are selected, so no per-account opt-in is needed.
 * This includes WhatsApp chats the user opens in WhatsApp Web; any account or chat can still be excluded in Settings.
 */
export function fullAccessByDefault(vault: SettingsReader): boolean {
  return ({ ...defaultSettings, ...vault.get<Partial<Settings>>("settings", "preferences") }).fullAccessByDefault;
}
