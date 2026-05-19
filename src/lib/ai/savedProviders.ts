/**
 * Saved OpenAI-compatible provider presets — CRUD + persistence.
 *
 * Storage model: a single localStorage JSON array under `savedOpenAIProviders_v1`,
 * plus a string under `activeOpenAIProviderId_v1` for the currently selected preset.
 *
 * "Default" vs "active": default is the preset auto-selected at app start;
 * active is the user's current in-session choice. They can differ.
 */

import { SavedOpenAIProvider } from '@/types/ai-types';

export const STORAGE_KEY = 'savedOpenAIProviders_v1';
export const ACTIVE_ID_KEY = 'activeOpenAIProviderId_v1';

const LEGACY_ENDPOINT_KEY = 'defaultAIEndpoint_openaiCompatible';
const LEGACY_API_KEY = 'defaultAIKey_openaiCompatible';
const LEGACY_MODEL_NAME_KEY = 'customModelName_openaiCompatible';

function generateId(): string {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return crypto.randomUUID();
    }
    return `prov_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

function readAll(): SavedOpenAIProvider[] {
    if (typeof window === 'undefined') return [];
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (p): p is SavedOpenAIProvider =>
                p && typeof p === 'object'
                && typeof p.id === 'string'
                && typeof p.name === 'string'
                && typeof p.endpoint === 'string'
                && typeof p.apiKey === 'string'
                && typeof p.modelName === 'string'
        );
    } catch {
        return [];
    }
}

function writeAll(providers: SavedOpenAIProvider[]): void {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(providers));
}

export function listSavedProviders(): SavedOpenAIProvider[] {
    return readAll();
}

export function getSavedProvider(id: string): SavedOpenAIProvider | undefined {
    return readAll().find((p) => p.id === id);
}

export function getDefaultProvider(): SavedOpenAIProvider | undefined {
    const all = readAll();
    return all.find((p) => p.isDefault) ?? all[0];
}

export function getActiveProviderId(): string | null {
    if (typeof window === 'undefined') return null;
    return window.localStorage.getItem(ACTIVE_ID_KEY);
}

export function setActiveProviderId(id: string | null): void {
    if (typeof window === 'undefined') return;
    if (id === null) {
        window.localStorage.removeItem(ACTIVE_ID_KEY);
    } else {
        window.localStorage.setItem(ACTIVE_ID_KEY, id);
    }
}

export function getActiveProvider(): SavedOpenAIProvider | undefined {
    const id = getActiveProviderId();
    if (id) {
        const found = getSavedProvider(id);
        if (found) return found;
    }
    return getDefaultProvider();
}

export interface ProviderInput {
    id?: string;
    name: string;
    endpoint: string;
    apiKey: string;
    modelName: string;
    isDefault?: boolean;
    contextWindow?: number;
    supportsVision?: boolean;
}

export interface ValidationResult {
    ok: boolean;
    errors: Partial<Record<'name' | 'endpoint' | 'modelName', string>>;
}

export function validateProvider(
    input: ProviderInput,
    existing: SavedOpenAIProvider[] = readAll(),
): ValidationResult {
    const errors: ValidationResult['errors'] = {};
    const name = input.name.trim();
    if (!name) {
        errors.name = 'Name is required.';
    } else if (existing.some((p) => p.id !== input.id && p.name.trim().toLowerCase() === name.toLowerCase())) {
        errors.name = 'A preset with this name already exists.';
    }

    const endpoint = input.endpoint.trim();
    if (!endpoint) {
        errors.endpoint = 'Endpoint URL is required.';
    } else if (!/^https?:\/\/.+/i.test(endpoint)) {
        errors.endpoint = 'Endpoint must start with http:// or https://.';
    }

    if (!input.modelName.trim()) {
        errors.modelName = 'Model name is required.';
    }

    return { ok: Object.keys(errors).length === 0, errors };
}

export function upsertSavedProvider(input: ProviderInput): SavedOpenAIProvider {
    const all = readAll();
    const now = Date.now();
    const existingIndex = input.id ? all.findIndex((p) => p.id === input.id) : -1;

    if (existingIndex >= 0) {
        const updated: SavedOpenAIProvider = {
            ...all[existingIndex],
            name: input.name.trim(),
            endpoint: input.endpoint.trim(),
            apiKey: input.apiKey,
            modelName: input.modelName.trim(),
            isDefault: input.isDefault ?? all[existingIndex].isDefault,
            contextWindow: input.contextWindow ?? all[existingIndex].contextWindow,
            supportsVision: input.supportsVision ?? all[existingIndex].supportsVision,
            updatedAt: now,
        };
        if (updated.isDefault) {
            all.forEach((p, i) => {
                if (i !== existingIndex) p.isDefault = false;
            });
        }
        all[existingIndex] = updated;
        writeAll(all);
        return updated;
    }

    const created: SavedOpenAIProvider = {
        id: input.id ?? generateId(),
        name: input.name.trim(),
        endpoint: input.endpoint.trim(),
        apiKey: input.apiKey,
        modelName: input.modelName.trim(),
        isDefault: input.isDefault ?? all.length === 0,
        contextWindow: input.contextWindow,
        supportsVision: input.supportsVision,
        createdAt: now,
        updatedAt: now,
    };
    if (created.isDefault) {
        all.forEach((p) => { p.isDefault = false; });
    }
    all.push(created);
    writeAll(all);
    return created;
}

export function deleteSavedProvider(id: string): void {
    const all = readAll();
    const target = all.find((p) => p.id === id);
    if (!target) return;
    const remaining = all.filter((p) => p.id !== id);
    if (target.isDefault && remaining.length > 0) {
        remaining[0].isDefault = true;
    }
    writeAll(remaining);

    if (getActiveProviderId() === id) {
        setActiveProviderId(remaining.find((p) => p.isDefault)?.id ?? remaining[0]?.id ?? null);
    }
}

export function setDefaultProvider(id: string): void {
    const all = readAll();
    let found = false;
    for (const p of all) {
        if (p.id === id) {
            p.isDefault = true;
            found = true;
        } else {
            p.isDefault = false;
        }
    }
    if (found) writeAll(all);
}

/**
 * One-shot migration: if no presets exist but the legacy single-config keys are
 * populated, lift them into a "Default" preset. Legacy keys are left in place
 * as a read-fallback during the transition.
 */
export function migrateLegacySingleConfig(): void {
    if (typeof window === 'undefined') return;
    if (readAll().length > 0) return;

    const endpoint = window.localStorage.getItem(LEGACY_ENDPOINT_KEY) ?? '';
    const apiKey = window.localStorage.getItem(LEGACY_API_KEY) ?? '';
    const modelName = window.localStorage.getItem(LEGACY_MODEL_NAME_KEY) ?? '';

    if (!endpoint && !modelName) return;

    const created = upsertSavedProvider({
        name: 'Default',
        endpoint: endpoint || 'http://127.0.0.1:8080/v1',
        apiKey,
        modelName: modelName || 'gpt-4o',
        isDefault: true,
    });
    setActiveProviderId(created.id);
}
