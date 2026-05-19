// Site-profile registry — URL hostname → per-site browser automation config.
//
// Profiles are matched automatically on every browser.navigate call and stored
// on the SessionRef. Handlers read the profile to auto-apply:
//   - waitForIdle / readySelector  (observe.ts)
//   - locatorStrategies            (act.ts — prepended before generic chain)
//   - dismissSelectors             (navigate.ts — cookie banners etc.)
//   - axMaxElements                (observe.ts — override default 80)
//   - preActDelayMs                (act.ts — small delay for slow SPAs)
//
// Unknown sites fall through to generic behavior unchanged.

export interface LocatorStrategy {
    /** CSS selector template. Use {name} as placeholder for the AX node name.
     *  Example: '[aria-label="{name}"]' */
    selector: string;
    /** Restrict this strategy to specific AX roles. Omit = apply to all roles. */
    roles?: string[];
}

export interface SiteProfile {
    /** Human label used in log messages. */
    name: string;
    /** Hostnames this profile matches. Simple glob: '*' matches any segment. */
    hostPatterns: string[];
    /** Automatically apply networkidle wait in browser_observe.
     *  Use for JS-rendered SPAs where domcontentloaded fires before content. */
    waitForIdle: boolean;
    /** CSS selector for an element that must exist before the AX snapshot is safe.
     *  Checked after waitForIdle (if enabled). */
    readySelector?: string;
    /** Max ms to wait for readySelector. Default: 10000. */
    readyTimeout?: number;
    /** Site-specific locator strategies tried BEFORE the generic 6-step chain.
     *  Use when a site has non-standard ARIA patterns. */
    locatorStrategies?: LocatorStrategy[];
    /** CSS selectors for banners/dialogs to auto-dismiss after navigation.
     *  Clicked once, failures silently ignored. */
    dismissSelectors?: string[];
    /** Override the default 80-element AX cap. Use for content-heavy pages. */
    axMaxElements?: number;
    /** Delay in ms before each browser_act on this site.
     *  Some SPAs re-render between observe and act; a small delay stabilises them. */
    preActDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Registry — add new sites here. hostPatterns use '*' for wildcard segments.
// ---------------------------------------------------------------------------

const PROFILES: SiteProfile[] = [
    {
        name: 'WhatsApp Web',
        hostPatterns: ['web.whatsapp.com'],
        waitForIdle: true,
        readySelector: '#pane-side',
        readyTimeout: 20_000,
        locatorStrategies: [
            { selector: '[aria-label="{name}"]' },
            { selector: '[data-testid="{name}"]' },
            { selector: 'span[title="{name}"]' },
        ],
    },
    {
        name: 'Microsoft Teams',
        hostPatterns: ['teams.microsoft.com', 'teams.live.com'],
        waitForIdle: true,
        readySelector: '[data-tid="app-layout-area--main"]',
        readyTimeout: 30_000,
        locatorStrategies: [
            { selector: '[data-tid="{name}"]' },
            { selector: '[aria-label="{name}"]' },
        ],
        preActDelayMs: 150,
    },
    {
        name: 'Gmail',
        hostPatterns: ['mail.google.com'],
        waitForIdle: true,
        readySelector: '[role="main"]',
        locatorStrategies: [
            { selector: '[aria-label="{name}"]' },
            { selector: '[data-tooltip="{name}"]' },
        ],
    },
    {
        name: 'Slack',
        hostPatterns: ['app.slack.com'],
        waitForIdle: true,
        readySelector: '[data-qa="channel_sidebar"]',
        locatorStrategies: [
            { selector: '[data-qa="{name}"]' },
            { selector: '[aria-label="{name}"]' },
        ],
    },
    {
        name: 'Notion',
        hostPatterns: ['www.notion.so', 'notion.so'],
        waitForIdle: true,
        readySelector: '.notion-page-content',
        readyTimeout: 15_000,
        preActDelayMs: 200,
        axMaxElements: 120,
    },
    {
        name: 'GitHub',
        hostPatterns: ['github.com'],
        waitForIdle: false,
        locatorStrategies: [
            { selector: '[aria-label="{name}"]' },
            { selector: '[data-component="{name}"]' },
        ],
    },
    {
        name: 'Linear',
        hostPatterns: ['linear.app'],
        waitForIdle: true,
        readySelector: '[data-view-id]',
        locatorStrategies: [
            { selector: '[aria-label="{name}"]' },
        ],
        preActDelayMs: 100,
    },
    {
        name: 'Figma',
        hostPatterns: ['www.figma.com', 'figma.com'],
        waitForIdle: true,
        readySelector: '[data-testid="canvas-container"]',
        readyTimeout: 20_000,
        locatorStrategies: [
            { selector: '[aria-label="{name}"]' },
            { selector: '[data-testid="{name}"]' },
        ],
        axMaxElements: 60,
    },
    {
        name: 'Microsoft 365 Admin',
        hostPatterns: ['admin.microsoft.com'],
        waitForIdle: true,
        readySelector: '[data-automationid="AdminApp"], [data-bi-area="MicrosoftAdminCenter"]',
        readyTimeout: 25_000,
        locatorStrategies: [
            { selector: '[data-automationid="{name}"]' },
            { selector: '[aria-label="{name}"]' },
            { selector: '[data-aut-id="{name}"]' },
        ],
        dismissSelectors: ['[aria-label="Close"]', '[data-testid="cookie-banner-accept"]'],
        preActDelayMs: 200,
    },
    {
        name: 'Okta Admin',
        hostPatterns: ['*.okta.com', '*.okta-gov.com', '*.oktapreview.com'],
        waitForIdle: true,
        readySelector: '#header, .sidenav, [data-se="o-header"]',
        readyTimeout: 20_000,
        locatorStrategies: [
            { selector: '[data-se="{name}"]' },
            { selector: '[aria-label="{name}"]' },
            { selector: '[data-testid="{name}"]' },
        ],
        preActDelayMs: 150,
    },
    {
        name: 'Jira / Confluence',
        hostPatterns: ['*.atlassian.net'],
        waitForIdle: true,
        readySelector: '[data-testid="navigation-container"], #atlassian-navigation',
        readyTimeout: 20_000,
        locatorStrategies: [
            { selector: '[data-testid="{name}"]' },
            { selector: '[aria-label="{name}"]' },
            { selector: '[data-ds--text-field--input="{name}"]' },
            // ProseMirror rich-text editor (Description field) is a contenteditable div,
            // not a standard input. Matched when the agent targets textbox/generic nodes.
            { selector: '.ProseMirror[contenteditable="true"]', roles: ['textbox', 'generic'] },
        ],
        preActDelayMs: 150,
    },
    {
        name: 'ServiceNow',
        hostPatterns: ['*.service-now.com'],
        waitForIdle: true,
        readySelector: '.navpage-main, [id="gsft_main"]',
        readyTimeout: 30_000,
        locatorStrategies: [
            { selector: '[aria-label="{name}"]' },
            { selector: 'label:has-text("{name}") + input, label:has-text("{name}") + select' },
            { selector: '[name="{name}"]' },
        ],
        dismissSelectors: ['[aria-label="Close dialog"]'],
        preActDelayMs: 300,
    },
];

// ---------------------------------------------------------------------------
// Matcher
// ---------------------------------------------------------------------------

/** Simple glob match: '*' in pattern matches any non-dot hostname segment.
 *  e.g. '*.slack.com' matches 'app.slack.com' but not 'slack.com'. */
function globMatch(pattern: string, host: string): boolean {
    if (pattern === host) return true;
    if (!pattern.includes('*')) return false;
    // Convert glob to regex: escape dots, replace * with [^.]+
    const re = new RegExp(
        '^' + pattern.replace(/\./g, '\\.').replace(/\*/g, '[^.]+') + '$'
    );
    return re.test(host);
}

/** Return the first matching SiteProfile for the given URL, or undefined. */
export function matchProfile(url: string): SiteProfile | undefined {
    let host: string;
    try {
        host = new URL(url).hostname.toLowerCase();
    } catch {
        return undefined;
    }
    return PROFILES.find(p =>
        p.hostPatterns.some(pat => globMatch(pat.toLowerCase(), host))
    );
}
