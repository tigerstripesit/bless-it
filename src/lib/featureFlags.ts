/**
 * Feature flags — runtime-mutable, persisted in localStorage.
 *
 * Defaults below are the compile-time baseline. User overrides (toggled from
 * the AI settings panel) are written to localStorage and applied on every
 * read via the Proxy in `featureFlags`.
 *
 * Usage:
 *     import { featureFlags } from '@/lib/featureFlags';
 *     if (featureFlags.memorySlidingWindow) { ... }
 *
 *     import { setFeatureFlag } from '@/lib/featureFlags';
 *     setFeatureFlag('memorySlidingWindow', false);
 *
 * Consumers that read `featureFlags.foo` always get the current value — no
 * subscription is needed for behavior changes to take effect on the next call.
 * UI components that need to re-render when a flag flips can listen for
 * `feature-flag-change` events on `window`.
 */

interface FeatureFlagsShape {
    /** Show the saved-preset picker in the AI chat header (OpenAI-compatible only). */
    headerPresetPicker: boolean;
    /** Phase 1 memory: trim history to a token budget before each call. */
    memorySlidingWindow: boolean;
    /** Phase 2 memory: maintain a running summary of long conversations. */
    memoryRunningSummary: boolean;
    /** Phase 3 memory: persist durable user facts and inject into every chat. */
    memoryUserProfile: boolean;
    /** Phase 4 memory: expose a search_conversations tool to the model. */
    memoryCrossConversationSearch: boolean;
    /** Phase 5 memory: decay stale facts and annotate old summaries. */
    memoryForgetting: boolean;
    /** Browser-use harness (M1): expose browser_open/navigate/observe/close
     *  tools to vision-capable models, driving a Playwright sidecar. */
    browserAgent: boolean;
}

const DEFAULTS: FeatureFlagsShape = {
    headerPresetPicker: false,
    memorySlidingWindow: true,
    memoryRunningSummary: true,
    memoryUserProfile: true,
    memoryCrossConversationSearch: true,
    memoryForgetting: true,
    browserAgent: false,
};

const STORAGE_KEY = 'ittoolkit.featureFlags';
const CHANGE_EVENT = 'feature-flag-change';

function loadOverrides(): Partial<FeatureFlagsShape> {
    if (typeof window === 'undefined') return {};
    try {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') return parsed as Partial<FeatureFlagsShape>;
    } catch {
        // ignore corrupt storage
    }
    return {};
}

const overrides: Partial<FeatureFlagsShape> = loadOverrides();

export const featureFlags: FeatureFlagsShape = new Proxy({} as FeatureFlagsShape, {
    get(_, key) {
        if (typeof key !== 'string') return undefined;
        if (!(key in DEFAULTS)) return undefined;
        const k = key as keyof FeatureFlagsShape;
        const override = overrides[k];
        return override === undefined ? DEFAULTS[k] : override;
    },
    has(_, key) {
        return typeof key === 'string' && key in DEFAULTS;
    },
    ownKeys() {
        return Object.keys(DEFAULTS);
    },
    getOwnPropertyDescriptor(_, key) {
        if (typeof key !== 'string' || !(key in DEFAULTS)) return undefined;
        return { enumerable: true, configurable: true, writable: false };
    },
});

function persist(): void {
    if (typeof window === 'undefined') return;
    try {
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(overrides));
    } catch {
        // ignore quota / disabled storage
    }
}

export function setFeatureFlag<K extends keyof FeatureFlagsShape>(key: K, value: boolean): void {
    overrides[key] = value;
    persist();
    if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { key, value } }));
    }
}

export function resetFeatureFlag<K extends keyof FeatureFlagsShape>(key: K): void {
    delete overrides[key];
    persist();
    if (typeof window !== 'undefined') {
        window.dispatchEvent(
            new CustomEvent(CHANGE_EVENT, { detail: { key, value: DEFAULTS[key] } }),
        );
    }
}

export function getFeatureFlagDefault<K extends keyof FeatureFlagsShape>(key: K): boolean {
    return DEFAULTS[key];
}

export function isFeatureFlagOverridden<K extends keyof FeatureFlagsShape>(key: K): boolean {
    return key in overrides;
}

export const FEATURE_FLAG_CHANGE_EVENT = CHANGE_EVENT;

export type FeatureFlag = keyof FeatureFlagsShape;
