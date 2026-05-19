/**
 * Browser-use screenshot retention.
 *
 * Each `browser_observe` adds ~30–80 KB base64 to context. Without a cap, a
 * multi-step browser session would re-pay every screenshot every turn. We
 * retain only the N most-recent screenshots in the conversation; older
 * tool-result messages keep their AX tree (text) but lose `images`, and the
 * text is annotated so the model knows a screenshot was elided.
 *
 * This module is wire-format only — the stored conversation on disk never
 * had `images` to begin with (those are populated at tool-dispatch time).
 */

import { ChatMessage } from '@/types/ai-types';

const OMITTED_MARKER = '\n\n[screenshot omitted — only the latest N=3 are kept in context to save tokens]';

export interface ScreenshotRetentionResult {
    messages: ChatMessage[];
    /** How many screenshots were stripped from older messages. */
    strippedCount: number;
    /** How many messages still carry images after retention. */
    retainedCount: number;
}

export function trimScreenshotPayload(
    messages: ChatMessage[],
    maxKept: number = 3,
): ScreenshotRetentionResult {
    if (maxKept <= 0) {
        // Strip all screenshots.
        const out = messages.map((m) => {
            if (!m.images?.length) return m;
            return {
                ...m,
                images: undefined,
                content: appendMarkerOnce(m.content),
            };
        });
        const stripped = messages.filter((m) => m.images?.length).length;
        return { messages: out, strippedCount: stripped, retainedCount: 0 };
    }

    // Walk from newest to oldest, retain the first `maxKept` messages with
    // images, strip the rest.
    const result: ChatMessage[] = new Array(messages.length);
    let kept = 0;
    let stripped = 0;
    for (let i = messages.length - 1; i >= 0; i--) {
        const m = messages[i];
        if (!m.images?.length) {
            result[i] = m;
            continue;
        }
        if (kept < maxKept) {
            result[i] = m;
            kept += 1;
        } else {
            result[i] = {
                ...m,
                images: undefined,
                content: appendMarkerOnce(m.content),
            };
            stripped += 1;
        }
    }

    return { messages: result, strippedCount: stripped, retainedCount: kept };
}

function appendMarkerOnce(content: string): string {
    if (content.includes(OMITTED_MARKER.trim())) return content;
    return content + OMITTED_MARKER;
}
