// browser_extract handler — structured data extraction from the current page.
//
// Takes a JSON-Schema-flavored object with custom `x-selector` and
// `x-attr` extension fields, scoped optionally to `selector_hint`. Output
// mirrors the schema shape so the model can reason about it cleanly.
//
// Supported shapes:
//   1) Array of records:
//      {
//        "type": "array",
//        "x-selector": "table tbody tr",
//        "items": {
//          "type": "object",
//          "properties": {
//            "title": { "type": "string", "x-selector": "td:nth-child(1)" },
//            "url":   { "type": "string", "x-selector": "a", "x-attr": "href" }
//          }
//        }
//      }
//
//   2) Single record:
//      {
//        "type": "object",
//        "properties": {
//          "headline": { "type": "string", "x-selector": "h1" }
//        }
//      }
//
// If `x-attr` is absent, the field's textContent is used. Limit: ARRAY_CAP
// rows max per array, scoped to `selector_hint` if provided.

import { getSession } from '../sessions.js';

const ARRAY_CAP = 200;

interface ExtractParams {
    session_id?: string;
    schema?: unknown;
    selector_hint?: string;
}

interface ExtractResult {
    url: string;
    title: string;
    data: unknown;
    /** Echo of the scope so the caller can sanity-check. */
    scope: string;
}

export async function handleExtract(params: ExtractParams): Promise<ExtractResult> {
    if (!params.session_id) throw new Error('browser.extract requires "session_id"');
    if (!params.schema || typeof params.schema !== 'object') {
        throw new Error('browser.extract requires "schema" (object with type=array|object)');
    }
    const ref = getSession(params.session_id);
    if (!ref) {
        throw new Error(`browser.extract: session "${params.session_id}" not open. Call browser.open first.`);
    }
    const scope = (params.selector_hint ?? 'body').toString();

    const data = await ref.page.evaluate(
        ([schema, scope, arrayCap]) => {
            const root = (document.querySelector(scope as string) ?? document) as ParentNode;

            const readNode = (el: Element, propSchema: any): unknown => {
                const attr = propSchema?.['x-attr'];
                const type = propSchema?.type ?? 'string';
                let raw: string | null;
                if (attr) {
                    raw = el.getAttribute(attr);
                } else {
                    raw = (el as HTMLElement).innerText ?? el.textContent ?? '';
                }
                if (raw == null) return null;
                const s = String(raw).replace(/\s+/g, ' ').trim();
                if (type === 'number' || type === 'integer') {
                    const n = Number(s.replace(/[, ]/g, ''));
                    return Number.isFinite(n) ? n : null;
                }
                if (type === 'boolean') {
                    return /^(true|yes|on|1)$/i.test(s);
                }
                return s;
            };

            const extractOne = (within: ParentNode, propsSchema: any): Record<string, unknown> => {
                const out: Record<string, unknown> = {};
                const properties = propsSchema?.properties ?? {};
                for (const [field, fieldSchema] of Object.entries(properties as Record<string, any>)) {
                    const sel = fieldSchema?.['x-selector'];
                    let node: Element | null;
                    if (sel) {
                        node = within.querySelector(String(sel));
                    } else if (within instanceof Element) {
                        node = within;
                    } else {
                        node = null;
                    }
                    out[field] = node ? readNode(node, fieldSchema) : null;
                }
                return out;
            };

            const s = schema as any;
            if (s?.type === 'array') {
                const itemSelector = s['x-selector'];
                if (!itemSelector) {
                    throw new Error('extract: array schemas need an "x-selector" pointing at the row element.');
                }
                const rows = Array.from(root.querySelectorAll(String(itemSelector))).slice(0, arrayCap as number);
                return rows.map((row) => extractOne(row, s.items ?? {}));
            }
            if (s?.type === 'object') {
                return extractOne(root, s);
            }
            throw new Error(`extract: unsupported schema.type "${s?.type ?? '<missing>'}" — use "array" or "object".`);
        },
        [params.schema, scope, ARRAY_CAP],
    );

    return {
        url: ref.page.url(),
        title: await ref.page.title().catch(() => ''),
        data,
        scope,
    };
}
