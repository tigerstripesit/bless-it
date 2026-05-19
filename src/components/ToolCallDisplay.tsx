'use client';

/**
 * Tool Call Display Component
 *
 * Displays tool execution in a user-friendly, collapsible format.
 * Follows standard patterns from ChatGPT, Claude, and OpenWebUI.
 */

import React, { useState } from 'react';
import {
    makeStyles,
    tokens,
    shorthands,
    Text,
    Button,
} from '@fluentui/react-components';
import {
    ChevronDown16Regular,
    ChevronUp16Regular,
    CheckmarkCircle16Regular,
    ErrorCircle16Regular,
    ArrowSync16Regular,
    Code16Regular,
    Wrench16Regular,
    Warning20Regular,
    ErrorCircle20Regular,
    Info20Regular,
    Sparkle24Regular,
    Dismiss12Regular,
} from '@fluentui/react-icons';
import { ToolExecutionData } from '@/types/ai-types';
import { AgentActionChip } from './AgentActionChip';
import { WorkflowCard } from './workflow/WorkflowCard';

/** Lightweight Fluent-styled table for browser_extract array results.
 *  Picks columns from the first row's keys; renders ≤50 rows, ≤6 columns
 *  to keep the chat bubble manageable. */
function BrowserExtractTable({ rows }: { rows: Array<Record<string, unknown>> }) {
    if (rows.length === 0) return null;
    const columns = Object.keys(rows[0]).slice(0, 6);
    const display = rows.slice(0, 50);
    const overflow = rows.length - display.length;
    return (
        <div style={{ padding: '8px 12px 12px' }}>
            <div style={{
                overflowX: 'auto',
                border: `1px solid ${tokens.colorNeutralStroke2}`,
                borderRadius: 4,
            }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                    <thead>
                        <tr style={{ background: tokens.colorNeutralBackground3 }}>
                            {columns.map((c) => (
                                <th key={c} style={{
                                    textAlign: 'left',
                                    padding: '6px 8px',
                                    borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
                                    fontWeight: 600,
                                }}>{c}</th>
                            ))}
                        </tr>
                    </thead>
                    <tbody>
                        {display.map((row, i) => (
                            <tr key={i}>
                                {columns.map((c) => {
                                    const v = row[c];
                                    const text = v == null ? '' : typeof v === 'object' ? JSON.stringify(v) : String(v);
                                    return (
                                        <td key={c} style={{
                                            padding: '6px 8px',
                                            borderBottom: `1px solid ${tokens.colorNeutralStroke2}`,
                                            verticalAlign: 'top',
                                            maxWidth: 320,
                                            overflow: 'hidden',
                                            textOverflow: 'ellipsis',
                                            whiteSpace: 'nowrap',
                                        }}>{text}</td>
                                    );
                                })}
                            </tr>
                        ))}
                    </tbody>
                </table>
            </div>
            {overflow > 0 && (
                <Text size={200} style={{ color: tokens.colorNeutralForeground3, marginTop: 4, display: 'block' }}>
                    … {overflow} more rows elided
                </Text>
            )}
        </div>
    );
}

const useStyles = makeStyles({
    container: {
        ...shorthands.margin('8px', '0'),
        ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
        ...shorthands.borderRadius('8px'),
        backgroundColor: tokens.colorNeutralBackground2,
        ...shorthands.overflow('hidden'),
    },
    header: {
        display: 'flex',
        alignItems: 'center',
        ...shorthands.gap('8px'),
        ...shorthands.padding('8px', '12px'),
        cursor: 'pointer',
        '&:hover': {
            backgroundColor: tokens.colorNeutralBackground3,
        },
    },
    headerLeft: {
        display: 'flex',
        alignItems: 'center',
        ...shorthands.gap('8px'),
        flex: 1,
    },
    icon: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
    },
    statusIcon: {
        display: 'flex',
        alignItems: 'center',
    },
    expandIcon: {
        display: 'flex',
        alignItems: 'center',
    },
    content: {
        ...shorthands.padding('0', '12px', '12px', '12px'),
        ...shorthands.borderTop('1px', 'solid', tokens.colorNeutralStroke2),
    },
    section: {
        marginBottom: '12px',
        '&:last-child': {
            marginBottom: 0,
        },
    },
    sectionTitle: {
        fontSize: '12px',
        fontWeight: 600,
        color: tokens.colorNeutralForeground3,
        marginBottom: '4px',
        textTransform: 'uppercase',
    },
    codeBlock: {
        backgroundColor: tokens.colorNeutralBackground1,
        ...shorthands.padding('8px'),
        ...shorthands.borderRadius('4px'),
        fontFamily: 'monospace',
        fontSize: '12px',
        overflowX: 'auto',
        whiteSpace: 'pre-wrap',
        wordBreak: 'break-word',
        maxHeight: '200px',
        overflowY: 'auto',
        ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke1),
    },
    inline: {
        display: 'inline-flex',
        alignItems: 'center',
        ...shorthands.gap('4px'),
    },
    confirmCard: {
        ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
        ...shorthands.borderRadius('8px'),
        backgroundColor: tokens.colorNeutralBackground1,
        ...shorthands.padding('12px'),
        display: 'flex',
        flexDirection: 'column',
        ...shorthands.gap('12px'),
        marginTop: '8px',
    },
    cardHeader: {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
    },
    cardTitle: {
        fontSize: '14px',
        fontWeight: 600,
    },
    severityBadge: {
        display: 'inline-flex',
        alignItems: 'center',
        ...shorthands.gap('4px'),
        ...shorthands.padding('2px', '8px'),
        ...shorthands.borderRadius('4px'),
        fontSize: '11px',
        fontWeight: 600,
        textTransform: 'uppercase',
    },
    severityLow: {
        backgroundColor: tokens.colorPaletteLightGreenBackground2,
        color: tokens.colorPaletteLightGreenForeground1,
    },
    severityMedium: {
        backgroundColor: tokens.colorPaletteYellowBackground2,
        color: tokens.colorPaletteYellowForeground1,
    },
    severityHigh: {
        backgroundColor: tokens.colorPaletteRedBackground2,
        color: tokens.colorPaletteRedForeground1,
    },
    cardDescription: {
        fontSize: '13px',
        color: tokens.colorNeutralForeground2,
        lineHeight: 1.4,
    },
    itemList: {
        display: 'flex',
        flexDirection: 'column',
        ...shorthands.gap('4px'),
        backgroundColor: tokens.colorNeutralBackground2,
        ...shorthands.padding('8px'),
        ...shorthands.borderRadius('6px'),
        maxHeight: '160px',
        overflowY: 'auto',
        ...shorthands.border('1px', 'solid', tokens.colorNeutralStroke2),
    },
    itemRow: {
        display: 'flex',
        alignItems: 'center',
        ...shorthands.gap('8px'),
        fontSize: '12px',
        fontFamily: 'monospace',
    },
    sizeRow: {
        display: 'flex',
        ...shorthands.gap('12px'),
        alignItems: 'baseline',
    },
    totalSize: {
        fontSize: '14px',
        fontWeight: 600,
    },
    cardActions: {
        display: 'flex',
        justifyContent: 'flex-end',
        ...shorthands.gap('8px'),
        paddingTop: '4px',
    },
    suggestSkillCard: {
        ...shorthands.border('1px', 'solid', tokens.colorBrandStroke1),
        ...shorthands.borderRadius('8px'),
        backgroundColor: tokens.colorNeutralBackground1,
        ...shorthands.padding('12px'),
        display: 'flex',
        flexDirection: 'column',
        ...shorthands.gap('10px'),
        marginTop: '8px',
    },
    suggestSkillHeader: {
        display: 'flex',
        alignItems: 'center',
        ...shorthands.gap('8px'),
    },
    suggestSkillTitle: {
        fontSize: '14px',
        fontWeight: 600,
        color: tokens.colorBrandForeground1,
    },
});

interface ToolCallDisplayProps {
    execution: ToolExecutionData;
    onActionResponse?: (actionId: string, response: 'confirm' | 'dismiss' | 'accept' | 'edit' | 'decline') => void;
}

function formatSize(bytes: number): string {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(1024));
    const size = bytes / Math.pow(1024, i);
    return `${size.toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function ToolCallDisplay({ execution, onActionResponse }: ToolCallDisplayProps) {
    const styles = useStyles();
    const [isExpanded, setIsExpanded] = useState(true);

    const getStatusIcon = () => {
        switch (execution.status) {
            case 'executing':
                return <ArrowSync16Regular className={styles.statusIcon} />;
            case 'success':
                return <CheckmarkCircle16Regular className={styles.statusIcon} style={{ color: tokens.colorPaletteGreenForeground1 }} />;
            case 'error':
                return <ErrorCircle16Regular className={styles.statusIcon} style={{ color: tokens.colorPaletteRedForeground1 }} />;
            case 'cancelled':
                return <ErrorCircle16Regular className={styles.statusIcon} style={{ color: tokens.colorPaletteYellowForeground1 }} />;
        }
    };

    const getStatusText = () => {
        switch (execution.status) {
            case 'executing':
                return 'Executing...';
            case 'success':
                return execution.executionTimeMs ? `Completed in ${execution.executionTimeMs}ms` : 'Completed';
            case 'error':
                return 'Failed';
            case 'cancelled':
                return 'Cancelled';
        }
    };

    function getCommandIntent(cmd: string): string {
        const trimmed = cmd.trim();
        const firstWord = trimmed.split(/\s+/)[0] || '';

        const firstNonFlagArg = (args: string): string | null => {
            for (const part of args.split(/\s+/)) {
                if (part && !part.startsWith('-')) return part;
            }
            return null;
        };
        const patterns: [RegExp, (m: RegExpMatchArray) => string][] = [
            [/^cat\s+(.+)/, (m) => `Read file: ${firstNonFlagArg(m[1]) ?? m[1].split(/\s+/)[0]}`],
            [/^ls\s+(.+)/, (m) => {
                const path = firstNonFlagArg(m[1]);
                return path ? `List directory: ${path}` : 'List directory contents';
            }],
            [/^ls\b/, () => 'List directory contents'],
            [/^find\s/, () => 'Search for files'],
            [/^grep\s/, () => 'Search file contents'],
            [/^rm\s+(.+)/, (m) => `Remove file: ${m[1].split(/\s+/)[0]}`],
            [/^mv\s+(.+)/, (m) => `Move/rename: ${m[1].split(/\s+/)[0]}`],
            [/^cp\s+(.+)/, (m) => `Copy: ${m[1].split(/\s+/)[0]}`],
            [/^mkdir\s+(.+)/, (m) => `Create directory: ${m[1].split(/\s+/)[0]}`],
            [/^echo\s/, () => trimmed.includes('>') ? 'Write to file' : 'Output text'],
            [/^du\s/, () => 'Check disk usage'],
            [/^df\s/, () => 'Check disk space'],
            [/^pwd\b/, () => 'Show current directory'],
            [/^which\s+(.+)/, (m) => `Locate: ${m[1]}`],
            [/^uname\b/, () => 'Show system info'],
            [/^whoami\b/, () => 'Show current user'],
            [/^head\s+(.+)/, (m) => `Read start: ${m[1].split(/\s+/)[0]}`],
            [/^tail\s+(.+)/, (m) => `Read end: ${m[1].split(/\s+/)[0]}`],
            [/^wc\s+(.+)/, (m) => `Count: ${m[1].split(/\s+/)[0]}`],
            [/^sort\s+(.+)/, (m) => `Sort file: ${m[1].split(/\s+/)[0]}`],
            [/^diff\s/, () => 'Compare files'],
            [/^chmod\s/, () => 'Change permissions'],
            [/^file\s+(.+)/, (m) => `Identify: ${m[1].split(/\s+/)[0]}`],
            [/^stat\s+(.+)/, (m) => `Details: ${m[1].split(/\s+/)[0]}`],
        ];

        for (const [pattern, handler] of patterns) {
            const match = trimmed.match(pattern);
            if (match) return handler(match);
        }

        return `Execute: ${firstWord}`;
    }

    const getIntentLabel = (): string => {
        if (execution.toolName !== 'execute_command') {
            const nameMap: Record<string, string> = {
                'read_file': 'Read File',
                'list_directory': 'List Directory',
                'search_files': 'Search Files',
                'write_file': 'Write File',
                'get_file_info': 'Get File Info',
            };
            return nameMap[execution.toolName] || execution.toolName.split('_').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
        }
        const cmd = execution.arguments?.cmd as string;
        if (cmd) return getCommandIntent(cmd);
        return 'Execute Command';
    };

    const formatArguments = (args: Record<string, unknown>): string => {
        // Format arguments in a readable way
        return Object.entries(args)
            .map(([key, value]) => {
                if (typeof value === 'string' && value.length > 100) {
                    return `${key}: ${value.substring(0, 100)}...`;
                }
                return `${key}: ${JSON.stringify(value)}`;
            })
            .join('\n');
    };

    /** Extract file/folder paths from tab-separated tool output (du -sh,
     *  ls -la, find -printf "%s\\t%p", etc.). Only handles the tab-separated
     *  form so paths with spaces work correctly — flowing-text regex
     *  extraction was too easy to confuse on macOS volumes like
     *  "/Volumes/Time Machine Backups/…". For all other commands we'd rather
     *  show zero chips than the wrong ones; the agent should emit a
     *  structured agent_action instead. */
    function extractPathsFromTabSeparated(text: string | undefined): string[] {
        if (!text) return [];
        const seen = new Set<string>();
        const paths: string[] = [];
        for (const line of text.split('\n')) {
            const tabIdx = line.lastIndexOf('\t');
            if (tabIdx < 0) continue;
            const candidate = line.slice(tabIdx + 1).trim();
            if (candidate.length <= 2) continue;
            if (!candidate.startsWith('/') && !candidate.startsWith('~')) continue;
            if (seen.has(candidate)) continue;
            seen.add(candidate);
            paths.push(candidate);
        }
        return paths.slice(0, 8);
    }

    /** Whether this tool call's output is shaped like `du`/`ls` — i.e. tab-
     *  separated rows where the trailing field is a path. We only bother
     *  with text extraction for these commands; everything else relies on
     *  structured agent_action emits. */
    function isTabSeparatedPathCommand(execution: ToolExecutionData): boolean {
        if (execution.toolName !== 'execute_command') return false;
        const cmd = (execution.arguments?.cmd as string | undefined)?.trim() ?? '';
        return /^(du|ls|find|stat|wc)\b/.test(cmd);
    }

    // Combine paths from structured actions + (narrow) text extraction.
    const pathChips = (() => {
        const chips: { path: string; label?: string }[] = [];
        const seen = new Set<string>();
        // 1) Structured actions — always preferred when present.
        for (const action of execution.actions ?? []) {
            if (
                (action.type === 'navigate' || action.type === 'open_file') &&
                typeof action.payload.path === 'string' &&
                !seen.has(action.payload.path)
            ) {
                const p = action.payload.path;
                seen.add(p);
                chips.push({
                    path: p,
                    label: action.type === 'navigate' ? p : `Open: ${p}`,
                });
            }
        }
        // 2) Tab-separated fallback for du/ls/find/stat/wc only.
        //    Check both result and error — some backends put stdout in error
        //    when the tool reports a non-zero exit code.
        if (chips.length === 0 && isTabSeparatedPathCommand(execution)) {
            const candidates = [
                ...extractPathsFromTabSeparated(execution.result),
                ...extractPathsFromTabSeparated(execution.error),
            ];
            for (const p of candidates) {
                if (!seen.has(p)) {
                    seen.add(p);
                    chips.push({ path: p });
                }
            }
        }
        return chips;
    })();

    return (
        <div className={styles.container}>
            <div className={styles.header} onClick={() => setIsExpanded(!isExpanded)}>
                <div className={styles.headerLeft}>
                    <div className={styles.icon}>
                        <Wrench16Regular />
                    </div>
                    <Text weight="semibold" size={300}>
                        {getIntentLabel()}
                    </Text>
                    {getStatusIcon()}
                    <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                        {getStatusText()}
                    </Text>
                </div>
                <div className={styles.expandIcon}>
                    {isExpanded ? <ChevronUp16Regular /> : <ChevronDown16Regular />}
                </div>
            </div>

            {isExpanded && (
                <div className={styles.content}>
                    {/* Arguments Section */}
                    <div className={styles.section}>
                        <div className={styles.sectionTitle}>Arguments</div>
                        <div className={styles.codeBlock}>
                            {formatArguments(execution.arguments)}
                        </div>
                    </div>

                    {/* Path Chips (if any extracted) */}
                    {pathChips.length > 0 && (
                        <div className={styles.section}>
                            <div className={styles.sectionTitle}>Locations</div>
                            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '4px' }}>
                                {pathChips.map((chip, i) => (
                                    <AgentActionChip
                                        key={`${chip.path}-${i}`}
                                        path={chip.path}
                                        label={chip.label}
                                    />
                                ))}
                            </div>
                        </div>
                    )}

                    {/* Confirm Action Inline Card */}
                    {execution.actions?.map((action, idx) => {
                        if (action.type !== 'confirm_action') return null;
                        const p = action.payload;
                        const SeverityIcon = p.severity === 'high' ? ErrorCircle20Regular
                            : p.severity === 'medium' ? Warning20Regular
                            : Info20Regular;
                        const severityClass = p.severity === 'high' ? styles.severityHigh
                            : p.severity === 'medium' ? styles.severityMedium
                            : styles.severityLow;
                        const severityLabel = p.severity === 'high' ? 'High Risk'
                            : p.severity === 'medium' ? 'Medium Risk'
                            : 'Low Risk';
                        return (
                            <div key={idx} className={styles.confirmCard}>
                                <div className={styles.cardHeader}>
                                    <Text className={styles.cardTitle}>{p.title}</Text>
                                    <span className={`${styles.severityBadge} ${severityClass}`}>
                                        <SeverityIcon fontSize={14} />
                                        {severityLabel}
                                    </span>
                                </div>
                                {p.description && (
                                    <Text className={styles.cardDescription}>{p.description}</Text>
                                )}
                                {p.items.length > 0 && (
                                    <div>
                                        <Text size={200} weight="semibold" style={{ marginBottom: '4px', display: 'block' }}>
                                            Items ({p.items.length})
                                        </Text>
                                        <div className={styles.itemList}>
                                            {p.items.map((item, i) => (
                                                <div key={i} className={styles.itemRow}>
                                                    <Text size={200} style={{ color: tokens.colorNeutralForeground3, flexShrink: 0 }}>{i + 1}.</Text>
                                                    <Text>{item}</Text>
                                                </div>
                                            ))}
                                        </div>
                                    </div>
                                )}
                                {p.totalSize > 0 && (
                                    <div className={styles.sizeRow}>
                                        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>Total Size</Text>
                                        <Text className={styles.totalSize}>{formatSize(p.totalSize)}</Text>
                                    </div>
                                )}
                                <div className={styles.cardActions}>
                                    <Button
                                        appearance="secondary"
                                        size="small"
                                        onClick={() => onActionResponse?.(p.actionId, 'dismiss')}
                                    >
                                        Dismiss
                                    </Button>
                                    <Button
                                        appearance="primary"
                                        size="small"
                                        style={p.severity === 'high' ? { backgroundColor: '#d13438', color: 'white' } as React.CSSProperties : undefined}
                                        onClick={() => onActionResponse?.(p.actionId, 'confirm')}
                                    >
                                        {p.severity === 'high' ? 'Proceed Anyway' : 'Execute'}
                                    </Button>
                                </div>
                            </div>
                        );
                    })}

                    {/* Browser tool inline preview (screenshot + url chip). */}
                    {execution.actions?.map((action, idx) => {
                        if (action.type !== 'browser_preview') return null;
                        const p = action.payload;
                        return (
                            <div
                                key={`browser-${idx}`}
                                className={styles.section}
                                style={{
                                    border: `1px solid ${tokens.colorNeutralStroke2}`,
                                    borderRadius: 8,
                                    overflow: 'hidden',
                                }}
                            >
                                <div
                                    style={{
                                        padding: '8px 12px',
                                        background: tokens.colorNeutralBackground3,
                                        display: 'flex',
                                        flexDirection: 'column',
                                        gap: 2,
                                    }}
                                >
                                    <Text size={200} weight="semibold">
                                        {p.kind === 'browser_observe' ? 'Browser observation' :
                                         p.kind === 'browser_navigate' ? 'Browser navigation' :
                                         p.kind === 'browser_open' ? 'Browser opened' :
                                         p.kind === 'browser_close' ? 'Browser closed' :
                                         p.kind}
                                    </Text>
                                    {p.url && (
                                        <Text size={200} style={{ color: tokens.colorNeutralForeground3, wordBreak: 'break-all' }}>
                                            {p.url}
                                        </Text>
                                    )}
                                    {p.title && (
                                        <Text size={200}>{p.title}</Text>
                                    )}
                                    {typeof p.nodeCount === 'number' && (
                                        <Text size={200} style={{ color: tokens.colorNeutralForeground3 }}>
                                            {p.nodeCount} interactive {p.nodeCount === 1 ? 'node' : 'nodes'} detected
                                        </Text>
                                    )}
                                </div>
                                {p.screenshot && (
                                    <img
                                        src={`data:image/jpeg;base64,${p.screenshot}`}
                                        alt={p.title ?? 'browser screenshot'}
                                        style={{
                                            display: 'block',
                                            width: '100%',
                                            maxHeight: 400,
                                            objectFit: 'contain',
                                            background: tokens.colorNeutralBackground1,
                                        }}
                                    />
                                )}
                                {p.kind === 'browser_extract' && Array.isArray((p as any).data) && (p as any).data.length > 0 && (
                                    <BrowserExtractTable rows={(p as any).data as Array<Record<string, unknown>>} />
                                )}
                                {p.kind === 'browser_extract' && (p as any).data && !Array.isArray((p as any).data) && (
                                    <div className={styles.codeBlock} style={{ margin: '8px 12px' }}>
                                        {JSON.stringify((p as any).data, null, 2)}
                                    </div>
                                )}
                            </div>
                        );
                    })}

                    {/* Workflow Card */}
                    {execution.actions?.map((action, idx) => {
                        if (action.type !== 'workflow_card') return null;
                        const p = action.payload;
                        return (
                            <div key={`workflow-card-${idx}`} style={{ margin: '8px 0' }}>
                                <div style={{
                                    display: 'flex',
                                    justifyContent: 'flex-end',
                                    marginBottom: '4px',
                                }}>
                                    <Button
                                        size="small"
                                        appearance="subtle"
                                        icon={<Dismiss12Regular />}
                                        onClick={() => onActionResponse?.(p.actionId, 'dismiss')}
                                    />
                                </div>
                                <WorkflowCard
                                    workflow={p.workflow}
                                    onAccept={() => onActionResponse?.(p.actionId, 'accept')}
                                    onEdit={(slug) => {
                                        window.dispatchEvent(new CustomEvent('workflow:edit', { detail: { slug } }));
                                        onActionResponse?.(p.actionId, 'edit');
                                    }}
                                    onDismiss={() => onActionResponse?.(p.actionId, 'dismiss')}
                                />
                            </div>
                        );
                    })}

                    {/* Suggest Skill Inline Card */}
                    {execution.actions?.map((action, idx) => {
                        if (action.type !== 'suggest_skill') return null;
                        const p = action.payload;
                        return (
                            <div key={`suggest-skill-${idx}`} className={styles.suggestSkillCard}>
                                <div className={styles.suggestSkillHeader}>
                                    <Sparkle24Regular style={{ color: tokens.colorBrandForeground1, flexShrink: 0 }} />
                                    <Text className={styles.suggestSkillTitle}>{p.title}</Text>
                                </div>
                                {p.description && (
                                    <Text className={styles.cardDescription}>{p.description}</Text>
                                )}
                                <div className={styles.cardActions}>
                                    <Button
                                        appearance="subtle"
                                        size="small"
                                        onClick={() => onActionResponse?.(p.actionId, 'dismiss')}
                                    >
                                        Maybe later
                                    </Button>
                                    <Button
                                        appearance="primary"
                                        size="small"
                                        onClick={() => onActionResponse?.(p.actionId, 'confirm')}
                                    >
                                        Get Started
                                    </Button>
                                </div>
                            </div>
                        );
                    })}

                    {/* Result Section (if available) */}
                    {execution.result && !execution.error && (
                        <div className={styles.section}>
                            <div className={styles.sectionTitle}>Result</div>
                            <div className={styles.codeBlock}>
                                {execution.result.length > 500
                                    ? `${execution.result.substring(0, 500)}...\n\n[Result truncated for display]`
                                    : execution.result
                                }
                            </div>
                        </div>
                    )}

                    {/* Error Section (if available) */}
                    {execution.error && (
                        <div className={styles.section}>
                            <div className={styles.sectionTitle}>Error</div>
                            <div className={styles.codeBlock} style={{ color: tokens.colorPaletteRedForeground1 }}>
                                {execution.error}
                            </div>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
}
